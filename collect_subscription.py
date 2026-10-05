"""
서울 아파트 청약(분양) 정보 수집 — 청약홈 분양정보 조회 서비스

  data/subscription.csv        공고별 일정·규제·입주예정 (APT 일반분양 + 무순위/잔여세대)
  data/subscription_types.csv  주택형별 공급세대수·최고 분양가 (공고당 한 번만 조회)
  data/subscription_cmpet.csv  주택형별 경쟁률 (별도 활용신청 서비스 — 승인 전이면 건너뜀)
  data/subscription_score.csv  주택형별 당첨 가점 (최저·평균·최고)

사용법: python collect_subscription.py
"""
import csv
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "subscription.csv"
TYPES = ROOT / "data" / "subscription_types.csv"
CMPET = ROOT / "data" / "subscription_cmpet.csv"
API = "https://api.odcloud.kr/api/"
KAKAO_ADDR_URL = "https://dapi.kakao.com/v2/local/search/address.json"
KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"

KINDS = {  # 구분: (공고 목록 API, 주택형 API)
    "APT": ("ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail", "ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl"),
    "무순위": ("ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail", "ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancMdl"),
}
FIELDS = ["구분", "주택관리번호", "공고번호", "단지명", "주소", "구", "공급세대수", "민영국민",
          "모집공고일", "특공접수일", "1순위해당지역", "1순위기타지역", "2순위", "접수시작", "접수종료",
          "당첨자발표일", "계약시작", "계약종료", "입주예정월",
          "분양가상한제", "투기과열지구", "조정대상지역", "시공사", "시행사", "홈페이지", "공고URL", "위도", "경도"]
TYPE_FIELDS = ["주택관리번호", "공고번호", "주택형", "전용면적", "공급면적", "일반공급세대", "특별공급세대", "최고분양가"]
CMPET_FIELDS = ["주택관리번호", "공고번호", "주택형", "순위", "거주지역", "공급세대", "접수건수", "경쟁률"]
SCORE = ROOT / "data" / "subscription_score.csv"
SCORE_FIELDS = ["주택관리번호", "주택형", "거주지역", "최저가점", "평균가점", "최고가점"]


def read_csv(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def get_all(key, endpoint, cond):
    rows, page = [], 1
    while True:
        r = requests.get(API + endpoint, params={"serviceKey": key, "page": page, "perPage": 500, **cond}, timeout=60)
        if r.status_code == 401:
            raise PermissionError(endpoint)
        r.raise_for_status()
        body = r.json()
        rows += body.get("data") or []
        if page * 500 >= int(body.get("matchCount") or 0) or not body.get("data"):
            return rows
        page += 1


def d(v):
    return (v or "").strip() if isinstance(v, str) else ("" if v is None else str(v))


def geocode(kakao, addr, name):
    h = {"Authorization": "KakaoAK " + kakao}
    # "○○동 70-4번지 일원", "15번지 일대, ○○지구" 같은 공고 주소를 카카오가 알아듣는 형태로 정리
    q = re.sub(r"(번지|일원|일대|외\s*\d+필지|\(|,).*$", "", addr).strip()
    # "그란츠 리버파크(3차)", "○○ 신혼희망타운(공공분양) 잔여세대" → 단지 이름만
    nm = re.sub(r"\(.*?\)|잔여세대|무순위|임의공급|본청약|사전청약|\d+차", "", name).strip()
    gu = addr.split()[1] if len(addr.split()) > 1 else ""
    dong = " ".join(addr.split()[:3])  # 마지막 수단: 동 단위 위치
    for url, query in ((KAKAO_ADDR_URL, q), (KAKAO_KEYWORD_URL, f"{gu} {nm}"), (KAKAO_KEYWORD_URL, nm),
                       (KAKAO_ADDR_URL, dong)):
        docs = requests.get(url, params={"query": query}, headers=h, timeout=20).json().get("documents", [])
        if docs:
            return round(float(docs[0]["y"]), 6), round(float(docs[0]["x"]), 6)
    return "", ""


def main():
    load_dotenv(ROOT / ".env")
    key = (os.environ.get("SERVICE_KEY") or "").strip()
    key = unquote(key) if "%" in key else key
    kakao = (os.environ.get("KAKAO_KEY") or "").strip()

    old = {(r["구분"], r["주택관리번호"]): r for r in read_csv(OUT)}
    types = read_csv(TYPES)
    have_types = {r["주택관리번호"] for r in types}

    out = {}
    for kind, (list_ep, type_ep) in KINDS.items():
        try:
            items = get_all(key, list_ep, {"cond[SUBSCRPT_AREA_CODE_NM::EQ]": "서울"})
        except PermissionError:
            sys.exit("❌ 청약홈 API 인증 실패 — '한국부동산원_청약홈 분양정보 조회 서비스' 활용신청 확인 필요")
        for it in items:
            no = d(it.get("HOUSE_MANAGE_NO"))
            addr = d(it.get("HSSPLY_ADRES"))
            prev = old.get((kind, no), {})
            row = {
                "구분": kind, "주택관리번호": no, "공고번호": d(it.get("PBLANC_NO")), "단지명": d(it.get("HOUSE_NM")),
                "주소": addr, "구": addr.split()[1] if len(addr.split()) > 1 else "",
                "공급세대수": d(it.get("TOT_SUPLY_HSHLDCO")), "민영국민": d(it.get("HOUSE_DTL_SECD_NM")) or d(it.get("HOUSE_SECD_NM")),
                "모집공고일": d(it.get("RCRIT_PBLANC_DE")),
                "특공접수일": d(it.get("SPSPLY_RCEPT_BGNDE")),
                "1순위해당지역": d(it.get("GNRL_RNK1_CRSPAREA_RCPTDE")),
                "1순위기타지역": d(it.get("GNRL_RNK1_ETC_AREA_RCPTDE")),
                "2순위": d(it.get("GNRL_RNK2_CRSPAREA_RCPTDE")),
                "접수시작": d(it.get("RCEPT_BGNDE") or it.get("SUBSCRPT_RCEPT_BGNDE") or it.get("GNRL_RCEPT_BGNDE")),
                "접수종료": d(it.get("RCEPT_ENDDE") or it.get("SUBSCRPT_RCEPT_ENDDE") or it.get("GNRL_RCEPT_ENDDE")),
                "당첨자발표일": d(it.get("PRZWNER_PRESNATN_DE")),
                "계약시작": d(it.get("CNTRCT_CNCLS_BGNDE")), "계약종료": d(it.get("CNTRCT_CNCLS_ENDDE")),
                "입주예정월": d(it.get("MVN_PREARNGE_YM")),
                "분양가상한제": d(it.get("PARCPRC_ULS_AT")), "투기과열지구": d(it.get("SPECLT_RDN_EARTH_AT")),
                "조정대상지역": d(it.get("MDAT_TRGET_AREA_SECD")),
                "시공사": d(it.get("CNSTRCT_ENTRPS_NM")), "시행사": d(it.get("BSNS_MBY_NM")),
                "홈페이지": d(it.get("HMPG_ADRES")), "공고URL": d(it.get("PBLANC_URL")),
                "위도": prev.get("위도", ""), "경도": prev.get("경도", ""),
            }
            if not row["위도"] and kakao and addr:
                row["위도"], row["경도"] = geocode(kakao, addr, row["단지명"])
                time.sleep(0.05)
            out[(kind, no)] = row

            if no not in have_types:  # 주택형별 분양가 — 공고 내용은 바뀌지 않으므로 한 번만
                for t in get_all(key, type_ep, {"cond[HOUSE_MANAGE_NO::EQ]": no}):
                    ty = d(t.get("HOUSE_TY"))
                    m = re.match(r"0*(\d+(?:\.\d+)?)", ty)
                    types.append({
                        "주택관리번호": no, "공고번호": d(t.get("PBLANC_NO")), "주택형": ty,
                        "전용면적": round(float(m.group(1)), 2) if m else "",
                        "공급면적": d(t.get("SUPLY_AR")), "일반공급세대": d(t.get("SUPLY_HSHLDCO")),
                        "특별공급세대": d(t.get("SPSPLY_HSHLDCO")), "최고분양가": d(t.get("LTTOT_TOP_AMOUNT")),
                    })
                have_types.add(no)
                time.sleep(0.05)

    write_csv(OUT, FIELDS, sorted(out.values(), key=lambda r: (r["모집공고일"], r["주택관리번호"]), reverse=True))
    write_csv(TYPES, TYPE_FIELDS, types)
    print(f"✅ 서울 청약 공고 {len(out):,}건 (주택형 {len(types):,}개) 저장")

    # 경쟁률·당첨가점 (일반분양만, '청약접수 경쟁률 및 특별공급 신청현황 조회 서비스')
    #  - 접수가 끝난 공고만 조회. 접수 후 60일 안의 공고는 매일 다시 받고, 그보다 오래된 공고는 한 번만 받음
    cm_rows, sc_rows = read_csv(CMPET), read_csv(SCORE)
    have = {r["주택관리번호"] for r in cm_rows}
    today = time.strftime("%Y-%m-%d")
    recent = time.strftime("%Y-%m-%d", time.localtime(time.time() - 60 * 86400))
    todo = [r for r in out.values() if r["구분"] == "APT" and r["접수종료"] and r["접수종료"] < today
            and (r["주택관리번호"] not in have or r["접수종료"] >= recent)]
    try:
        for r in todo:
            no = r["주택관리번호"]
            cond = {"cond[HOUSE_MANAGE_NO::EQ]": no}
            cm = get_all(key, "ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet", cond)
            sc = get_all(key, "ApplyhomeInfoCmpetRtSvc/v1/getAptLttotPblancScore", cond)
            cm_rows = [x for x in cm_rows if x["주택관리번호"] != no] + [{
                "주택관리번호": no, "공고번호": d(c.get("PBLANC_NO")), "주택형": d(c.get("HOUSE_TY")),
                "순위": d(c.get("SUBSCRPT_RANK_CODE")), "거주지역": d(c.get("RESIDE_SENM")),
                "공급세대": d(c.get("SUPLY_HSHLDCO")), "접수건수": d(c.get("REQ_CNT")), "경쟁률": d(c.get("CMPET_RATE")),
            } for c in cm] or [{"주택관리번호": no}]   # 결과가 없어도 조회했다는 표시
            sc_rows = [x for x in sc_rows if x["주택관리번호"] != no] + [{
                "주택관리번호": no, "주택형": d(s.get("HOUSE_TY")), "거주지역": d(s.get("RESIDE_SENM")),
                "최저가점": d(s.get("LWET_SCORE")), "평균가점": d(s.get("AVRG_SCORE")), "최고가점": d(s.get("TOP_SCORE")),
            } for s in sc]
            time.sleep(0.05)
        write_csv(CMPET, CMPET_FIELDS, cm_rows)
        write_csv(SCORE, SCORE_FIELDS, sc_rows)
        print(f"✅ 경쟁률·가점 {len(todo)}개 공고 갱신")
    except PermissionError:
        print("ℹ️  경쟁률 API 미승인 — 건너뜀 ('청약접수 경쟁률 및 특별공급 신청현황 조회 서비스' 활용신청 시 자동 수집)")


if __name__ == "__main__":
    main()
