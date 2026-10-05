"""
백테스트 — 과거 시점의 '적정가 괴리율'이 이후 실제 상승률을 설명했는가?  → data/model/backtest.json

  기준 시점 T마다:
    1) T 이전 거래만으로 적정가 모델 학습 (법정동 단위 공간 교차검증 예측 = 외우기 방지)
    2) T 직전 6개월 단지 시세 vs 적정가 → 괴리율
    3) T 이후 실제 상승률 = (최근 6개월 시세) − (T 직전 6개월 시세)
    4) 순위상관(스피어만): 음수면 "저평가일수록 이후 더 올랐다"
       + 괴리율 5분위별 평균 상승률

사용법: python backtest.py   (fair_value.py와 같은 특성 사용)
"""
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from fair_value import FEATURES, PARAMS, complex_features
from value_model import floor_adjust, load_trades

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "model"
CUTOFFS = ["2022-08-31", "2023-08-31", "2024-08-31"]
ROUNDS = 400


def main():
    cxf = complex_features()
    cx_raw = pd.read_csv(ROOT / "data" / "complexes.csv", dtype=str, encoding="utf-8-sig").set_index("단지코드")
    df = load_trades()
    df, _, _ = floor_adjust(df, cx_raw)
    df = df[df["단지코드"].isin(cxf.index)].join(cxf, on="단지코드")
    top = df["top_floor"].fillna(df.groupby("단지코드")["floor"].transform("max"))
    df["floor_rel"] = (df["floor"] / top).clip(0, 1.2)
    df["age"] = df["date"].dt.year - df["by"]
    df["t"] = (df["date"].dt.year - 2015) * 12 + df["date"].dt.month
    df["log_area"] = np.log(df["area"])
    df["y"] = np.log(df["ppa"])
    end = df["date"].max()
    now_lp = df[df["date"] > end - pd.DateOffset(months=6)].groupby("단지코드")["lp"].median()

    results = []
    for cut in CUTOFFS:
        T = pd.Timestamp(cut)
        tr = df[(df["date"] <= T) & (df["date"] > T - pd.DateOffset(years=4))]
        groups = tr["dong"]
        base = tr[tr["date"] > T - pd.DateOffset(months=6)]
        lp_t = base.groupby("단지코드")["lp"].median()
        n_t = base.groupby("단지코드").size()
        ref = pd.DataFrame({"log_area": base.groupby("단지코드")["log_area"].median()}).join(cxf)
        ref["age"] = T.year - tr.groupby("단지코드")["by"].median().reindex(ref.index)
        ref["floor_rel"], ref["t"] = 0.5, int(tr["t"].max())
        pred = pd.Series(np.nan, index=ref.index)
        for tr_i, va_i in GroupKFold(5).split(tr, groups=groups):
            m = lgb.train(PARAMS, lgb.Dataset(tr[FEATURES].iloc[tr_i], tr["y"].iloc[tr_i]), ROUNDS)
            sel = ref["dong"].isin(set(groups.iloc[va_i]))
            pred[sel] = m.predict(ref.loc[sel, FEATURES])
        d = pd.DataFrame({"gap": lp_t - pred, "fwd": now_lp - lp_t, "n": n_t}).dropna()
        d = d[d["n"] >= 3]                                   # 기준 시점 시세가 3건 이상인 단지만
        rho = d[["gap", "fwd"]].corr(method="spearman").iloc[0, 1]

        # 다른 요인들도 같은 기준으로: T 시점에 알 수 있던 값 → 이후 상승률과 순위상관
        prev = tr[(tr["date"] > T - pd.DateOffset(months=18)) & (tr["date"] <= T - pd.DateOffset(months=12))]
        f = pd.DataFrame({
            "적정가 괴리율": d["gap"],
            "직전 1년 상승률(모멘텀)": lp_t - prev.groupby("단지코드")["lp"].median(),
            "가격 수준(평당가)": lp_t,
            "단지 규모(세대수)": cxf["households"],
            "역까지 거리": cxf["dist_station"],
            "연식(오래될수록 +)": ref["age"],
            "브랜드": cxf["brand"],
            "업무지구 거리": cxf["dist_cbd"],
        }).reindex(d.index)
        factors = {k: round(float(f[k].corr(d["fwd"], method="spearman")), 3) for k in f}
        d["q"] = pd.qcut(d["gap"], 5, labels=["저평가 20%", "하위 20~40%", "중간", "상위 20~40%", "고평가 20%"])
        by_q = (np.expm1(d.groupby("q", observed=True)["fwd"].mean()) * 100).round(1).to_dict()
        years = round((end - T).days / 365, 1)
        results.append({"cutoff": cut, "years": years, "n": len(d), "spearman": round(float(rho), 3),
                        "quintile_return_pct": by_q, "factors": factors})
        print(f"기준 {cut} → 이후 {years}년, 단지 {len(d):,}개 | 괴리율 순위상관 {rho:+.3f} | 분위별 상승률 {by_q}")
        print("   요인별 순위상관:", factors)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "backtest.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
