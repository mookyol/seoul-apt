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
import difflib
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
BLD_URL = "https://apis.data.go.kr/1613000/BldRgstHubService/"   # 건축물대장 (활용신청 필요)

# 3대 업무지구 기준점
CBD = {"광화문": (37.5711, 126.9768), "강남": (37.4979, 127.0276), "여의도": (37.5216, 126.9242)}

COMPLEX_FIELDS = [
    "단지코드", "구", "법정동", "법정동코드", "지번", "아파트명", "건축년도",
    "위도", "경도", "좌표출처",
    "최근접역", "역거리m", "역세권노선수",
    "업무지구최근접", "업무지구거리km", "광화문km", "강남km", "여의도km",
    "kaptCode", "kapt단지명", "세대수", "동수", "최고층", "사용승인일", "건설사", "난방", "kapt매칭",
    "초등학교", "초등학교m", "중학교", "중학교m", "고등학교", "고등학교m", "학원수500m", "학원수1km", "최근거래일",
    "용적률", "건폐율", "대지면적", "연면적", "대장세대수",
]
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
    out = {
        code: {
            "단지코드": code, "구": r["구"], "법정동": r["법정동"],
            "법정동코드": r["시군구코드"] + r["법정동코드"], "지번": r["지번"],
            "아파트명": r["아파트명"], "건축년도": r["건축년도"], "최근거래일": r["계약일"],
        }
        for code, r in latest.items()
    }
    # 매매 기록 없이 전월세만 있는 단지도 포함 (전월세 자료엔 법정동코드가 없어 매매 자료의 구·동 이름으로 찾음)
    bjd = {(v["구"], v["법정동"]): v["법정동코드"] for v in out.values()}
    rent_latest = {}
    for path in sorted((ROOT / "data" / "rent").glob("*.csv")):
        for r in read_csv(path):
            code = r["단지코드"]
            if code and code not in out and (code not in rent_latest or r["계약일"] >= rent_latest[code]["계약일"]):
                rent_latest[code] = r
    for code, r in rent_latest.items():
        out[code] = {
            "단지코드": code, "구": r["구"], "법정동": r["법정동"],
            "법정동코드": bjd.get((r["구"], r["법정동"]), ""), "지번": r["지번"],
            "아파트명": r["아파트명"], "건축년도": r["건축년도"], "최근거래일": r["계약일"],
        }
    return out


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


# 영문·약칭 브랜드 → 한글 표기 통일 (실거래 신고명과 K-apt 이름의 표기 차이 흡수)
BRAND_SYN = [(r"i-?park", "아이파크"), (r"e-?편한세상|이-?편한세상", "이편한세상"), (r"sk\s*view|sk뷰|에스케이뷰", "에스케이뷰"),
             (r"hill\s*state", "힐스테이트"), (r"xi", "자이"), (r"the\s*sharp|더#", "더샵"), (r"lh", "엘에이치"),
             (r"prugio", "푸르지오"), (r"raemian", "래미안"), (r"lotte\s*castle", "롯데캐슬"), (r"s-?클래스", "에스클래스")]


def norm_name(s, dong=""):
    s = (s or "").lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", "", s)
    s = re.sub(r"\d+(\s*[~,]\s*\d+)*\s*동", "", s)      # "117동~125동", "201동" 같은 동 번호는 단지 이름이 아님
    for pat, rep in BRAND_SYN:
        s = re.sub(pat, rep, s)
    s = re.sub(r"아파트|apt|\s|제(?=\d+차)|[·.,\-]", "", s)
    stem = re.sub(r"(본동|\d*동(\d+가)?|\d+가)$", "", dong or "")
    if stem and len(s) > len(stem) + 2:
        s = s.replace(stem, "")                       # "래미안장위퍼스트하이" → "래미안퍼스트하이"
    return s.replace("단지", "")


def addr_jibun(addr, dong):
    m = re.search(re.escape(dong) + r"\s+(산?\d+(?:-\d+)?)", addr or "")
    return m.group(1) if m else ""


def match_kapt(c, candidates):
    cands = [k for k in candidates if k.get("kaptCode") and k.get("kaptName")]
    if not cands:
        return None, "동에 K-apt 단지 없음"
    by_jibun = [k for k in cands if addr_jibun(k["kaptAddr"], c["법정동"]) == c["지번"]]
    if len(by_jibun) == 1:
        return by_jibun[0], "지번"
    n = norm_name(c["아파트명"], c["법정동"])
    pool = by_jibun or cands
    digits = lambda x: re.findall(r"\d+", x)

    def same_name(a, b):
        # 오매칭 방지: 3글자 이상 · 숫자(차수·단지) 일치 · 짧은 쪽이 긴 쪽의 절반 이상일 때만 "포함"을 같은 이름으로 인정
        short, long_ = sorted((a, b), key=len)
        return len(short) >= 3 and digits(a) == digits(b) and len(short) * 2 >= len(long_) and short in long_

    by_name = [k for k in pool if n and same_name(n, norm_name(k["kaptName"], c["법정동"]))]
    if len(by_name) == 1:
        return by_name[0], "지번+이름" if by_jibun else "이름"
    if len(by_jibun) > 1:  # 같은 지번에 여러 단지 → 이름으로도 못 가르면 세대수 큰 쪽(임대동 분리 등록 대비)
        return max(by_jibun, key=lambda k: float(k["세대수"] or 0)), "지번(복수)"
    # 재건축 신축은 지번이 바뀌고 이름 표기도 달라짐 → 이름 유사도로 (가장 비슷한 후보가 확실히 앞설 때만)
    if n and len(n) >= 3:
        # 숫자(차수·단지)가 다르면 다른 단지로 봄 ("등촌6차" ≠ "등촌2차"), 철자만 조금 다른 경우만 허용 ("시그니쳐" ≈ "시그니처")
        scored = sorted(((difflib.SequenceMatcher(None, n, kn).ratio(), k) for k in pool
                         if digits(kn := norm_name(k["kaptName"], c["법정동"])) == digits(n)), key=lambda x: -x[0])
        if scored and scored[0][0] >= 0.88 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.15):
            return scored[0][1], "이름유사"
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


def building(key, bjd, jibun):
    """건축물대장 → 용적률·건폐율·대지면적·연면적. 총괄표제부(단지 전체) 우선, 없으면 표제부 중 가장 큰 동.
    반환: dict / None(자료 없음) / 예외 PermissionError(API 미승인)"""
    m = re.match(r"(산)?(\d+)(?:-(\d+))?", (jibun or "").strip())
    if not bjd or not m:
        return None
    params = {"serviceKey": key, "sigunguCd": bjd[:5], "bjdongCd": bjd[5:], "platGbCd": "1" if m.group(1) else "0",
              "bun": m.group(2).zfill(4), "ji": (m.group(3) or "0").zfill(4), "numOfRows": 100, "pageNo": 1, "_type": "json"}
    hh_found = 0
    for op in ("getBrRecapTitleInfo", "getBrTitleInfo"):
        for attempt in range(3):            # 공공데이터 서버가 해외(깃허브)에서 접속 시 가끔 응답이 늦음 → 3번까지 재시도
            try:
                r = requests.get(BLD_URL + op, params=params, timeout=30)
                break
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(5 * (attempt + 1))
        if r.status_code in (401, 403):
            raise PermissionError("건축물대장 API 미승인")
        try:
            body = r.json()
        except ValueError:          # 일일 호출 한도 초과 등은 JSON이 아닌 오류 문서로 옴 → 오늘은 여기까지
            raise PermissionError("건축물대장 API 한도 초과 또는 오류")
        items = ((body.get("response", {}).get("body", {}).get("items") or {}) or {}).get("item") or []
        items = items if isinstance(items, list) else [items]
        hh = sum(int(float(i.get("hhldCnt") or 0)) for i in items) if op == "getBrTitleInfo" else \
            max((int(float(i.get("hhldCnt") or 0)) for i in items), default=0)
        hh_found = hh_found or hh
        items = [i for i in items if float(i.get("vlRat") or 0) > 0]
        if items:
            it = max(items, key=lambda i: float(i.get("totArea") or 0))
            return {"용적률": round(float(it["vlRat"]), 1), "건폐율": round(float(it.get("bcRat") or 0), 1),
                    "대지면적": round(float(it.get("platArea") or 0)), "연면적": round(float(it.get("totArea") or 0)),
                    "대장세대수": hh_found or ""}
    # 1970~80년대 대장은 대지면적·용적률이 비어 있는 경우가 많음 → 세대수만이라도 저장
    return {"용적률": "없음", "대장세대수": hh_found or ""}


def schools(kakao, lat, lon):
    """가장 가까운 초·중·고등학교와 학원 수 (카카오 카테고리 검색: SC4 학교, AC5 학원)"""
    h = {"Authorization": "KakaoAK " + kakao}
    out = {}
    nearest = {"초등학교": None, "중학교": None, "고등학교": None}
    for page in (1, 2, 3):
        res = get_json(KAKAO_CATEGORY_URL, {"category_group_code": "SC4", "x": lon, "y": lat, "radius": 2000,
                                            "sort": "distance", "page": page}, h)
        for d in res.get("documents", []):
            kind = d["category_name"].split(">")[-1].strip()
            kind = "고등학교" if kind.endswith("고등학교") else kind   # 특목고·자사고 등도 고등학교로
            if kind in nearest and nearest[kind] is None:
                nearest[kind] = (d["place_name"], int(d["distance"]))
        if all(nearest.values()) or res["meta"].get("is_end", True):
            break
    for kind, v in nearest.items():
        out[kind], out[kind + "m"] = v if v else ("없음", "")
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
    # 우선 처리할 구 (예: --first 송파구,강동구) → 그다음 최근에 거래된 단지부터 (활발한 단지 우선)
    first = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--first=")), os.environ.get("FIRST_GU", ""))
    first = [g.strip() for g in first.split(",") if g.strip()]
    todo.sort(key=lambda c: c["최근거래일"], reverse=True)
    todo.sort(key=lambda c: c["구"] not in first)                # 안정 정렬 — 우선 구 안에서도 최근 거래순 유지
    for code, c in targets.items():                          # 이미 있는 단지도 최근거래일은 갱신
        if code in existing:
            existing[code]["최근거래일"] = c["최근거래일"]
    print(f"단지 {len(targets):,}개 중 처리할 단지 {len(todo):,}개")

    deadline = time.time() + float(os.environ.get("MAX_MINUTES") or 1e6) * 60   # 시간 예산 (남은 건 다음 실행)
    save = lambda: write_csv(COMPLEX_CSV, COMPLEX_FIELDS, sorted(existing.values(), key=lambda r: r["단지코드"]))
    kapt = Kapt(service_key)
    kfields = ("kaptCode", "kapt단지명", "세대수", "동수", "최고층", "사용승인일", "건설사", "난방")
    added = dropped = 0
    for r in existing.values():
        if not r.get("법정동코드"):
            continue
        if not r.get("kaptCode"):
            k, how = match_kapt(r, kapt.by_bjd(r["법정동코드"]))
            if k:
                r.update({"kaptCode": k["kaptCode"], "kapt단지명": k["kaptName"], "세대수": k["세대수"], "동수": k["동수"],
                          "최고층": k["최고층"], "사용승인일": k["사용승인일"], "건설사": k["건설사"], "난방": k["난방"],
                          "kapt매칭": how})
                added += 1
        elif r.get("kapt매칭") == "이름" and len(norm_name(r["아파트명"], r["법정동"])) < 3:
            r.update({f: "" for f in kfields} | {"kapt매칭": "매칭실패(짧은 이름)"})
            dropped += 1
    print(f"K-apt 재매칭: 새로 {added}개, 의심 매칭 해제 {dropped}개")
    for i, c in enumerate(todo, 1):
        if time.time() > deadline:
            save()
            print(f"⏸  시간 예산 소진 — {i - 1:,}/{len(todo):,}개 처리, 나머지는 다음 실행에서")
            sys.exit(3)   # 남은 작업 있음 (워크플로가 저장 후 다시 실행)
        k, how = match_kapt(c, kapt.by_bjd(c["법정동코드"])) if c["법정동코드"] else (None, "법정동코드 없음")
        lat, lon, src = geocode(kakao, c, k)
        row = {**c, "위도": lat or "", "경도": lon or "", "좌표출처": src, "kapt매칭": how}
        if lat:
            row["최근접역"], row["역거리m"], row["역세권노선수"] = stations(kakao, lat, lon)
            d = {name: haversine_km((lat, lon), p) for name, p in CBD.items()}
            row.update({f"{n}km": round(v, 2) for n, v in d.items()})
            row["업무지구최근접"] = min(d, key=d.get)
            row["업무지구거리km"] = round(min(d.values()), 2)
            row.update(schools(kakao, lat, lon))   # 학군도 같이 (단지가 화면에 한 번에 완성되도록)
        if k:
            row.update({"kaptCode": k["kaptCode"], "kapt단지명": k["kaptName"], "세대수": k["세대수"],
                        "동수": k["동수"], "최고층": k["최고층"], "사용승인일": k["사용승인일"],
                        "건설사": k["건설사"], "난방": k["난방"]})
        existing[c["단지코드"]] = row
        if i % 100 == 0 or i == len(todo):
            save()
            print(f"  {i:,}/{len(todo):,} 저장", flush=True)

    # 학군 정보가 비어 있는 단지 채우기 (나중에 추가된 열이라 예전 단지도 여기서 처리)
    # 용적률 (건축물대장) — 비어 있는 단지만. API가 아직 승인 전이면 조용히 건너뜀
    need_far = [r for r in existing.values() if not r.get("용적률")]
    need_far.sort(key=lambda r: r.get("최근거래일") or "", reverse=True)
    fails = 0
    try:
        for i, r in enumerate(need_far, 1):
            if time.time() > deadline:
                save()
                sys.exit(3)
            try:
                r.update(building(service_key, r.get("법정동코드"), r.get("지번")) or {"용적률": "없음"})
                fails = 0
            except requests.RequestException:   # 접속 지연 — 이 단지는 비워 두고 다음 실행에서 다시
                fails += 1
                if fails >= 20:
                    print("ℹ️  건축물대장 서버 응답 없음 (20회 연속) — 다음 실행에서 이어서")
                    break
            if i % 300 == 0 or i == len(need_far):
                save()
                print(f"  용적률 {i:,}/{len(need_far):,} 저장", flush=True)
    except PermissionError:
        print("ℹ️  건축물대장 API 미승인·한도 초과 — 남은 단지는 다음 실행에서 이어서")
    save()

    # (학교 이름 칸이 비어 있음 = 아직 조회 안 함. 2km 안에 학교가 없으면 "없음"으로 기록)
    need = [r for r in existing.values() if r.get("위도") and (not r.get("학원수1km") or not r.get("고등학교"))]
    need.sort(key=lambda r: r.get("최근거래일") or "", reverse=True)
    need.sort(key=lambda r: r.get("구") not in first)
    if need:
        print(f"학군 정보 채울 단지 {len(need):,}개")
    for i, r in enumerate(need, 1):
        if time.time() > deadline:
            save()
            print(f"⏸  시간 예산 소진 — 학군 {i - 1:,}/{len(need):,}개 처리, 나머지는 다음 실행에서")
            sys.exit(3)
        r.update(schools(kakao, float(r["위도"]), float(r["경도"])))
        if i % 200 == 0 or i == len(need):
            save()
            print(f"  학군 {i:,}/{len(need):,} 저장", flush=True)

    rows = list(existing.values())
    ok = sum(1 for r in rows if r.get("세대수"))
    geo = sum(1 for r in rows if r.get("위도"))
    print(f"✅ 단지 {len(rows):,}개 — 좌표 {geo:,}개, 세대수 매칭 {ok:,}개 ({ok / max(len(rows), 1):.0%})")


if __name__ == "__main__":
    main()
