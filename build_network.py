"""
수도권 지하철·광역철도 노선망 만들기 (OpenStreetMap 기반, 무료)

  입력: data/network/osm_routes.json (노선 relation), data/network/osm_stops.json (정차역 이름·좌표)
        — Overpass API로 받음 (README 참고). 노선이 새로 개통되면 다시 받아서 이 스크립트를 재실행
  출력: data/network/subway_graph.json  출근시간 계산용 그래프 (역·구간 소요시간·환승)
        site/static/subway.json          지도용 노선·역 (색상, 좌표)

사용법: python build_network.py
"""
import json
import math
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
NET = ROOT / "data" / "network"

# 출퇴근과 무관한 장거리·관광 열차는 제외
EXCLUDE = ["KTX", "ITX", "무궁화", "새마을", "월미", "교외선", "장항선", "호남선", "전라선", "강릉선", "경부선 (", "직통열차"]
# 노선별 표정속도(정차 포함 평균 속도, km/h) — 실제 운행 시간표 기준 근사
SPEED = [("광역급행철도", 80), ("신분당", 55), ("공항철도", 50), ("급행", 45), ("경의·중앙", 42), ("경춘", 42),
         ("서해", 45), ("수인·분당", 36), ("경강", 42), ("", 31)]
COLORS = {"1": "#0052A4", "2": "#00A84D", "3": "#EF7C1C", "4": "#00A5DE", "5": "#996CAC", "6": "#CD7C2F",
          "7": "#747F00", "8": "#E6186C", "9": "#BDB092", "경의·중앙": "#77C4A3", "수인·분당": "#F5A200",
          "신분당": "#D4003B", "공항철도": "#0090D2", "경춘": "#0C8E72", "광역급행철도": "#9A6292", "서해": "#8FC31F",
          "경강": "#0054A6", "우이신설": "#B0CE18", "신림": "#6789CA", "김포": "#AD8605", "의정부": "#FDA600",
          "용인": "#509F22", "인천 도시철도 1": "#7CA8D5", "인천 도시철도 2": "#ED8B00"}


def km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def norm(name):
    name = re.sub(r"\(.*?\)", "", name or "").strip()
    return re.sub(r"역$", "", name).replace(" ", "")


def line_of(tags):
    """노선 식별자: 1~9호선은 번호, 나머지는 노선 이름 앞부분 (방향·계통 구분 없이 묶음)"""
    fam = (tags.get("name") or "").split(":")[0]
    fam = re.sub(r"(수도권 전철|서울 지하철|서울 경전철|수도권 )\s*", "", fam).strip()
    m = re.match(r"(\d)호선", fam)
    if m and "인천" not in fam:
        return m.group(1)
    for k in COLORS:
        if k in fam:
            return k
    return fam


def main():
    routes = json.loads((NET / "osm_routes.json").read_text(encoding="utf-8"))["elements"]
    stops = {e["id"]: e for e in json.loads((NET / "osm_stops.json").read_text(encoding="utf-8"))["elements"]
             if e["type"] == "node" and e.get("tags", {}).get("name")}

    nodes, index = [], {}            # 그래프 노드 = (노선, 역 이름) — 방향·승강장 구분 없이 하나로
    pos = defaultdict(list)
    edges = {}
    segs = defaultdict(set)          # 지도용 노선 구간
    for r in routes:
        if r["type"] != "relation":
            continue
        name = r["tags"].get("name", "")
        if any(x in name for x in EXCLUDE):
            continue
        line = line_of(r["tags"])
        speed = next(v for k, v in SPEED if k in name)
        seq = [m["ref"] for m in r["members"] if m["type"] == "node" and m["role"].startswith("stop") and m["ref"] in stops]
        prev = None
        for sid in seq:
            s = stops[sid]
            key = (line, norm(s["tags"]["name"]))
            if key not in index:
                index[key] = len(nodes)
                nodes.append(key)
            i = index[key]
            pos[i].append((s["lat"], s["lon"]))
            if prev is not None and prev != i:
                d = km(pos[prev][-1], pos[i][-1]) * 1.1                      # 선로 굴곡 보정
                t = max(1.8, d / speed * 60)
                a, b = min(prev, i), max(prev, i)
                edges[(a, b)] = min(edges.get((a, b), 1e9), t)
                segs[line].add((a, b))
            prev = i

    coord = {i: (sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)) for i, ps in pos.items()}
    # 환승: 같은 역 이름(다른 노선) 5분, 이름이 달라도 250m 안이면 6분 (예: 총신대입구·이수)
    transfers = {}
    by_name = defaultdict(list)
    for i, (line, nm) in enumerate(nodes):
        by_name[nm].append(i)
    for ids in by_name.values():
        for a in ids:
            for b in ids:
                if a < b:
                    transfers[(a, b)] = 5.0
    ids = list(coord)
    for x in range(len(ids)):
        for y in range(x + 1, len(ids)):
            a, b = ids[x], ids[y]
            if nodes[a][0] != nodes[b][0] and (min(a, b), max(a, b)) not in transfers \
                    and abs(coord[a][0] - coord[b][0]) < 0.003 and km(coord[a], coord[b]) <= 0.25:
                transfers[(min(a, b), max(a, b))] = 6.0

    graph = {
        "nodes": [{"line": l, "name": n, "lat": round(coord[i][0], 6), "lon": round(coord[i][1], 6)}
                  for i, (l, n) in enumerate(nodes)],
        "edges": [[a, b, round(t, 2)] for (a, b), t in edges.items()],
        "transfers": [[a, b, t] for (a, b), t in transfers.items()],
    }
    (NET / "subway_graph.json").write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")

    # 지도용: 노선별 색 구간 + 역(이름별로 합침, 지나는 노선 목록)
    st = defaultdict(lambda: {"lines": set(), "pts": []})
    for i, (line, nm) in enumerate(nodes):
        st[nm]["lines"].add(line)
        st[nm]["pts"].append(coord[i])
    out = {
        "lines": [{"line": l, "color": COLORS.get(l, "#888888"),
                   "segs": [[[round(coord[a][0], 5), round(coord[a][1], 5)], [round(coord[b][0], 5), round(coord[b][1], 5)]]
                            for a, b in sorted(s)]} for l, s in segs.items()],
        "stations": [{"n": nm, "la": round(sum(p[0] for p in v["pts"]) / len(v["pts"]), 5),
                      "lo": round(sum(p[1] for p in v["pts"]) / len(v["pts"]), 5),
                      "c": [COLORS.get(l, "#888888") for l in sorted(v["lines"])]} for nm, v in st.items()],
    }
    (ROOT / "site" / "static").mkdir(parents=True, exist_ok=True)
    (ROOT / "site" / "static" / "subway.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    lines = sorted({l for l, _ in nodes})
    print(f"✅ 노선망: 노선 {len(lines)}개, 역 노드 {len(nodes):,}개, 구간 {len(edges):,}개, 환승 {len(transfers):,}개")
    print("   노선:", ", ".join(lines))


if __name__ == "__main__":
    main()
