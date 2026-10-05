"""
대중교통 출근 시간 (지하철·광역철도 기준 근사) — data/network/subway_graph.json 사용

  단지 → (도보 또는 마을버스) → 승차역 → (노선·환승) → 업무지구 역 → 도보 = 출근 시간(분)

  가정
    - 도보: 직선거리 × 1.25(골목 굴곡) ÷ 4.5km/h
    - 역이 1.2km보다 멀면 버스 연계도 고려: 직선 × 1.3 ÷ 15km/h + 버스 대기 6분
    - 첫 승차 대기 4분, 환승 5~6분, 업무지구 역에서 사무실까지 도보 5분
    - 업무지구 1.5km 안이면 걸어가는 경우도 비교
"""
import heapq
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent
HUBS = {   # 업무지구: (중심 좌표, 도착 역들)
    "광화문": ((37.5711, 126.9768), ["광화문", "시청", "종각", "을지로입구", "경복궁"]),
    "강남": ((37.4979, 127.0276), ["강남", "역삼", "선릉", "신논현", "삼성", "교대"]),
    "여의도": ((37.5216, 126.9242), ["여의도", "여의나루", "국회의사당", "샛강"]),
    "판교": ((37.3948, 127.1112), ["판교"]),
    "마곡": ((37.5602, 126.8254), ["마곡나루", "마곡", "발산"]),
    "성수": ((37.5446, 127.0559), ["성수", "뚝섬", "서울숲"]),
    "가산·구로": ((37.4816, 126.8826), ["가산디지털단지", "구로디지털단지"]),
}
WALK_KMH, BUS_KMH = 4.5, 15.0
BOARD_WAIT, EGRESS, BUS_WAIT = 4.0, 5.0, 7.0


def km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


class Commute:
    def __init__(self, path=ROOT / "data" / "network" / "subway_graph.json"):
        g = json.loads(Path(path).read_text(encoding="utf-8"))
        self.nodes = g["nodes"]
        self.adj = [[] for _ in self.nodes]
        for a, b, t in g["edges"] + g["transfers"]:
            self.adj[a].append((b, t))
            self.adj[b].append((a, t))
        # 업무지구별: 모든 역 → 업무지구까지 분 (다익스트라, 도착 역에서 시작해 거꾸로)
        self.to_hub = {h: self._dijkstra([i for i, n in enumerate(self.nodes) if n["name"] in names])
                       for h, (_, names) in HUBS.items()}

    def _dijkstra(self, sources):
        dist = [math.inf] * len(self.nodes)
        pq = [(EGRESS, s) for s in sources]
        for _, s in pq:
            dist[s] = EGRESS
        heapq.heapify(pq)
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, t in self.adj[u]:
                if d + t < dist[v]:
                    dist[v] = d + t
                    heapq.heappush(pq, (d + t, v))
        return dist

    def times(self, lat, lon):
        """업무지구별 출근 시간(분)과 이용 역"""
        cand = []
        for i, n in enumerate(self.nodes):
            if abs(n["lat"] - lat) > 0.04 or abs(n["lon"] - lon) > 0.05:
                continue
            d = km((lat, lon), (n["lat"], n["lon"]))
            walk = d * 1.25 / WALK_KMH * 60
            access = walk if d <= 1.2 else min(walk, d * 1.3 / BUS_KMH * 60 + BUS_WAIT)
            if d <= 4:
                cand.append((access + BOARD_WAIT, i))
        out = {}
        for h, ((hla, hlo), _) in HUBS.items():
            best = min(((a + self.to_hub[h][i], i) for a, i in cand), default=(math.inf, None))
            dh = km((lat, lon), (hla, hlo))
            if dh <= 1.5:   # 업무지구 안이면 걸어서
                best = min(best, (dh * 1.25 / WALK_KMH * 60, None))
            out[h] = (round(best[0]) if best[0] < math.inf else None,
                      self.nodes[best[1]]["name"] if best[1] is not None else "도보")
        return out


if __name__ == "__main__":
    c = Commute()
    tests = {"잠실엘스": (37.5113, 127.0815), "노원 상계주공7": (37.6555, 127.0628), "마포래미안푸르지오": (37.5534, 126.9563),
             "목동 신시가지7": (37.5310, 126.8770), "헬리오시티": (37.4972, 127.1077), "은평뉴타운": (37.6370, 126.9210)}
    for name, (la, lo) in tests.items():
        t = c.times(la, lo)
        print(f"{name}: " + " · ".join(f"{h} {m}분({s})" for h, (m, s) in t.items()))
