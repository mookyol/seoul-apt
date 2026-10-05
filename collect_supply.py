"""
서울 아파트 분양·입주 예정 물량 수집 — data/supply.csv

출처: 한국부동산원 청약홈 분양정보 조회 서비스 (공공데이터포털 활용신청 필요)
  - 공급세대수는 "일반분양" 세대수입니다. 재건축·재개발은 조합원 물량이 빠져 실제 입주 세대보다 적습니다.

사용법: python collect_supply.py
"""
import csv
import os
import sys
import time
from pathlib import Path
from urllib.parse import unquote

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "supply.csv"
API_URL = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail"
KAKAO_ADDR_URL = "https://dapi.kakao.com/v2/local/search/address.json"
KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"

FIELDS = ["주택관리번호", "단지명", "주소", "구", "공급세대수", "모집공고일", "입주예정월", "시공사", "위도", "경도"]


def main():
    load_dotenv(ROOT / ".env")
    key = (os.environ.get("SERVICE_KEY") or "").strip()
    key = unquote(key) if "%" in key else key
    kakao = (os.environ.get("KAKAO_KEY") or "").strip()

    old = {}
    if OUT.exists():
        with open(OUT, encoding="utf-8-sig") as f:
            old = {r["주택관리번호"]: r for r in csv.DictReader(f)}

    rows, page = [], 1
    while True:
        r = requests.get(API_URL, params={"serviceKey": key, "page": page, "perPage": 500,
                                          "cond[SUBSCRPT_AREA_CODE_NM::EQ]": "서울"}, timeout=60)
        if r.status_code == 401:
            sys.exit("❌ 청약홈 API 인증 실패 — 공공데이터포털에서 '한국부동산원_청약홈 분양정보 조회 서비스' 활용신청 확인 필요")
        r.raise_for_status()
        body = r.json()
        rows += body.get("data", [])
        if page * 500 >= int(body.get("matchCount") or body.get("totalCount") or 0) or not body.get("data"):
            break
        page += 1

    out = {}
    for it in rows:
        no = str(it.get("HOUSE_MANAGE_NO", ""))
        addr = it.get("HSSPLY_ADRES") or ""
        prev = old.get(no, {})
        row = {
            "주택관리번호": no, "단지명": it.get("HOUSE_NM", ""), "주소": addr,
            "구": addr.split()[1] if len(addr.split()) > 1 else "",
            "공급세대수": it.get("TOT_SUPLY_HSHLDCO") or "",
            "모집공고일": it.get("RCRIT_PBLANC_DE") or "",
            "입주예정월": str(it.get("MVN_PREARNGE_YM") or ""),
            "시공사": it.get("CNSTRCT_ENTRPS_NM") or "",
            "위도": prev.get("위도", ""), "경도": prev.get("경도", ""),
        }
        if not row["위도"] and kakao and addr:  # 처음 보는 단지만 좌표 조회
            h = {"Authorization": "KakaoAK " + kakao}
            docs = requests.get(KAKAO_ADDR_URL, params={"query": addr}, headers=h, timeout=20).json().get("documents", [])
            if not docs:
                docs = requests.get(KAKAO_KEYWORD_URL, params={"query": row["단지명"]}, headers=h,
                                    timeout=20).json().get("documents", [])
            if docs:
                row["위도"], row["경도"] = round(float(docs[0]["y"]), 6), round(float(docs[0]["x"]), 6)
            time.sleep(0.05)
        out[no] = row

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(out.values(), key=lambda r: (r["입주예정월"], r["주택관리번호"])))
    print(f"✅ 서울 분양 단지 {len(out):,}개 저장 → {OUT.name}")


if __name__ == "__main__":
    main()
