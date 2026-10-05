"""
단지 정보표 만들기 — data/complexes.csv

수집된 매매 데이터의 단지코드(aptSeq)마다 한 줄씩:
  좌표, 최근접역/거리, 500m 안 노선 수, 3대 업무지구 거리, K-apt 정보(세대수, 사용승인일, 건설사 등)

사용법:
  python build_complexes.py          # 새로 생긴 단지만 처리 (이미 있는 단지는 건너뜀)
  python build_complexes.py --retry  # 매칭 실패했던 단지도 다시 시도

캐시:
  data/kapt.csv  — K-apt 단지 정보 (법정동별로 한 번만 조회)
  진행 중 끊겨도 100개마다 저장하므로 다시 돌리면 이어서 처리
"""
import csv
import math
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
COMPLEX_CSV = ROOT / "data" / "complexes.csv"
KAPT_CSV = ROOT / "data" / "kapt.csv"

APT_LIST_URL = "https://apis.data.go.kr/1613000/AptListService4/getLegaldongAptList4"
APT_INFO_URL = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5"
KAKAO_ADDR_URL = "https://dapi.kakao.com/v2/local/search/address.json"
KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_CATEGORY_URL = "https://dapi.kakao.com/v2/local/search/category.json"

# 3대 업무지구 기준점
CBD = {"광화문": (37.5711, 126.9768), "강남": (37.4979, 127.0276), "여의도": (37.5216, 126.9242)}

COMPLEX_FIELDS = [
    "단지코드", "구", "법정동", "법정동코드", "지번", "아파트명", "건축년도",
    "위도", "경도", "좌표출처",
    "최근접역", "역거리m", "역세권노선수",
    "업무지구최근접", "업무지구거리km", "광화문km", "강남km", "여의도km",
    "kaptCode", "kapt단지명", "세대수", "동수", "최고층", "사용승인일", "건설사", "난방", "kapt매칭",
    "초등학교", "초등학교m", "중학교", "중학교m", "학원수500m", "학원수1km",
]
SCHOOL_FIELDS = ["초등학교", "초등학교m", "중학교", "중학교m", "학원수500m", "학원수1km"]
KAPT_FIELDS = ["kaptCode", "bjdCode", "kaptName", "kaptAddr", "doroJuso", "세대수", "동수",
               "최고층", "사용승인일", "건설사", "난방", "분양구분"]


def load_keys():
    load_dotenv(ROOT / ".env")
    s = (os.environ.get("SERVICE_KEY") or "").strip()
    k = (os.environ.get("KAKAO_KEY") or "").strip()
    if not s or not k:
        sys.exit("❌ .env에 SERVICE_KEY와 KAKAO_KEY가 모두 있어야 합니다.")
    return (unquote(s) if "%" in s else s), k


def get_json(url, params=None, headers=None, retries=3):
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == retries:
                raise
            print(f"    재시도 ({e})")
            time.sleep(2 * attempt)


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def read_csv(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    tmp.replace(path)


def complexes_from_trades():
    """매매 데이터에서 단지코드별 최신 정보 추출"""
    latest = {}
    for path in sorted((ROOT / "data" / "trades").glob("*.csv")):
        for r in read_csv(path):
            code = r["단지코드"]
            if code and (code not in latest or r["계약일"] >= latest[code]["계약일"]):
                latest[code] = r
    return {
        code: {
            "단지코드": code, "구": r["구"], "법정동": r["법정동"],
            "법정동코드": r["시군구코드"] + r["법정동코드"], "지번": r["지번"],
            "아파트명": r["아파트명"], "건축년도": r["건축년도"],
        }
        for code, r in latest.items()
    }


# ---------- K-apt ----------

class Kapt:
    def __init__(self, key):
        self.key = key
        self.rows = read_csv(KAPT_CSV)
        self.done_bjd = {r["bjdCode"] for r in self.rows}

    def by_bjd(self, bjd):
        if bjd not in self.done_bjd:
            self._fetch_bjd(bjd)
        return [r for r in self.rows if r["bjdCode"] == bjd]

    def _fetch_bjd(self, bjd):
        codes, page = [], 1
        while True:
            body = get_json(APT_LIST_URL, {"serviceKey": self.key, "bjdCode": bjd, "numOfRows": 100,
                                           "pageNo": page, "_type": "json"})["response"]["body"]
            items = body.get("items") or []
            items = items if isinstance(items, list) else [items]
            codes += [i["kaptCode"] for i in items]
            if page * 100 >= int(body.get("totalCount") or 0) or not items:
                break
            page += 1
        for code in codes:
            it = get_json(APT_INFO_URL, {"serviceKey": self.key, "kaptCode": code, "_type": "json"})
            it = it["response"]["body"].get("item") or {}
            hh = max(float(it.get("hoCnt") or 0), float(it.get("kaptdaCnt") or 0))
            self.rows.append({
                "kaptCode": code, "bjdCode": bjd, "kaptName": it.get("kaptName", ""),
                "kaptAddr": it.get("kaptAddr", ""), "doroJuso": it.get("doroJuso", ""),
                "세대수": int(hh) if hh else "", "동수": it.get("kaptDongCnt", ""),
                "최고층": it.get("kaptTopFloor", ""), "사용승인일": it.get("kaptUsedate", ""),
                "건설사": (it.get("kaptBcompany") or "").strip(), "난방": it.get("codeHeatNm", ""),
                "분양구분": it.get("codeSaleNm", ""),
            })
            time.sleep(0.05)
        if not codes:  # 단지가 없는 동도 다시 조회하지 않도록 표시
            self.rows.append({"kaptCode": "", "bjdCode": bjd})
        self.done_bjd.add(bjd)
        write_csv(KAPT_CSV, KAPT_FIELDS, self.rows)


def norm_name(s):
    s = re.sub(r"\(.*?\)", "", s or "")
    s = re.sub(r"아파트|APT|apt|\s|제(?=\d+차)", "", s)
    return s.replace("단지", "").lower()


def addr_jibun(addr, dong):
    m = re.search(re.escape(dong) + r"\s+(산?\d+(?:-\d+)?)", addr or "")
    return m.group(1) if m else ""


def match_kapt(c, candidates):
    cands = [k for k in candidates if k.get("kaptCode")]
    if not cands:
        return None, "동에 K-apt 단지 없음"
    by_jibun = [k for k in cands if addr_jibun(k["kaptAddr"], c["법정동"]) == c["지번"]]
    if len(by_jibun) == 1:
        return by_jibun[0], "지번"
    n = norm_name(c["아파트명"])
    pool = by_jibun or cands
    by_name = [k for k in pool if n and (n in norm_name(k["kaptName"]) or norm_name(k["kaptName"]) in n)]
    if len(by_name) == 1:
        return by_name[0], "지번+이름" if by_jibun else "이름"
    if len(by_jibun) > 1:  # 같은 지번에 여러 단지 → 이름으로도 못 가르면 세대수 큰 쪽(임대동 분리 등록 대비)
        return max(by_jibun, key=lambda k: float(k["세대수"] or 0)), "지번(복수)"
    return None, "매칭실패"


# ---------- 카카오 ----------

def geocode(kakao, c, kapt):
    h = {"Authorization": "KakaoAK " + kakao}
    queries = [f"서울 {c['구']} {c['법정동']} {c['지번']}"]
    if kapt and kapt.get("doroJuso"):
        queries.append(kapt["doroJuso"])
    for q in queries:
        docs = get_json(KAKAO_ADDR_URL, {"query": q}, h).get("documents", [])
        if docs:
            return float(docs[0]["y"]), float(docs[0]["x"]), "주소"
    docs = get_json(KAKAO_KEYWORD_URL, {"query": f"{c['구']} {c['아파트명']} 아파트"}, h).get("documents", [])
    if docs:
        return float(docs[0]["y"]), float(docs[0]["x"]), "키워드"
    return None, None, "실패"


def stations(kakao, lat, lon):
    h = {"Authorization": "KakaoAK " + kakao}
    for radius in (2000, 5000):
        docs = get_json(KAKAO_CATEGORY_URL, {"category_group_code": "SW8", "x": lon, "y": lat,
                                             "radius": radius, "sort": "distance"}, h).get("documents", [])
        if docs:
            break
    if not docs:
        return "", "", 0
    lines = {d["place_name"].split()[-1] for d in docs if int(d["distance"]) <= 500}
    return docs[0]["place_name"], int(docs[0]["distance"]), len(lines)


def schools(kakao, lat, lon):
    """가장 가까운 초·중학교와 학원 수 (카카오 카테고리 검색: SC4 학교, AC5 학원)"""
    h = {"Authorization": "KakaoAK " + kakao}
    out = {}
    nearest = {"초등학교": None, "중학교": None}
    for page in (1, 2, 3):
        res = get_json(KAKAO_CATEGORY_URL, {"category_group_code": "SC4", "x": lon, "y": lat, "radius": 2000,
                                            "sort": "distance", "page": page}, h)
        for d in res.get("documents", []):
            kind = d["category_name"].split(">")[-1].strip()
            if kind in nearest and nearest[kind] is None:
                nearest[kind] = (d["place_name"], int(d["distance"]))
        if all(nearest.values()) or res["meta"].get("is_end", True):
            break
    for kind, v in nearest.items():
        out[kind], out[kind + "m"] = v if v else ("", "")
    for radius, col in ((500, "학원수500m"), (1000, "학원수1km")):
        res = get_json(KAKAO_CATEGORY_URL, {"category_group_code": "AC5", "x": lon, "y": lat,
                                            "radius": radius, "size": 1}, h)
        out[col] = res["meta"]["total_count"]
    return out


def main():
    service_key, kakao = load_keys()
    retry = "--retry" in sys.argv

    targets = complexes_from_trades()
    existing = {r["단지코드"]: r for r in read_csv(COMPLEX_CSV)}
    todo = [c for code, c in targets.items()
            if code not in existing or (retry and existing[code]["kapt매칭"] in ("매칭실패", "동에 K-apt 단지 없음"))]
    print(f"단지 {len(targets):,}개 중 처리할 단지 {len(todo):,}개")

    kapt = Kapt(service_key)
    for i, c in enumerate(todo, 1):
        k, how = match_kapt(c, kapt.by_bjd(c["법정동코드"]))
        lat, lon, src = geocode(kakao, c, k)
        row = {**c, "위도": lat or "", "경도": lon or "", "좌표출처": src, "kapt매칭": how}
        if lat:
            row["최근접역"], row["역거리m"], row["역세권노선수"] = stations(kakao, lat, lon)
            d = {name: haversine_km((lat, lon), p) for name, p in CBD.items()}
            row.update({f"{n}km": round(v, 2) for n, v in d.items()})
            row["업무지구최근접"] = min(d, key=d.get)
            row["업무지구거리km"] = round(min(d.values()), 2)
        if k:
            row.update({"kaptCode": k["kaptCode"], "kapt단지명": k["kaptName"], "세대수": k["세대수"],
                        "동수": k["동수"], "최고층": k["최고층"], "사용승인일": k["사용승인일"],
                        "건설사": k["건설사"], "난방": k["난방"]})
        existing[c["단지코드"]] = row
        if i % 100 == 0 or i == len(todo):
            write_csv(COMPLEX_CSV, COMPLEX_FIELDS, sorted(existing.values(), key=lambda r: r["단지코드"]))
            print(f"  {i:,}/{len(todo):,} 저장", flush=True)

    # 학군 정보가 비어 있는 단지 채우기 (나중에 추가된 열이라 예전 단지도 여기서 처리)
    need = [r for r in existing.values() if r.get("위도") and r.get("학원수1km") in (None, "")]
    if need:
        print(f"학군 정보 채울 단지 {len(need):,}개")
    for i, r in enumerate(need, 1):
        r.update(schools(kakao, float(r["위도"]), float(r["경도"])))
        if i % 200 == 0 or i == len(need):
            write_csv(COMPLEX_CSV, COMPLEX_FIELDS, sorted(existing.values(), key=lambda r: r["단지코드"]))
            print(f"  학군 {i:,}/{len(need):,} 저장", flush=True)

    rows = list(existing.values())
    ok = sum(1 for r in rows if r.get("세대수"))
    geo = sum(1 for r in rows if r.get("위도"))
    print(f"✅ 단지 {len(rows):,}개 — 좌표 {geo:,}개, 세대수 매칭 {ok:,}개 ({ok / max(len(rows), 1):.0%})")


if __name__ == "__main__":
    main()
