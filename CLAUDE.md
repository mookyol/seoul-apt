# 서울 아파트 입지 분석 (seoul-apt)

서울 실거주 + 자산증식 관점의 아파트 입지 분석 웹앱. 사용자(코딩 초보, 한국어)와 지인들이 함께 씀.
사이트: https://mookyol.github.io/seoul-apt/ (GitHub Pages, PWA)

## 사용자와 일하는 방식
- 한국어로, 쉬운 말로 설명. 한 번에 한 단계씩. 판단 기준을 바꿀 땐 이유를 설명
- API 키를 채팅에 붙여넣게 하지 않기 (GitHub Secrets: SERVICE_KEY, KAKAO_KEY)
- 투자 권유 표현 금지. 점수는 참고 지표라는 점을 유지 (백테스트 결과 '모델보다 싼 단지'는 매수 신호가 아님)

## 구조
| 단계 | 파일 | 실행 |
|---|---|---|
| 수집 | `collect.py` (매매·전월세, 월별 CSV `data/trades`, `data/rent`), `collect_subscription.py` (청약홈) | `.github/workflows/collect.yml` 매일 03시 KST |
| 단지 정보 | `build_complexes.py` → `data/complexes.csv` (좌표·역·K-apt 세대수·학교·학원·용적률) | collect.yml 안에서 25분 단위 저장 |
| 노선망 | `build_network.py` (OSM → `data/network/subway_graph.json`), `commute.py` (출근 시간) | 노선 개통 시 수동 |
| 모델 | `value_model.py` (정제·보정 시세·하락방어력·출근접근성), `fair_value.py` (LightGBM 적정가, 공간CV), `backtest.py` (성적표) | `.github/workflows/site.yml` 배포 때 |
| 웹 데이터 | `build_site.py` → `site/data/` (gitignore, 배포 때 생성) | site.yml |
| 웹앱 | `site/index.html`, `app.js`, `app.css`, `cloud.js`(Supabase), `sw.js` | GitHub Pages |
| 뉴스 | `data/news/YYYY-MM-DD.json` (형식은 `data/news/README.md`) | Claude 예약 작업 매일 07시 |

- 웹앱 짧은 키(complexes.json): c 단지코드, n 이름, al 별칭, g 구, d 동, la/lo 좌표, h 세대수, p 평당가, p84/j84 84㎡ 매매/전세, r1/r3 상승률, ls 입지점수(앱에서 계산), ct 업무지구별 출근분, dg 방어등급, far 용적률, lt 최근 거래 등 — `build_site.py`의 summary 참고
- 로그인·리마크·관심단지: Supabase (`supabase/schema.sql`, RLS). 공개 키는 `site/config.js`

## 주의
- 워크플로 checkout은 `ref: main` 유지 (대기 중이던 실행이 옛 데이터로 시작해 충돌난 적 있음)
- 웹앱 수정 후 `site/sw.js`의 CACHE 버전을 올려야 사용자에게 바로 반영됨
- 공공데이터 API 버전이 자주 바뀜: K-apt는 AptListService4 / AptBasisInfoServiceV5
- 로컬 테스트: `python build_site.py` 후 `python -m http.server 8765 -d site`
