"""
서울 아파트 매매 실거래가 수집기

사용법:
  python collect_trades.py 202608              # 한 달만
  python collect_trades.py 201601 202609       # 기간 (이미 받은 달은 건너뜀)
  python collect_trades.py --recent            # 최근 3개월 다시 받기 (매일 자동 실행용)
  python collect_trades.py 202608 --force      # 이미 받은 달도 다시 받기

저장 방식:
  data/trades/YYYYMM.csv  ← 계약월 하나 = 파일 하나 (서울 25개 구 전체)
  같은 달을 다시 받으면 파일을 통째로 새로 씀 → 중복이 원천적으로 생기지 않음
  (예전 구글시트의 중복 문제 해결 방식)
"""
import csv
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from urllib.parse import unquote

import requests
from dotenv import load_dotenv

API_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev"
DATA_DIR = Path(__file__).parent / "data" / "trades"

# 서울 25개 구 (LAWD_CD 5자리)
GU_CODES = {
    "종로구": "11110", "중구": "11140", "용산구": "11170", "성동구": "11200",
    "광진구": "11215", "동대문구": "11230", "중랑구": "11260", "성북구": "11290",
    "강북구": "11305", "도봉구": "11320", "노원구": "11350", "은평구": "11380",
    "서대문구": "11410", "마포구": "11440", "양천구": "11470", "강서구": "11500",
    "구로구": "11530", "금천구": "11545", "영등포구": "11560", "동작구": "11590",
    "관악구": "11620", "서초구": "11650", "강남구": "11680", "송파구": "11710",
    "강동구": "11740",
}

# CSV 열: (저장할 이름, API 태그)
FIELDS = [
    ("구", None),
    ("시군구코드", "sggCd"),
    ("법정동코드", "umdCd"),       # 시군구코드 + 법정동코드 = 10자리 bjdCode
    ("법정동", "umdNm"),
    ("지번", "jibun"),
    ("단지코드", "aptSeq"),        # 단지 고유번호 → 이름 매칭 문제 해결
    ("아파트명", "aptNm"),
    ("동", "aptDong"),
    ("전용면적", "excluUseAr"),
    ("층", "floor"),
    ("건축년도", "buildYear"),
    ("거래금액", "dealAmount"),    # 만원
    ("계약일", None),
    ("해제여부", "cdealType"),     # "O"면 취소된 거래
    ("해제일", "cdealDay"),
    ("거래유형", "dealingGbn"),    # 중개거래/직거래
    ("매수자", "buyerGbn"),
    ("매도자", "slerGbn"),
    ("등기일", "rgstDate"),
]


def load_key():
    load_dotenv(Path(__file__).parent / ".env")
    key = (os.environ.get("SERVICE_KEY") or "").strip()
    if not key:
        sys.exit("❌ SERVICE_KEY가 비어 있습니다. .env 파일에 키를 넣고 저장해주세요.")
    # Encoding 키(%2B 등 포함)를 넣었어도 동작하도록 원래 형태로 되돌림
    return unquote(key) if "%" in key else key


def fetch_page(key, lawd_cd, ym, page, retries=3):
    params = {"serviceKey": key, "LAWD_CD": lawd_cd, "DEAL_YMD": ym,
              "numOfRows": 1000, "pageNo": page}
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(API_URL, params=params, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.content)
            code = root.findtext(".//resultCode")
            if code not in ("00", "000"):
                msg = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or r.text[:200]
                raise RuntimeError(f"API 오류 {code}: {msg}")
            return root
        except Exception as e:
            if attempt == retries:
                raise
            print(f"    재시도 {attempt}/{retries - 1} ({e})")
            time.sleep(2 * attempt)


def fetch_gu_month(key, gu, lawd_cd, ym):
    rows, page = [], 1
    while True:
        root = fetch_page(key, lawd_cd, ym, page)
        items = root.findall(".//item")
        for it in items:
            row = {}
            for name, tag in FIELDS:
                if tag:
                    row[name] = (it.findtext(tag) or "").strip()
            row["구"] = gu
            row["거래금액"] = row["거래금액"].replace(",", "")
            y, m, d = it.findtext("dealYear"), it.findtext("dealMonth"), it.findtext("dealDay")
            row["계약일"] = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
            rows.append(row)
        total = int(root.findtext(".//totalCount") or 0)
        if page * 1000 >= total or not items:
            return rows, total
        page += 1


def collect_month(key, ym):
    all_rows = []
    for gu, code in GU_CODES.items():
        rows, total = fetch_gu_month(key, gu, code, ym)
        if len(rows) != total:
            raise RuntimeError(f"{gu} {ym}: API 총건수 {total} ≠ 받은 건수 {len(rows)}")
        all_rows.extend(rows)
        time.sleep(0.1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{ym}.csv"
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=[n for n, _ in FIELDS])
        w.writeheader()
        w.writerows(all_rows)
    tmp.replace(path)  # 다 받은 뒤에만 교체 → 중간에 끊겨도 기존 파일 안전
    cancelled = sum(1 for r in all_rows if r["해제여부"] == "O")
    print(f"✅ {ym}: {len(all_rows):,}건 저장 (취소거래 {cancelled}건 포함) → {path.name}")


def month_range(start, end):
    y, m = int(start[:4]), int(start[4:])
    while f"{y:04d}{m:02d}" <= end:
        yield f"{y:04d}{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def recent_months(n=3):
    """이번 달 포함 최근 n개월 (신고기한 30일 + 취소 반영 때문에 최근 달은 계속 갱신)"""
    t = date.today()
    y, m, out = t.year, t.month, []
    for _ in range(n):
        out.append(f"{y:04d}{m:02d}")
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return sorted(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    if "--recent" in sys.argv:
        months, force = recent_months(), True
    elif len(args) == 1:
        months = [args[0]]
        force = True  # 한 달 지정 시엔 항상 새로 받음
    elif len(args) == 2:
        months = list(month_range(args[0], args[1]))
    else:
        sys.exit(__doc__)

    key = load_key()
    for ym in months:
        if not force and (DATA_DIR / f"{ym}.csv").exists():
            print(f"⏭  {ym}: 이미 있음, 건너뜀")
            continue
        collect_month(key, ym)


if __name__ == "__main__":
    main()
