"""
웹앱용 데이터 만들기 — site/data/

  site/data/complexes.json   단지 요약 (목록·지도·필터용, 앱 첫 화면에서 한 번 로딩)
  site/data/c/{단지코드}.json  단지 상세 (평형별 매매·전세 월별 시세, 거래량, 주변 단지, 최근 거래)
  site/data/supply.json      입주 예정 물량 (data/supply.csv가 있을 때)

사용법: python build_site.py
"""
import csv
import json
import math
import re
import shutil
import statistics
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "site" / "data"
PYEONG = 3.305785  # 1평 = 3.3058㎡
NEIGHBOR_KM = 1.5  # 키맞추기 비교 반경


def read_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def months_before(d, n):
    y, m = d.year, d.month - n
    while m <= 0:
        y, m = y - 1, m + 12
    return date(y, m, 1)


def area_band(a):
    """전용면적 → 평형대 (59, 84 등 대표 구간)"""
    for lo, hi, name in [(0, 40, "40미만"), (40, 50, "40대"), (50, 66, "59"), (66, 76, "70대"),
                         (76, 95, "84"), (95, 115, "100대"), (115, 140, "120대")]:
        if lo <= a < hi:
            return name
    return "140이상"


def median(xs):
    return round(statistics.median(xs)) if xs else None


def change(now, before):
    return round((now / before - 1) * 100, 1) if now and before else None


def km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def display_name(name, dong, kapt):
    """실거래 신고명("미륭", "현대")은 너무 짧아 구분이 안 됨 → 흔히 부르는 이름("월계미륭", "무악현대")으로"""
    name = (name or "").strip()
    if not name or re.fullmatch(r"[\d\-()\s.]+", name):      # "(1-10)" 처럼 번지만 있는 신고명
        return f"{dong} {name.strip('()')} 아파트".replace("  ", " ")
    if len(name) > 4:
        return name
    k = re.sub(r"\(.*?\)|아파트$", "", kapt or "").strip()
    if k and name and name in k and len(k) <= 12:
        return k
    stem = re.sub(r"(본동|\d*동(\d+가)?|\d+가)$", "", dong or "")   # 월계동→월계, 금호동3가→금호, 용산동2가→용산
    return stem + name if stem and not name.startswith(stem) else name


COMMUTE_HUBS = ["광화문", "강남", "여의도", "판교", "마곡", "성수", "가산·구로"]   # commute.HUBS 순서 (웹앱과 동일)


def value_fields(v):
    """value_model.py 결과 → 웹용 짧은 키"""
    if not v:
        return {}
    f = lambda k: float(v[k]) if v.get(k) not in (None, "", "nan") else None
    return {
        "vp": f("보정평당가"), "cf": v.get("시세신뢰도") or None,            # 정제·보정 평당가, 신뢰도
        "ac": f("접근성"),                                                  # 출근 접근성(임시) 0~100
        "dd": f("낙폭2022"), "de": v.get("낙폭추정") == "True",             # 2022 하락기 낙폭 %(평형 고정), 추정 여부
        "rc": f("회복률"),                                                  # 2024년 이후 최고가 ÷ 2021~22 고점 %
        # 국면별 성적표: [상승률 %, 서울 백분위] — 상승기(19.8→21.8)·하락기(21.8→23.8)·회복기(23.8→현재)·누적(19.8→현재)
        "rg": [[f(f"{k}상승률"), f(f"{k}백분위")] if f(f"{k}상승률") is not None else None for k in ("상승기", "하락기", "회복기", "누적")]
              if any(f(f"{k}상승률") is not None for k in ("상승기", "하락기", "회복기", "누적")) else None,
        "ty": v.get("성격") if v.get("성격") not in (None, "", "nan") else None,    # 전천후형·방어형·탄력형·약세형·평균형
        "lq": f("유동성백분위"),                                            # 거래 유동성 서울 백분위
        "bt": f("지역베타"), "jr2": f("전세가율"), "su": f("구입주물량비율"), "to": f("거래회전율"),
        "df": f("방어력"), "dg": v.get("방어등급") if v.get("방어등급") not in ("", "nan") else None,
        "jw": v.get("전세경고") == "True", "th": v.get("표본적음") == "True",
        "ct": [int(f(f"출근_{h}")) if f(f"출근_{h}") is not None else None for h in COMMUTE_HUBS]
              if f(f"출근_{COMMUTE_HUBS[0]}") is not None else None,              # 업무지구별 대중교통 출근 분
        "fv": f("적정평당가"), "gp": f("괴리율"),                                # ② 모델 적정가, 괴리율 %
        "rs": v["가격이유"].split("|") if v.get("가격이유") else None,          # 가격 이유 TOP3
        # 리포트: 판정·z점수·1년 괴리 변화·신뢰도·지역 오차
        "vd": v.get("판정") if v.get("판정") not in (None, "", "nan") else None,
        "gz": f("괴리z"), "gd": f("괴리변화"), "vc": v.get("판정신뢰도") or None, "re": f("지역오차"),
        # 관점별 [가격 기여 %, 구 안 백분위]
        "cat": {c: [f(f"기여_{c}"), f(f"구순위_{c}")] for c in ("교통", "학군", "단지", "위치")}
               if f("기여_교통") is not None else None,
        # 미래 가치: 개통 예정 역
        "fs": f("신규역점수"), "fsn": v.get("신규역") or None, "fsd": f("신규역거리m"),
    }


# ---- 같은 단지가 지번별로 쪼개져 여러 개로 보이는 것 합치기 ----
# 실거래 자료는 지번마다 단지를 따로 만든다: "e편한세상서울대입구1단지·2단지(같은 K-apt 단지)", "○○(임대)"(같은 지번의 임대동) 등
def base_name(n):
    n = re.sub(r"\(.*?\)", "", n or "")
    n = re.sub(r"\d+\s*단지$", "", n.strip())
    n = re.sub(r"(아파트|APT)$", "", n.strip(), flags=re.I)
    return n.replace(" ", "").lower()


def merge_groups(info, n_trades):
    """같은 단지로 볼 묶음 → {보조 코드: 대표 코드}. 보수적으로: 이름 뿌리가 같고 가까운 경우만."""
    rows = []
    for c, r in info.items():
        try:
            rows.append((c, r, float(r["위도"]), float(r["경도"])))
        except (TypeError, ValueError, KeyError):
            continue
    parent = {c: c for c, *_ in rows}

    def find(c):
        while parent[c] != c:
            parent[c] = parent[parent[c]]
            c = parent[c]
        return c

    by_gu = defaultdict(list)
    for x in rows:
        by_gu[x[1]["구"]].append(x)
    for xs in by_gu.values():
        for i in range(len(xs)):
            ca, ra, la, lo = xs[i]
            ba, ya, ia = base_name(ra["아파트명"]), int(ra.get("건축년도") or 0), "임대" in ra["아파트명"]
            for j in range(i + 1, len(xs)):
                cb, rb, lb, lob = xs[j]
                if abs(la - lb) > 0.006 or abs(lo - lob) > 0.007:
                    continue
                bb, yb, ib = base_name(rb["아파트명"]), int(rb.get("건축년도") or 0), "임대" in rb["아파트명"]
                if not ba or ba != bb or abs(ya - yb) > 2:
                    continue
                d = km((la, lo), (lb, lob))
                same_kapt = ra.get("kaptCode") and ra.get("kaptCode") == rb.get("kaptCode")
                same_lot = ra["법정동"] == rb["법정동"] and ra["지번"] == rb["지번"]
                if (same_kapt and d <= 0.6) or same_lot or (ia != ib and ra["법정동"] == rb["법정동"] and d <= 0.5):
                    parent[find(ca)] = find(cb)
    groups = defaultdict(list)
    for c, *_ in rows:
        groups[find(c)].append(c)
    alias = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        # 대표: 임대 아닌 것 중 매매 거래가 가장 많은 단지
        lead = max(members, key=lambda c: ("임대" not in info[c]["아파트명"], n_trades.get(c, 0)))
        for c in members:
            if c != lead:
                alias[c] = lead
    return alias


def load_trades():
    out = []
    for path in sorted((ROOT / "data" / "trades").glob("*.csv")):
        for r in read_csv(path):
            if r["해제여부"] == "O" or not r["단지코드"]:
                continue
            area, price = float(r["전용면적"]), int(r["거래금액"])
            out.append({"code": r["단지코드"], "date": r["계약일"], "area": area, "band": area_band(area),
                        "floor": int(r["층"] or 0), "price": price, "ppp": price / area * PYEONG})
    return out


def load_jeonse():
    """전세만 (월세 0). 갱신계약은 5% 상한 때문에 시세보다 낮아서 제외 (계약구분이 없는 옛 자료는 포함)"""
    out = []
    for path in sorted((ROOT / "data" / "rent").glob("*.csv")):
        for r in read_csv(path):
            if r["월세"] not in ("0", "") or r.get("계약구분") == "갱신" or not r["단지코드"]:
                continue
            area, dep = float(r["전용면적"]), int(r["보증금"] or 0)
            if dep <= 0:
                continue
            out.append({"code": r["단지코드"], "date": r["계약일"], "area": area, "band": area_band(area),
                        "price": dep, "ppp": dep / area * PYEONG})
    return out


def build_subscriptions(summary):
    """청약 공고 + 주택형별 분양가 + 주변 시세 비교(예상 차익)"""
    sub_csv = ROOT / "data" / "subscription.csv"
    if not sub_csv.exists():
        return []
    types = defaultdict(list)
    for t in read_csv(ROOT / "data" / "subscription_types.csv"):
        if t["최고분양가"] and t["전용면적"]:
            types[t["주택관리번호"]].append(t)
    # 주택형별 1순위 해당지역 경쟁률 · 당첨가점 (서울 거주자 기준)
    cmpet, score = defaultdict(dict), defaultdict(dict)
    for c in read_csv(ROOT / "data" / "subscription_cmpet.csv") if (ROOT / "data" / "subscription_cmpet.csv").exists() else []:
        if c.get("순위") == "1" and c.get("거주지역") == "해당지역":
            try:
                cmpet[c["주택관리번호"]][c["주택형"].strip()] = float(c["경쟁률"])
            except (ValueError, KeyError):
                pass
    for c in read_csv(ROOT / "data" / "subscription_score.csv") if (ROOT / "data" / "subscription_score.csv").exists() else []:
        if c.get("거주지역") == "해당지역":
            try:  # 가점 미공개·추첨제 타입은 "-" 또는 0
                lo, avg = int(float(c["최저가점"])), float(c["평균가점"] or 0)
            except (ValueError, TypeError):
                continue
            if lo > 0:
                score[c["주택관리번호"]][c["주택형"].strip()] = (lo, avg)

    this_year = date.today().year
    priced = [s for s in summary if s["p"] and s["la"]]
    out = []
    for r in read_csv(sub_csv):
        no = r["주택관리번호"]
        ts = types.get(no, [])
        ty = ty_list = [[t["주택형"].strip(), float(t["전용면적"]), int(t["일반공급세대"] or 0),
                         int(t["특별공급세대"] or 0), int(t["최고분양가"])] for t in ts]
        sppp = median([p / a * PYEONG for _, a, _, _, p in ty if a > 0])  # 분양 평당가 (전용 기준 — 시세와 같은 기준)
        s84 = median([p for _, a, _, _, p in ty if 76 <= a < 95])
        s59 = median([p for _, a, _, _, p in ty if 50 <= a < 66])

        # 주변 시세: 1km 안 10년 이내 신축 우선, 3개 미만이면 1km 안 전체
        nb, la, lo = [], float(r["위도"] or 0), float(r["경도"] or 0)
        if la:
            near = [(km((la, lo), (o["la"], o["lo"])), o) for o in priced
                    if abs(o["la"] - la) < 0.012 and abs(o["lo"] - lo) < 0.015]
            near = sorted([x for x in near if x[0] <= 1.0], key=lambda x: x[0])
            new = [x for x in near if x[1]["y"] and this_year - x[1]["y"] <= 10]
            nb, only_new = (new, True) if len(new) >= 3 else (near, False)
        n_ppp = median([o["p"] for _, o in nb])
        n84 = median([o["p84"] for _, o in nb if o["p84"]])
        out.append({
            "k": r["구분"], "no": r["주택관리번호"], "n": r["단지명"], "a": r["주소"], "g": r["구"],
            "h": int(r["공급세대수"] or 0), "pv": r["민영국민"],
            "dt": {k: r[k] for k in ("모집공고일", "특공접수일", "1순위해당지역", "1순위기타지역", "2순위",
                                     "접수시작", "접수종료", "당첨자발표일", "계약시작", "계약종료") if r[k]},
            "mv": r["입주예정월"], "cs": r["시공사"], "hp": r["홈페이지"], "url": r["공고URL"],
            "reg": [n for n, k in (("분양가상한제", "분양가상한제"), ("투기과열", "투기과열지구"), ("조정대상", "조정대상지역"))
                    if r[k] == "Y"],
            "la": la or None, "lo": lo or None, "ty": ty, "s84": s84, "s59": s59, "sppp": sppp,
            "nppp": n_ppp, "n84": n84, "nnew": only_new if nb else None, "nn": len(nb),
            "mg": change(n_ppp, sppp),                                   # 주변 시세가 분양가보다 몇 % 높은가
            "m84": n84 - s84 if n84 and s84 else None,                   # 84㎡ 기준 예상 차익(만원)
            "near": [{"c": o["c"], "n": o["n"], "km": round(dk, 2), "y": o["y"], "p84": o["p84"], "p": o["p"]}
                     for dk, o in nb[:6]],
            "cm": round(max(cmpet[no].values()), 1) if cmpet.get(no) else None,                 # 최고 경쟁률
            "sc": min(v[0] for v in score[no].values()) if score.get(no) else None,           # 가장 낮은 당첨 커트라인
            "tyc": {ty: [cmpet[no].get(ty), *(score[no].get(ty) or (None, None))]               # 타입별 [경쟁률, 최저, 평균]
                    for ty in {t[0] for t in ty_list}} if (cmpet.get(no) or score.get(no)) else None,
        })
    return out


def main():
    trades = load_trades()
    if not trades:
        raise SystemExit("❌ data/trades에 데이터가 없습니다.")
    jeonse = load_jeonse()

    last = date.fromisoformat(max(t["date"] for t in trades))
    # 기준: 최근 12개월 vs 1년 전 같은 기간 vs 3년 전 같은 기간
    w0 = months_before(last, 11).isoformat()
    w5 = months_before(last, 59).isoformat()          # 최근 5년 (소형 단지 추정용 거래 건수)
    w1 = (months_before(last, 23).isoformat(), w0)
    w3 = (months_before(last, 47).isoformat(), months_before(last, 35).isoformat())

    by_code, j_by_code = defaultdict(list), defaultdict(list)
    for t in trades:
        by_code[t["code"]].append(t)
    for t in jeonse:
        j_by_code[t["code"]].append(t)

    info = {r["단지코드"]: r for r in read_csv(ROOT / "data" / "complexes.csv")} \
        if (ROOT / "data" / "complexes.csv").exists() else {}
    vpath = ROOT / "data" / "model" / "complex_value.csv"     # value_model.py 결과 (정제 시세·방어력·접근성)
    value = {r["단지코드"]: r for r in read_csv(vpath)} if vpath.exists() else {}
    fpath = ROOT / "data" / "model" / "fair_value.csv"          # fair_value.py 결과 (적정가·괴리율·가격 이유)
    for r in read_csv(fpath) if fpath.exists() else []:
        value.setdefault(r["단지코드"], {}).update(r)

    # 같은 단지가 지번별로 쪼개진 것 합치기 (보조 코드의 거래를 대표 코드로)
    alias = merge_groups(info, {c: len(v) for c, v in by_code.items()})
    members = defaultdict(list)
    for a, p in alias.items():
        by_code[p].extend(by_code.pop(a, []))
        j_by_code[p].extend(j_by_code.pop(a, []))
        members[p].append(a)
    print(f"🔗 지번별로 쪼개진 단지 합침: {len(alias)}개 → {len(members)}개 단지로")

    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "c").mkdir(parents=True)

    # 모든 단지(매매 + 전월세만 있는 단지)를 목록·검색에 노출. 단지 정보표에 아직 없으면 거래 기록의 기본 정보 사용
    basic = {}
    for kind in ("rent", "trades"):          # 매매 기록이 있으면 그 정보가 우선 (나중에 덮어씀)
        for path in sorted((ROOT / "data" / kind).glob("*.csv")):
            for r in read_csv(path):
                if r["단지코드"]:
                    basic[r["단지코드"]] = {"단지코드": r["단지코드"], "아파트명": r["아파트명"], "구": r["구"],
                                           "법정동": r["법정동"], "지번": r["지번"], "건축년도": r["건축년도"]}

    summary, details = [], {}
    for code in sorted(set(by_code) | set(basic)):
        if code in alias:
            continue
        ts = by_code.get(code, [])
        ci = info.get(code) if info.get(code, {}).get("위도") else basic.get(code)
        if not ci:
            continue
        js = j_by_code.get(code, [])
        recent = [t for t in ts if t["date"] >= w0]
        j_recent = [t for t in js if t["date"] >= w0]
        p_now = median([t["ppp"] for t in recent])
        p_1y = median([t["ppp"] for t in ts if w1[0] <= t["date"] < w1[1]])
        p_3y = median([t["ppp"] for t in ts if w3[0] <= t["date"] < w3[1]])
        jp_now = median([t["ppp"] for t in j_recent])
        p84 = median([t["price"] for t in recent if t["band"] == "84"])
        p59 = median([t["price"] for t in recent if t["band"] == "59"])
        j84 = median([t["price"] for t in j_recent if t["band"] == "84"])
        j59 = median([t["price"] for t in j_recent if t["band"] == "59"])
        n_prev = sum(1 for t in ts if w1[0] <= t["date"] < w1[1])

        def num(k):
            v = ci.get(k)
            try:
                return float(v) if v not in (None, "") else None
            except ValueError:      # "없음" 등
                return None

        summary.append({
            "c": code, "n": display_name(ci["아파트명"], ci["법정동"], ci.get("kapt단지명")),
            "al": " ".join(x for x in {ci["아파트명"], ci.get("kapt단지명") or "",
                                       *(info[m]["아파트명"] for m in members.get(code, []))} if x),   # 검색용 다른 이름 (합친 단지 포함)
            "g": ci["구"], "d": ci["법정동"], "j": ci["지번"],
            "la": round(float(ci["위도"]), 6) if ci.get("위도") else None,
            "lo": round(float(ci["경도"]), 6) if ci.get("경도") else None,
            "y": int(ci["건축년도"]) if ci.get("건축년도") else None,
            # 세대수: K-apt 우선, 없으면 건축물대장 (K-apt 미등록 소규모 단지)
            "h": int(num("세대수")) if num("세대수") else (int(num("대장세대수")) if num("대장세대수") else None),
            "hsrc": "kapt" if num("세대수") else ("대장" if num("대장세대수") else None),
            "mg": len(members.get(code, [])) or None,                       # 합쳐진 지번 단지 수
            "b": ci.get("건설사") or None,
            "st": ci.get("최근접역") or None, "sd": int(num("역거리m")) if num("역거리m") is not None else None,
            "sl": int(num("역세권노선수") or 0),
            "bz": ci.get("업무지구최근접") or None, "bk": num("업무지구거리km"),
            **{k: (ci.get(col) if ci.get(col) not in (None, "", "없음") else None) for k, col in
               (("es", "초등학교"), ("ms", "중학교"), ("hs", "고등학교"))},
            **{k: (int(num(col)) if num(col) is not None else None) for k, col in
               (("em", "초등학교m"), ("mm", "중학교m"), ("hm", "고등학교m"))},
            "a5": int(num("학원수500m")) if num("학원수500m") is not None else None,
            "a1": int(num("학원수1km")) if num("학원수1km") is not None else None,
            "p": p_now, "p84": p84, "p59": p59, "j84": j84, "j59": j59,
            "jr": round(jp_now / p_now * 100) if jp_now and p_now else None,     # 전세가율 %
            "gap84": p84 - j84 if p84 and j84 else None,                          # 84㎡ 매매-전세
            "r1": change(p_now, p_1y), "r3": change(p_now, p_3y),
            "n12": len(recent), "vt": change(len(recent), n_prev),               # 거래량 1년 변화
            "n5": sum(1 for t in ts if t["date"] >= w5) + sum(1 for t in js if t["date"] >= w5),   # 최근 5년 매매+전세 건수
            "last": max((t["date"] for t in ts), default=None),
            "lt": (lambda t: [t["date"], round(t["area"], 1), t["floor"], t["price"]])(max(ts, key=lambda t: t["date"]))
                  if ts else None,                                                  # 최근 매매 거래
            "lj": (lambda t: [t["date"], round(t["area"], 1), t["price"]])(max(js, key=lambda t: t["date"]))
                  if js else None,                                                  # 최근 전세 거래
            "far": num("용적률"), "bcr": num("건폐율"),                             # 용적률·건폐율 (건축물대장)
            **value_fields(value.get(code)),
        })

        def monthly(rows, key):
            m = defaultdict(lambda: defaultdict(list))
            for t in rows:
                m[t["band"]][t["date"][:7]].append(t[key])
            return {band: [[mo, median(v), len(v)] for mo, v in sorted(ms.items())] for band, ms in m.items()}

        vol = defaultdict(int)
        pp = defaultdict(list)
        for t in ts:
            vol[t["date"][:7]] += 1
            pp[t["date"][:7]].append(t["ppp"])
        details[code] = {
            "series": monthly(ts, "price"),                    # 평형별 월별 매매가 중앙값
            "jseries": monthly(js, "price"),                   # 평형별 월별 전세가 중앙값
            "pp": [[mo, median(v)] for mo, v in sorted(pp.items())],  # 월별 평당가 (단지 비교용)
            "vol": sorted(vol.items()),                        # 월별 거래량
            "trades": [[t["date"], round(t["area"], 1), t["floor"], t["price"]]
                       for t in sorted(ts, key=lambda t: t["date"], reverse=True)[:30]],
        }

    # 합친 단지의 세대수 = 서로 다른 K-apt 단지 세대수의 합 (같은 K-apt를 두 번 세지 않음)
    for s_ in summary:
        if s_.get("mg"):
            seen_k, tot = set(), 0
            for c in [s_["c"], *members[s_["c"]]]:
                r = info.get(c, {})
                k, h = r.get("kaptCode"), r.get("세대수")
                if k and h and k not in seen_k:
                    seen_k.add(k); tot += int(float(h))
            if tot > (s_["h"] or 0):
                s_["h"], s_["hsrc"] = tot, "kapt"
            # 이름: "e편한세상서울대입구1단지" → "e편한세상서울대입구" (합친 묶음 전체를 대표하도록)
            nm = re.sub(r"\s*\d+\s*단지$", "", re.sub(r"\((?:\d|임대|고층|저층).*?\)", "", s_["n"])).strip()
            if len(nm) >= 3:
                s_["n"] = nm

    # 키맞추기: 반경 1.5km 안 단지들과 평당가·3년 상승률 비교
    priced = [s for s in summary if s["p"] and s["la"]]
    for s in summary:
        near = []
        for o in (priced if s["la"] else []):
            if o is s or abs(o["la"] - s["la"]) > 0.02 or abs(o["lo"] - s["lo"]) > 0.025:
                continue
            dkm = km((s["la"], s["lo"]), (o["la"], o["lo"]))
            if dkm <= NEIGHBOR_KM:
                near.append((dkm, o))
        near.sort(key=lambda x: x[0])
        if s["p"] and len(near) >= 3:
            s["kp"] = round((s["p"] / statistics.median(o["p"] for _, o in near) - 1) * 100, 1)  # 주변 대비 평당가 %
            r3s = [o["r3"] for _, o in near if o["r3"] is not None]
            s["kr"] = round(s["r3"] - statistics.median(r3s), 1) if s["r3"] is not None and len(r3s) >= 3 else None
        else:
            s["kp"] = s["kr"] = None
        details[s["c"]]["near"] = [
            {"c": o["c"], "n": o["n"], "km": round(dkm, 2), "y": o["y"], "h": o["h"], "p": o["p"],
             "p84": o["p84"], "r3": o["r3"], "jr": o["jr"]}
            for dkm, o in near[:10]
        ]

    # 구별 월별 평당가 중앙값 (500세대 이상 단지) — 단지 리포트의 "구 평균 대비 가격 흐름"
    gu_m = defaultdict(lambda: defaultdict(list))
    for s_ in summary:
        if (s_.get("h") or 0) >= 500:
            for mo, v in details[s_["c"]]["pp"]:
                gu_m[s_["g"]][mo].append(v)
    gu_pp = {g: [[mo, round(median(v))] for mo, v in sorted(ms.items()) if len(v) >= 5] for g, ms in gu_m.items()}
    (OUT / "gu_pp.json").write_text(json.dumps(gu_pp, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    for code, d in details.items():
        (OUT / "c" / f"{code}.json").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")),
                                                encoding="utf-8")

    meta = {"alias": alias, "updated": date.today().isoformat(), "dataFrom": min(t["date"] for t in trades),
            "dataTo": last.isoformat(), "count": len(summary), "hasRent": bool(jeonse)}
    for key, name in (("fair", "fair_value_meta.json"), ("backtest", "backtest.json")):   # 점수 성적표용
        p = ROOT / "data" / "model" / name
        if p.exists():
            meta[key] = json.loads(p.read_text(encoding="utf-8"))

    # 📰 이슈 브리핑: 최근 14일치 (Claude 예약 작업이 data/news/에 커밋)
    news = sorted((ROOT / "data" / "news").glob("20??-??-??.json"), reverse=True)[:14]
    if news:
        (OUT / "news").mkdir(parents=True, exist_ok=True)
        for p in news:
            shutil.copy(p, OUT / "news" / p.name)
        (OUT / "news" / "index.json").write_text(json.dumps([p.stem for p in news]), encoding="utf-8")
        meta["newsLatest"] = news[0].stem

    subs = build_subscriptions(summary)
    if subs:
        (OUT / "subs.json").write_text(json.dumps(subs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        meta["hasSubs"] = True

    (OUT / "complexes.json").write_text(
        json.dumps({"meta": meta, "items": summary}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✅ 단지 {len(summary):,}개, 매매 {len(trades):,}건, 전세 {len(jeonse):,}건 "
          f"({meta['dataFrom']} ~ {meta['dataTo']})")


if __name__ == "__main__":
    main()
