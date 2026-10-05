"""
가치 산정 모델 — data/model/complex_value.csv  (가이드 문서 ①·④, ③은 임시판)

  ① 실거래 정제: 해제·직거래 제외 → 층 보정(표준층 환산) → 이상치 제거 → 베이즈 축소 시세 + 신뢰도
  ③ 고용 접근성(임시): 업무지구 7곳 중력모형 — 직선거리 기반, 실제 통행시간 행렬로 교체 예정
  ④ 하락 방어력: 2021~23 낙폭(MDD) · 지역 베타 · 전세가율 · 입주물량 · 거래회전율 → 0~100점, A~D 등급

사용법: python value_model.py   (build_site.py 전에 실행 — 배포 워크플로가 자동 실행)
"""
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "model"
PYEONG = 3.305785
K_PRICE = 5      # 시세 베이즈 축소 강도 (거래 n건 vs 동·연식대 기준값 K건 몫)
K_INDEX = 3      # 분기 지수 축소 강도
HUBS = [         # 업무지구 (이름, 위도, 경도, 일자리 가중치 — ⚠️ 임시값, 전국사업체조사 종사자 수로 교체 예정)
    ("광화문·종로", 37.5759, 126.9768, 1.00), ("강남", 37.4979, 127.0276, 1.00),
    ("여의도", 37.5216, 126.9243, 0.60), ("판교", 37.3948, 127.1112, 0.45),
    ("마곡", 37.5602, 126.8254, 0.25), ("성수", 37.5446, 127.0559, 0.25), ("가산·구로", 37.4816, 126.8826, 0.35),
]


def load_trades():
    cols = ["구", "시군구코드", "법정동", "단지코드", "전용면적", "층", "건축년도", "거래금액", "계약일", "해제여부", "거래유형"]
    df = pd.concat([pd.read_csv(p, dtype=str, usecols=lambda c: c in cols, encoding="utf-8-sig")
                    for p in sorted((ROOT / "data" / "trades").glob("*.csv"))], ignore_index=True)
    df = df[df["단지코드"].notna()]
    df = df[df["해제여부"].fillna("").str.strip() != "O"]                 # (1) 해제 거래 제외
    df = df[df["거래유형"].fillna("") != "직거래"]                        # (2) 직거래 제외 (특수관계 저가 거래)
    df["price"] = pd.to_numeric(df["거래금액"], errors="coerce")
    df["area"] = pd.to_numeric(df["전용면적"], errors="coerce")
    df["floor"] = pd.to_numeric(df["층"], errors="coerce")
    df["by"] = pd.to_numeric(df["건축년도"], errors="coerce")
    df["date"] = pd.to_datetime(df["계약일"], errors="coerce")
    df = df.dropna(subset=["price", "area", "date"])
    df = df[(df["area"] > 10) & (df["price"] > 0)]
    df["q"] = df["date"].dt.to_period("Q")
    df["ppa"] = df["price"] / df["area"]                                  # 만원/㎡ (전용)
    df["band"] = pd.cut(df["area"], [0, 50, 70, 90, 120, 1e9], labels=["~50", "50-70", "70-90", "90-120", "120~"])
    return df


def floor_adjust(df, cx):
    """(3) 층 보정: 단지 내 상대층 → 저/중/고층, 구별 계수로 중층 기준 '표준층 단가' 환산"""
    top = pd.to_numeric(df["단지코드"].map(cx["최고층"]) if "최고층" in cx else None, errors="coerce")
    top = top.fillna(df.groupby("단지코드")["floor"].transform("max"))
    rel = df["floor"] / top
    df["fband"] = np.select([(df["floor"] <= 3) | (rel <= 0.2), rel >= 0.8], ["low", "high"], "mid")
    grp = ["단지코드", "band", "q"]
    ratio = df["ppa"] / df.groupby(grp, observed=True)["ppa"].transform("median")
    coef = ratio.groupby([df["시군구코드"], df["fband"]]).median().unstack()
    coef = coef.div(coef["mid"], axis=0)                                  # 중층 = 1.0
    lookup = coef.stack().to_dict()
    df["fcoef"] = [lookup.get((g, b), 1.0) for g, b in zip(df["시군구코드"], df["fband"])]
    df["ppa_std"] = df["ppa"] / df["fcoef"]

    # (4) 이상치: 단지×면적대×분기 안에서 로버스트 Z > 3 (표본 5건 이상일 때만)
    lp = np.log(df["ppa_std"])
    keys = [df[c] for c in grp]
    med = lp.groupby(keys, observed=True).transform("median")
    mad = (lp - med).abs().groupby(keys, observed=True).transform("median")
    n = lp.groupby(keys, observed=True).transform("size")
    rz = (lp - med) / (1.4826 * mad.replace(0, np.nan))
    removed = int(((n >= 5) & (rz.abs() > 3)).sum())
    df = df[~((n >= 5) & (rz.abs() > 3))].copy()
    df["lp"] = np.log(df["ppa_std"])
    return df, coef, removed


def shrunk_price(df):
    """(5) 베이즈 축소: 거래 적은 단지는 같은 동·같은 연식대 시세 쪽으로 당겨서 안정화"""
    recent = df[df["date"] >= df["date"].max() - pd.DateOffset(months=6)].copy()
    # 단지별 대표 속성 (1·2차가 한 단지코드로 묶여 건축년도가 여러 개인 경우 대비)
    attr = recent.groupby("단지코드").agg(구=("구", "first"), 법정동=("법정동", "first"), by=("by", "median"))
    attr["age_band"] = ((df["date"].max().year - attr["by"]) // 10).fillna(-1)
    recent = recent.join(attr[["age_band"]], on="단지코드")
    prior = recent.groupby(["법정동", "age_band"])["lp"].median().rename("mu")
    gu_prior = recent.groupby("구")["lp"].median()
    cx = (recent.groupby("단지코드")["lp"].agg(n="size", x="median").join(attr).reset_index()
          .merge(prior, on=["법정동", "age_band"], how="left"))
    cx["mu"] = cx["mu"].fillna(cx["구"].map(gu_prior))
    cx["lp_shrunk"] = (cx["n"] * cx["x"] + K_PRICE * cx["mu"]) / (cx["n"] + K_PRICE)
    cx["confidence"] = pd.cut(cx["n"], [0, 2, 9, 1e9], labels=["low", "mid", "high"]).astype(str)
    return cx.set_index("단지코드")[["n", "lp_shrunk", "confidence"]]


def quarter_index(df):
    """단지 분기 지수 (구 분기 중위값 쪽으로 K=3 축소)"""
    g = df.groupby(["단지코드", "시군구코드", "q"])["lp"].agg(n="size", x="median").reset_index()
    gu = df.groupby(["시군구코드", "q"])["lp"].median().rename("mu").reset_index()
    g = g.merge(gu, on=["시군구코드", "q"])
    g["idx"] = (g["n"] * g["x"] + K_INDEX * g["mu"]) / (g["n"] + K_INDEX)
    return g


def mdd_beta(g):
    peak_w = (g["q"] >= pd.Period("2021Q1")) & (g["q"] <= pd.Period("2022Q2"))
    trough_w = (g["q"] >= pd.Period("2022Q3")) & (g["q"] <= pd.Period("2023Q4"))
    peak = g[peak_w].groupby("단지코드")["idx"].max()
    trough = g[trough_w].groupby("단지코드")["idx"].min()
    mdd = (np.exp(trough - peak) - 1).abs()
    # 고점·저점 구간 거래가 각 2건 미만이면 우연한 값일 수 있어 버림 (→ 구·연식대 평균으로 추정)
    enough = (g[peak_w].groupby("단지코드")["n"].sum() >= 2) & (g[trough_w].groupby("단지코드")["n"].sum() >= 2)
    mdd = mdd[enough.reindex(mdd.index, fill_value=False)]

    g = g.sort_values(["단지코드", "q"])
    g["da"] = g.groupby("단지코드")["idx"].diff()
    g["dm"] = g.groupby("단지코드")["mu"].diff()
    ok = g.dropna(subset=["da", "dm"])

    def beta(s):
        if len(s) < 8 or s["dm"].var() == 0:
            return 1.0                                                     # 데이터 부족 → 시장 평균
        b = np.cov(s["da"], s["dm"])[0, 1] / s["dm"].var()
        return (len(s) * b + 8 * 1.0) / (len(s) + 8)                       # 1.0 쪽으로 축소
    betas = ok.groupby("단지코드")[["da", "dm"]].apply(beta)
    return mdd, betas


def jeonse_ratio(sale):
    paths = sorted((ROOT / "data" / "rent").glob("*.csv"))
    if not paths:
        return pd.Series(dtype=float)
    rent = pd.concat([pd.read_csv(p, dtype=str, encoding="utf-8-sig") for p in paths[-8:]], ignore_index=True)
    rent = rent[(rent["월세"] == "0") & (rent["계약구분"].fillna("") != "갱신")]
    rent["date"] = pd.to_datetime(rent["계약일"], errors="coerce")
    rent = rent[rent["date"] >= rent["date"].max() - pd.DateOffset(months=6)]
    dep = pd.to_numeric(rent["보증금"], errors="coerce") / pd.to_numeric(rent["전용면적"], errors="coerce")
    j = dep.groupby(rent["단지코드"]).median()
    return (j / sale).dropna()


def gu_supply_ratio(cx):
    """구별 2년 내 입주예정(일반분양) 세대 ÷ 구 총 세대"""
    path = ROOT / "data" / "subscription.csv"
    if not path.exists():
        return pd.Series(dtype=float)
    s = pd.read_csv(path, dtype=str, encoding="utf-8-sig")
    now = date.today().strftime("%Y%m")
    end = f"{date.today().year + 2}{date.today().strftime('%m')}"
    s = s[(s["구분"] == "APT") & (s["입주예정월"] >= now) & (s["입주예정월"] <= end)]
    sup = pd.to_numeric(s["공급세대수"], errors="coerce").groupby(s["구"]).sum()
    hh = pd.to_numeric(cx["세대수"], errors="coerce")
    total = hh.groupby(cx["구"]).sum()
    known = hh.notna().groupby(cx["구"]).sum()
    total = total[known >= 30]          # 세대수를 아는 단지가 30개 미만인 구는 비율이 왜곡되므로 제외 (단지정보 수집 후 자동 반영)
    return (sup.reindex(total.index).fillna(0) / total).replace([np.inf, -np.inf], np.nan)


def access_index(cx):
    """③ 임시 고용 접근성: A = Σ 일자리가중치 × exp(-β × 거리km) — β는 시세와 순위상관 최대값으로 보정"""
    la, lo = pd.to_numeric(cx["위도"], errors="coerce"), pd.to_numeric(cx["경도"], errors="coerce")
    d = {}
    for name, hla, hlo, _ in HUBS:
        dy, dx = (la - hla) * 111.0, (lo - hlo) * 88.2                    # 서울 위도에서 1° ≈ 111km / 88km
        d[name] = np.sqrt(dy ** 2 + dx ** 2)
    d = pd.DataFrame(d)
    w = pd.Series({h[0]: h[3] for h in HUBS})
    return d, lambda beta: (np.exp(-beta * d) * w).sum(axis=1)


def pct(s):
    return s.rank(pct=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cx = pd.read_csv(ROOT / "data" / "complexes.csv", dtype=str, encoding="utf-8-sig").set_index("단지코드")

    df = load_trades()
    n0 = len(df)
    df, coef, removed = floor_adjust(df, cx)
    price = shrunk_price(df)
    print(f"① 정제: {n0:,}건 → 이상치 {removed:,}건 제거 → {len(df):,}건 / 보정 시세 단지 {len(price):,}개")
    print("   층 계수(서울 중앙값):", {k: round(float(v), 3) for k, v in coef.median().items()})

    # ③ 임시 접근성
    dist, acc = access_index(cx)
    target = price["lp_shrunk"].reindex(cx.index)
    best, best_r = 0.1, -1
    for b in np.arange(0.05, 0.55, 0.05):
        r = pd.concat([acc(b), target], axis=1).corr(method="spearman").iloc[0, 1]
        if r > best_r:
            best, best_r = b, r
    access = (pct(acc(best)) * 100).round(1).where(dist.notna().all(axis=1))
    print(f"③ 접근성(임시): β={best:.2f}, 시세와 순위상관 {best_r:.2f}")

    # ④ 하락 방어력
    g = quarter_index(df)
    mdd, beta = mdd_beta(g)
    sale = df[df["date"] >= df["date"].max() - pd.DateOffset(months=6)].groupby("단지코드")["ppa_std"].median()
    risk = pd.DataFrame({"mdd": mdd, "beta": beta}).reindex(price.index)
    risk["jeonse_ratio"] = jeonse_ratio(sale)
    supply = gu_supply_ratio(cx.reset_index())
    gu = df.groupby("단지코드")["구"].first().reindex(risk.index)
    risk["supply"] = gu.map(supply)
    hh = pd.to_numeric(cx["세대수"], errors="coerce").reindex(risk.index)
    last12 = df[df["date"] >= df["date"].max() - pd.DateOffset(months=12)].groupby("단지코드").size()
    risk["turnover"] = (last12.reindex(risk.index) / hh).where(hh > 0)

    # 2022년 이후 준공 등 MDD 없는 단지 → 같은 구·같은 연식대 평균으로 대체, 신뢰도 낮음 표시
    age_band = (df.groupby("단지코드")["by"].first() // 10).reindex(risk.index)
    risk["mdd_est"] = risk["mdd"].isna()
    risk["mdd"] = risk["mdd"].fillna(risk.groupby([gu, age_band])["mdd"].transform("median")).fillna(risk["mdd"].median())

    r = (0.35 * pct(risk["mdd"])
         + 0.15 * pct(risk["beta"].fillna(1.0))
         + 0.20 * (1 - pct(risk["jeonse_ratio"].clip(upper=0.7).fillna(risk["jeonse_ratio"].median())))
         + 0.15 * pct(risk["supply"].fillna(0))
         + 0.15 * (1 - pct(risk["turnover"].fillna(risk["turnover"].median()))))
    risk["defense"] = ((1 - pct(r)) * 100).round(1)                       # 높을수록 방어력 강함
    risk["grade"] = pd.qcut(risk["defense"], 4, labels=["D", "C", "B", "A"]).astype(str)
    risk["jeonse_warn"] = risk["jeonse_ratio"] > 0.8                      # 깡통전세 위험
    cycle = df[(df["date"] >= "2021-01-01") & (df["date"] < "2024-01-01")].groupby("단지코드").size()
    risk["thin"] = cycle.reindex(risk.index).fillna(0) < 10               # 2021~23 거래 10건 미만 = 판정 표본 적음

    out = pd.DataFrame({
        "단지코드": price.index,
        "보정평당가": (np.exp(price["lp_shrunk"]) * PYEONG).round(0),
        "시세신뢰도": price["confidence"], "최근6개월거래": price["n"],
        "접근성": access.reindex(price.index),
        "낙폭2022": (risk["mdd"] * 100).round(1), "낙폭추정": risk["mdd_est"],
        "지역베타": risk["beta"].round(2), "전세가율": (risk["jeonse_ratio"] * 100).round(0),
        "구입주물량비율": (risk["supply"] * 100).round(2), "거래회전율": (risk["turnover"] * 100).round(1),
        "방어력": risk["defense"], "방어등급": risk["grade"], "전세경고": risk["jeonse_warn"],
        "표본적음": risk["thin"] | risk["mdd_est"],
    })
    out.to_csv(OUT / "complex_value.csv", index=False, encoding="utf-8-sig")
    print(f"④ 방어력: {len(out):,}개 단지 / 등급 분포 {out['방어등급'].value_counts().to_dict()} / "
          f"MDD 추정 {int(risk['mdd_est'].sum()):,}개")


if __name__ == "__main__":
    main()
