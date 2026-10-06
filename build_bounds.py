"""
단지 경계(구획) — OpenStreetMap 주거지 다각형을 단지 좌표와 맞춰 site/static/bounds.json 생성

  · OSM landuse=residential (서울 약 5,000개, 그중 residential=apartments 약 2,900개)
  · 단지 좌표가 들어가는 다각형 중 가장 작은 것. 단, 이름 없는 다각형이 여러 단지를 품으면 동네 전체로 보고 제외
  · 좌표가 살짝 밖이면 60m 안의 같은 이름 다각형까지 허용
  · 경계 데이터: © OpenStreetMap contributors (ODbL)

사용법: python build_bounds.py   (가끔 수동 실행 — OSM이 갱신되면 다시. 결과 파일은 저장소에 커밋)
"""
import json
import re
import sys
from pathlib import Path

import requests
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).parent
OUT = ROOT / "site" / "static" / "bounds.json"
CACHE = ROOT / "data" / "network" / "osm_residential.json"
QUERY = '[out:json][timeout:300];(way["landuse"="residential"](37.42,126.76,37.71,127.19);' \
        'relation["landuse"="residential"](37.42,126.76,37.71,127.19););out geom;'
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
M_LAT, M_LNG = 111_000, 88_200          # 서울 위도에서 1도 ≈ m


def fetch():
    if CACHE.exists() and "--refresh" not in sys.argv:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    for url in MIRRORS:
        try:
            r = requests.post(url, data={"data": QUERY}, timeout=400,
                              headers={"User-Agent": "seoul-apt/1.0 (github.com/mookyol/seoul-apt)"})
            d = r.json()
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
            return d
        except Exception as e:  # noqa: BLE001 — 미러 하나가 바쁘면 다음 미러
            print("  Overpass 실패:", url, e)
    raise SystemExit("❌ Overpass 서버 응답 없음")


def polygons(elements):
    out = []
    for e in elements:
        tags = e.get("tags", {})
        rings = []
        if e["type"] == "way" and len(e.get("geometry", [])) >= 4:
            rings = [e["geometry"]]
        elif e["type"] == "relation":
            rings = [m["geometry"] for m in e.get("members", [])
                     if m.get("role") == "outer" and len(m.get("geometry", [])) >= 4
                     and m["geometry"][0] == m["geometry"][-1]]
        for g in rings:
            try:
                p = Polygon([(q["lon"], q["lat"]) for q in g])
                if not p.is_valid:
                    p = p.buffer(0)
                if p.is_empty or p.geom_type != "Polygon":
                    continue
            except Exception:  # noqa: BLE001
                continue
            area = p.area * M_LNG * M_LAT                    # 도² → ㎡ (서울 위도 근사)
            out.append({"poly": p, "name": tags.get("name", ""), "apt": tags.get("residential") == "apartments", "area": area})
    return out


def norm(s):
    s = re.sub(r"\(.*?\)", "", s or "")
    s = re.sub(r"(아파트|APT|\d+\s*단지|\d+\s*차)$", "", s.strip(), flags=re.I)
    return s.replace(" ", "").lower()


def main():
    polys = polygons(fetch()["elements"])
    tree = STRtree([p["poly"] for p in polys])
    items = json.loads((ROOT / "site" / "data" / "complexes.json").read_text(encoding="utf-8"))["items"]
    pts = [(i, Point(i["lo"], i["la"])) for i in items if i.get("la")]
    # 다각형마다 몇 개 단지 좌표를 품나 (이름 없는 '동네 전체' 다각형 걸러내기)
    holds = [0] * len(polys)
    for _, pt in pts:
        for k in tree.query(pt, predicate="within"):
            holds[k] += 1

    bounds, how = {}, {"포함": 0, "이름+근접": 0}
    for i, pt in pts:
        nm = norm(i["n"])
        named = lambda p: p["name"] and nm and (norm(p["name"]) in nm or nm in norm(p["name"]))
        cands = []
        for k in tree.query(pt, predicate="within"):
            p = polys[k]
            if p["area"] > 800_000 or p["area"] < 1_500:
                continue
            if not named(p) and holds[k] > 2 and not (p["apt"] and p["area"] < 150_000):
                continue                                   # 여러 단지를 품은 이름 없는 큰 구역 = 동네
            cands.append((0 if named(p) else 1, p["area"], k))
        if cands:
            k = min(cands)[2]
            how["포함"] += 1
        else:                                              # 좌표가 경계 밖 60m 이내 + 이름 일치
            near = [(polys[k]["poly"].distance(pt), k) for k in tree.query(pt.buffer(0.0007))
                    if named(polys[k]) and polys[k]["area"] < 800_000]
            near = [(d, k) for d, k in near if d * M_LAT <= 60]
            if not near:
                continue
            k = min(near)[1]
            how["이름+근접"] += 1
        g = polys[k]["poly"].simplify(0.00003, preserve_topology=True)
        bounds[i["c"]] = [[round(y, 5), round(x, 5)] for x, y in g.exterior.coords]
    OUT.write_text(json.dumps(bounds, separators=(",", ":")), encoding="utf-8")
    big = sum(1 for i in items if (i.get("h") or 0) >= 300)
    big_ok = sum(1 for i in items if (i.get("h") or 0) >= 300 and i["c"] in bounds)
    print(f"✅ 단지 경계 {len(bounds):,}개 ({how}) · 300세대 이상 {big_ok:,}/{big:,} · {OUT.stat().st_size / 1e6:.1f}MB")


if __name__ == "__main__":
    main()
