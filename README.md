# 서울 아파트 투자 입지 분석

국토교통부 아파트 매매 실거래가(공공데이터포털)를 매일 자동 수집해 투자 입지를 분석하는 개인 프로젝트입니다.

- `collect.py` — 실거래 수집기 (매매 `data/trades/`, 전월세 `data/rent/`, 계약월별 1파일)
- `collect_subscription.py` — 청약홈 공고·일정·주택형별 분양가 (일반분양 + 무순위)
- `.github/workflows/collect.yml` — 매일 새벽 3시(KST) 최근 3개월 자동 갱신

데이터 출처: 국토교통부 실거래가 공개시스템 / 공공데이터포털. 본 자료는 투자 권유가 아닙니다.

## 지도·노선 데이터 출처
- 지하철·광역철도 노선과 역: © OpenStreetMap contributors (ODbL) — `build_network.py`로 가공 (`data/network/subway_graph.json`)
- 배경지도: OpenFreeMap / OpenMapTiles / OpenStreetMap
- 서울 구 경계: southkorea/seoul-maps (Apache 2.0, 통계청 2013 경계)
