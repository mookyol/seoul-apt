// 오프라인·빠른 로딩용: 화면 파일은 캐시, 데이터는 항상 최신 우선
const CACHE = "seoul-apt-v28";
const SHELL = ["./", "index.html", "app.css", "app.js", "cloud.js", "config.js", "manifest.webmanifest", "icon.svg",
  "static/subway.json", "static/seoul_gu.geojson"];

self.addEventListener("install", (e) => {
  // cache: "reload" = 브라우저 HTTP 캐시를 건너뛰고 서버에서 새로 받아 저장
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  // 네트워크 우선 → 실패 시 캐시 (오프라인에서도 마지막으로 본 화면 유지)
  // cache: "no-cache" = 브라우저 HTTP 캐시(GitHub Pages 최대 10분)를 쓰지 말고 서버에 최신인지 확인 → 업데이트가 바로 보임
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
