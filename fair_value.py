"""
② 적정가 모델 (LightGBM 헤도닉) — data/model/fair_value.csv, data/model/fair_value_meta.json

  - 학습: 정제된 거래(value_model.py와 같은 정제) × 단지 특성 → log(㎡당 가격)
  - 적정가: 그 단지의 법정동을 빼고 학습한 모델로 예측 (공간 교차검증의 검증 예측)
           → 모델이 그 단지 가격을 외워서 괴리율이 0이 되는 문제를 막음
  - 괴리율: (보정 시세 ÷ 적정가) − 1   (음수 = 저평가)
  - 가격 이유 TOP3: 전체 모델의 SHAP 기여도 (LightGBM 내장 pred_contrib)

사용법: python value_model.py && python fair_value.py
"""
import json
import re
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from value_model import PYEONG, floor_adjust, load_trades

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "model"
SINCE = "2019-01-01"     # 학습 기간 (시점 효과는 t 변수로 반영)
BRANDS = r"래미안|자이|힐스테이트|아이파크|푸르지오|롯데캐슬|e편한세상|이편한|더샵|디에이치|아크로|써밋|센트레빌|꿈에그린|위브|SK\s?VIEW|리센츠|트리지움|엘스|파크리오|헬리오"
BASE_FEATURES = ["log_area", "age", "floor_rel", "t", "households", "dist_station", "lines", "dist_elem",
                 "academies", "brand", "lat", "lng", "dist_cbd"]       # 백테스트용 (출근시간은 현재 노선망 기준이라 과거 시점엔 미래 정보)
FEATURES = BASE_FEATURES + ["commute"]
LABEL = {"log_area": "면적", "age": "연식", "households": "단지 규모", "dist_station": "역 접근성",
         "lines": "환승·노선", "dist_elem": "초등학교", "academies": "학원가", "brand": "브랜드",
         "lat": "위치", "lng": "위치", "dist_cbd": "업무지구 거리", "commute": "출근 시간"}
# 리포트 관점별 묶음 (설계서 A 교통 / B 학군 / C 단지 + 나머지 위치)
CATS = {"교통": ["dist_station", "lines", "commute", "dist_cbd"], "학군": ["dist_elem", "academies"],
        "단지": ["households", "age", "brand"], "위치": ["lat", "lng"]}
PARAMS = dict(objective="regression", learning_rate=0.05, num_leaves=63, min_data_in_leaf=50,
              feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, verbose=-1, seed=7)
ROUNDS = 600


def complex_features():
    cx = pd.read_csv(ROOT / "data" / "complexes.csv", dtype=str, encoding="utf-8-sig").set_index("단지코드")
    cx = cx[cx["위도"].notna() & (cx["위도"] != "")]
    num = lambda c: pd.to_numeric(cx.get(c), errors="coerce")
    names = cx["아파트명"].fillna("") + " " + cx["kapt단지명"].fillna("")
    f = pd.DataFrame({
        "households": num("세대수"), "dist_station": num("역거리m"), "lines": num("역세권노선수"),
        "dist_elem": num("초등학교m"), "academies": num("학원수1km"),
        "brand": names.str.contains(BRANDS, regex=True).astype(int),
        "lat": num("위도"), "lng": num("경도"), "dist_cbd": num("업무지구거리km"),
        "top_floor": num("최고층"), "dong": cx["법정동"], "gu": cx["구"],
    }, index=cx.index)
    vpath = OUT / "complex_value.csv"     # value_model.py가 만든 대중교통 출근 시간 (3대 업무지구 중 가장 빠른 곳)
    if vpath.exists():
        v = pd.read_csv(vpath, encoding="utf-8-sig").set_index("단지코드")
        cols = [c for c in ("출근_광화문", "출근_강남", "출근_여의도") if c in v]
        f["commute"] = v[cols].min(axis=1).reindex(f.index) if cols else np.nan
    else:
        f["commute"] = np.nan
    return f


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cxf = complex_features()
    cx_raw = pd.read_csv(ROOT / "data" / "complexes.csv", dtype=str, encoding="utf-8-sig").set_index("단지코드")

    df = load_trades()
    df, _, _ = floor_adjust(df, cx_raw)
    df = df[(df["date"] >= SINCE) & df["단지코드"].isin(cxf.index)].copy()
    df = df.join(cxf, on="단지코드")
    top = df["top_floor"].fillna(df.groupby("단지코드")["floor"].transform("max"))
    df["floor_rel"] = (df["floor"] / top).clip(0, 1.2)
    df["age"] = df["date"].dt.year - df["by"]
    df["t"] = (df["date"].dt.year - 2015) * 12 + df["date"].dt.month
    df["log_area"] = np.log(df["area"])
    y = np.log(df["ppa"])
    X = df[FEATURES]
    groups = df["dong"].fillna(df["법정동"])
    print(f"② 학습 데이터: 거래 {len(df):,}건 / 단지 {df['단지코드'].nunique():,}개 / 법정동 {groups.nunique():,}개")

    # 단지별 기준 조건: 최근 3년 거래 면적의 중앙값, 중층(0.5), 최신 시점
    tmax = int(df["t"].max())
    recent = df[df["date"] >= df["date"].max() - pd.DateOffset(years=3)]
    ref = pd.DataFrame({"log_area": recent.groupby("단지코드")["log_area"].median()}).join(cxf)
    ref["age"] = df["date"].max().year - df.groupby("단지코드")["by"].median().reindex(ref.index)
    ref["floor_rel"], ref["t"] = 0.5, tmax
    ref = ref.dropna(subset=["log_area"])

    # 공간 교차검증: 같은 법정동이 학습과 검증에 동시에 들어가지 않게
    # 1년 전 시점 기준 조건 (시점 t만 12개월 앞, 연식 1년 적게) → "최근 1년 사이 괴리 변화"
    refp = ref.copy()
    refp["t"], refp["age"] = tmax - 12, ref["age"] - 1
    oof = np.full(len(df), np.nan)
    ref_oof = pd.Series(np.nan, index=ref.index)
    refp_oof = pd.Series(np.nan, index=ref.index)
    for k, (tr_i, va_i) in enumerate(GroupKFold(5).split(X, y, groups=groups)):
        m = lgb.train(PARAMS, lgb.Dataset(X.iloc[tr_i], y.iloc[tr_i]), ROUNDS)
        oof[va_i] = m.predict(X.iloc[va_i])
        held = set(groups.iloc[va_i])
        sel = ref["dong"].isin(held)
        ref_oof[sel] = m.predict(ref.loc[sel, FEATURES])
        refp_oof[sel] = m.predict(refp.loc[sel, FEATURES])
        print(f"   fold {k + 1}/5 완료")
    mape = float(np.mean(np.abs(np.expm1(oof - y))))
    rec = df["date"] >= df["date"].max() - pd.DateOffset(years=1)
    mape_recent = float(np.mean(np.abs(np.expm1(oof[rec.values] - y[rec]))))
    print(f"   공간 CV 오차(MAPE): 전체 {mape:.1%} / 최근 1년 {mape_recent:.1%}")

    # 전체 모델 → 가격 이유(SHAP) · 지표 가중치
    model = lgb.train(PARAMS, lgb.Dataset(X, y), ROUNDS)
    contrib = model.predict(ref[FEATURES], pred_contrib=True)              # 마지막 열 = 기준값(평균)
    sv = pd.DataFrame(contrib[:, :-1], columns=FEATURES, index=ref.index)
    cat = pd.DataFrame({c: sv[cols].sum(axis=1) for c, cols in CATS.items()})   # 관점별 log 기여
    sv = sv.drop(columns=["t", "floor_rel"]).T.groupby(lambda f: LABEL.get(f, f)).sum().T
    reasons = sv.apply(lambda r: "|".join(
        f"{k} {'+' if v > 0 else '−'}{abs(np.expm1(v)) * 100:.0f}%"
        for k, v in r.reindex(r.abs().sort_values(ascending=False).index)[:3].items()), axis=1)
    w = sv.abs().mean()
    weights = (w / w.sum()).round(3).sort_values(ascending=False).to_dict()

    # 괴리율: 보정 시세(value_model.py) ÷ 적정가 − 1
    val = pd.read_csv(OUT / "complex_value.csv", encoding="utf-8-sig").set_index("단지코드")
    lp_shrunk = np.log(val["보정평당가"] / PYEONG).reindex(ref.index)
    glog = lp_shrunk - ref_oof
    gap = np.exp(glog) - 1
    # 1년 전 괴리: 12~18개월 전 거래 중앙값(표준층 환산) vs 그 시점 적정가
    pw = df[(df["date"] > df["date"].max() - pd.DateOffset(months=18)) & (df["date"] <= df["date"].max() - pd.DateOffset(months=12))]
    pstat = pw.groupby("단지코드")["lp"].agg(["median", "size"])
    lp_prev = pstat["median"].where(pstat["size"] >= 2).reindex(ref.index)
    dgap = glog - (lp_prev - refp_oof)
    # 구별 모델 오차(단지 단위: 보정 시세 vs 적정가, log) → 괴리 z점수 = 괴리 ÷ 그 지역 오차
    #   (거래 단위로 재면 층·면적 차이까지 오차에 섞여 과대평가됨)
    rmse_gu = glog.pow(2).groupby(ref["gu"]).mean().pow(0.5)
    rmse = ref["gu"].map(rmse_gu)
    z = glog / rmse
    verdict = pd.cut(z, [-np.inf, -1.0, -0.5, 0.5, 1.0, np.inf], labels=["저평가", "다소 저평가", "적정", "다소 고평가", "고평가"]).astype(str)
    # 백테스트: 계속 싸던 단지(오래된 저평가)는 이후 덜 올랐음 → 따로 표시
    cheap = verdict.isin(["저평가", "다소 저평가"])
    verdict = verdict.where(~(cheap & (dgap > -0.02)), verdict + "(장기)").where(~(cheap & (dgap <= -0.05)), verdict + "(최근)")
    n6 = val["최근6개월거래"].reindex(ref.index)
    conf = np.select([(n6 >= 5) & (rmse < 0.30), n6 >= 2], ["높음", "보통"], default="낮음")
    pct_in_gu = cat.groupby(ref["gu"]).rank(pct=True)          # 관점별 구 안 백분위
    out = pd.DataFrame({
        "단지코드": ref.index,
        "적정평당가": (np.exp(ref_oof) * PYEONG).round(0),
        "괴리율": (gap * 100).round(1),
        "괴리z": z.round(2), "괴리변화": (dgap * 100).round(1), "판정": verdict.where(z.notna()),
        "판정신뢰도": pd.Series(conf, index=ref.index), "지역오차": (rmse * 100).round(1),
        "가격이유": reasons.reindex(ref.index),
        **{f"기여_{c}": (np.expm1(cat[c]) * 100).round(1) for c in CATS},
        **{f"구순위_{c}": (pct_in_gu[c] * 100).round(0) for c in CATS},
    }).dropna(subset=["적정평당가"])
    out.to_csv(OUT / "fair_value.csv", index=False, encoding="utf-8-sig")
    meta = {"trades": len(df), "complexes": int(df["단지코드"].nunique()), "mape": round(mape, 4),
            "mape_recent": round(mape_recent, 4), "weights": weights, "since": SINCE}
    (OUT / "fair_value_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    g = out["괴리율"].dropna()
    print(f"   적정가 {len(out):,}개 단지 / 괴리율 중앙값 {g.median():.1f}% (25~75%: {g.quantile(.25):.1f} ~ {g.quantile(.75):.1f}%)")
    print("   지표 가중치:", weights)


if __name__ == "__main__":
    main()
