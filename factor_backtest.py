"""
요인 백테스트 (시기별) — 어떤 지표가 "이후 2년 상승률"을 꾸준히 맞혔나?  → data/model/factor_backtest.json

  기준 시점 T = 2017~2024년 매년 8월 말 (8개). 시점마다:
    · T 시점에 알 수 있던 값만으로 지표 계산 (가격 수준, 모멘텀, 전세가율, 회전율, 연식 …)
    · 이후 상승률 = T 직전 6개월 → T+2년 직전 6개월, "같은 평형끼리" 비교 (평형 섞임 왜곡 제거)
    · 순위상관(스피어만) 두 가지: 서울 전체 / 같은 구 안 (구 효과를 뺀 단지 고유 효과)
  모든 시점이 같은 2년을 재므로 시기끼리 공정하게 비교 가능 — 2019~21 외곽 강세기, 2022~23 하락기, 2024~ 양극화기를 나눠 본다.

사용법: python factor_backtest.py   (value_model.py 이후, 수동 실행 — 결과는 종합 등급 가중치 근거)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from fair_value import complex_features
from value_model import floor_adjust, load_trades

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "model"
CUTOFFS = [f"{y}-08-31" for y in range(2017, 2025)]
HORIZON = 2          # 년
MIN_N = 3            # 창(6개월)마다 거래 3건 이상인 단지만


def load_rent():
    cols = ["단지코드", "전용면적", "보증금", "월세", "계약일"]
    r = pd.concat([pd.read_csv(p, dtype=str, usecols=lambda c: c in cols, encoding="utf-8-sig")
                   for p in sorted((ROOT / "data" / "rent").glob("*.csv"))], ignore_index=True)
    r = r[r["월세"].fillna("0").str.strip() == "0"]                      # 전세만
    r["date"] = pd.to_datetime(r["계약일"], errors="coerce")
    r["jpa"] = pd.to_numeric(r["보증금"], errors="coerce") / pd.to_numeric(r["전용면적"], errors="coerce")
    return r.dropna(subset=["date", "jpa"])


def window(df, end, months=6):
    return df[(df["date"] > end - pd.DateOffset(months=months)) & (df["date"] <= end)]


def main():
    cxf = complex_features()
    cx_raw = pd.read_csv(ROOT / "data" / "complexes.csv", dtype=str, encoding="utf-8-sig").set_index("단지코드")
    df = load_trades()
    df, _, _ = floor_adjust(df, cx_raw)
    df["lp"] = np.log(df["ppa_std"])
    # 같은 단지·같은 평형대 평균을 뺀 잔차 → 창별 중앙값의 차이 = 평형 구성과 무관한 상승률
    df["res"] = df["lp"] - df.groupby(["단지코드", "band"], observed=True)["lp"].transform("mean")
    rent = load_rent()
    gu = cxf["gu"]
    end_all = df["date"].max()

    results = []
    for cut in CUTOFFS:
        T = pd.Timestamp(cut)
        T2 = T + pd.DateOffset(years=HORIZON)
        if T2 > end_all + pd.DateOffset(days=31):
            continue
        a, b = window(df, T), window(df, T2)
        ga, gb = a.groupby("단지코드"), b.groupby("단지코드")
        fwd = (gb["res"].median() - ga["res"].median())
        n_ok = (ga.size() >= MIN_N) & (gb.size().reindex(ga.size().index).fillna(0) >= MIN_N)
        fwd = fwd[n_ok.reindex(fwd.index).fillna(False)].dropna()

        lp_t = ga["lp"].median()
        prev = window(df, T - pd.DateOffset(months=12))
        mom = ga["res"].median() - prev.groupby("단지코드")["res"].median()
        jr = window(rent, T).groupby("단지코드")["jpa"].median() / np.exp(lp_t)
        hh = cxf["households"]
        turnover = window(df, T, 12).groupby("단지코드").size() / hh.where(hh > 0)
        age = T.year - a.groupby("단지코드")["by"].median()

        f = pd.DataFrame({
            "가격 수준(평당가)": lp_t,
            "업무지구 출근시간(짧을수록 +)": -cxf["commute"],
            "업무지구 직선거리(가까울수록 +)": -cxf["dist_cbd"],
            "단지 규모(세대수)": np.log(hh),
            "역까지 거리(가까울수록 +)": -cxf["dist_station"],
            "초등학교 거리(가까울수록 +)": -cxf["dist_elem"],
            "학원 수(1km)": cxf["academies"],
            "브랜드": cxf["brand"],
            "연식(새것일수록 +)": -age,
            "직전 1년 상승률(모멘텀)": mom,
            "전세가율": jr.where(jr < 1.2),
            "거래 회전율": turnover,
        }).reindex(fwd.index)
        g = gu.reindex(fwd.index)
        ic = {}
        for k in f:
            x = f[k]
            ok = x.notna()
            if ok.sum() < 100:
                continue
            seoul = x[ok].corr(fwd[ok], method="spearman")
            # 같은 구 안: 구별 순위로 바꾼 뒤 상관 (구 평균 효과 제거)
            xr = x[ok].groupby(g[ok]).rank(pct=True)
            yr = fwd[ok].groupby(g[ok]).rank(pct=True)
            within = xr.corr(yr, method="spearman")
            ic[k] = {"seoul": round(float(seoul), 3), "within_gu": round(float(within), 3), "n": int(ok.sum())}
        # 가격 수준 5분위별 2년 상승률 (상급지 vs 외곽이 어떻게 갈렸나)
        q = pd.qcut(lp_t.reindex(fwd.index), 5, labels=["가장 싼 20%", "2", "3", "4", "가장 비싼 20%"])
        by_q = (np.expm1(fwd.groupby(q, observed=True).mean()) * 100).round(1).to_dict()
        results.append({"cutoff": cut, "until": T2.date().isoformat(), "n": int(len(fwd)),
                        "avg_return_pct": round(float(np.expm1(fwd.mean()) * 100), 1),
                        "price_quintile_return_pct": by_q, "ic": ic})
        print(f"\n■ {cut} → {T2.date()} · 단지 {len(fwd):,}개 · 평균 {results[-1]['avg_return_pct']}%")
        print("  가격 5분위별 2년 상승률:", by_q)
        for k, v in ic.items():
            print(f"  {k:22s} 서울 {v['seoul']:+.2f}  구안 {v['within_gu']:+.2f}  (n={v['n']})")

    # 요약: 시점 평균·최소·부호 일관성 (몇 번 중 몇 번 같은 방향)
    keys = sorted({k for r in results for k in r["ic"]})
    summary = {}
    for k in keys:
        for s in ("seoul", "within_gu"):
            v = [r["ic"][k][s] for r in results if k in r["ic"]]
            summary.setdefault(k, {})[s] = {"mean": round(float(np.mean(v)), 3), "min": round(float(np.min(v)), 3),
                                            "max": round(float(np.max(v)), 3),
                                            "same_sign": int(max(sum(x > 0 for x in v), sum(x < 0 for x in v))), "count": len(v)}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "factor_backtest.json").write_text(json.dumps({"horizon_years": HORIZON, "periods": results, "summary": summary},
                                                         ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n=== 요약 (시점 평균 / 최소~최대 / 같은 방향 횟수) ===")
    for k, v in sorted(summary.items(), key=lambda kv: -abs(kv[1]["seoul"]["mean"])):
        s, w = v["seoul"], v["within_gu"]
        print(f"  {k:22s} 서울 {s['mean']:+.2f} [{s['min']:+.2f}~{s['max']:+.2f}] {s['same_sign']}/{s['count']}"
              f" | 구안 {w['mean']:+.2f} [{w['min']:+.2f}~{w['max']:+.2f}] {w['same_sign']}/{w['count']}")


if __name__ == "__main__":
    main()
