// 서울 아파트 입지 — 웹앱
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const state = { items: [], byCode: {}, meta: {}, map: null, layer: null, supLayer: null, supply: null, chart: null, cmpChart: null };

// ---------- 저장 (지금은 이 기기에만 — 로그인 붙이면 서버 저장으로 교체) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const favs = () => store.get("favs", []);
const isFav = (c) => favs().includes(c);
const toggleFav = (c) => {
  const on = !isFav(c);
  store.set("favs", on ? [...favs(), c] : favs().filter((x) => x !== c));
  cloud.setFav(c, on);
};
const memo = (c) => store.get("memo:" + c, "");
const cmps = () => store.get("cmp", []);
const inCmp = (c) => cmps().includes(c);
const seen = () => store.get("seen", {});
const isNew = (i) => isFav(i.c) && seen()[i.c] && i.last > seen()[i.c];

// ---------- 표시 형식 ----------
function won(man) {            // 만원 → "12억 3,000"
  if (man == null) return "–";
  const sign = man < 0 ? "-" : ""; man = Math.abs(man);
  const eok = Math.floor(man / 10000), rest = man % 10000;
  if (!eok) return sign + rest.toLocaleString() + "만";
  return sign + eok + "억" + (rest ? " " + rest.toLocaleString() : "");
}
const pct = (v) => v == null ? "–" : (v > 0 ? "▲" : v < 0 ? "▼" : "") + Math.abs(v).toFixed(1) + "%";
const pctp = (v) => v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(1) + "%p";
const cls = (v) => v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "";
const dist = (m) => m == null ? "–" : m < 1000 ? m + "m" : (m / 1000).toFixed(1) + "km";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const thisYear = new Date().getFullYear();

// ---------- 입지점수 (각 0~100, 가중평균) ----------
// 비중 키: a 출근 접근성 · h 단지 규모 · e 학군 · s 역세권
// "데이터 추천형"은 백테스트(2022~26 이후 상승률과의 순위상관 크기)에 맞춘 비중: 업무지구 0.47 > 규모 0.17 ≈ 학군 > 역 0.13
const PRESETS = {
  "데이터 추천형": { a: 45, h: 20, e: 20, s: 15 },
  "균형형": { a: 25, h: 25, e: 25, s: 25 },
  "자녀 학군형": { a: 15, h: 15, e: 55, s: 15 },
  "출퇴근형": { a: 45, h: 10, e: 10, s: 35 },
  "대단지 안정형": { a: 25, h: 45, e: 15, s: 15 },
};
const WKEYS = ["a", "h", "e", "s"];
const HUB_NAMES = ["광화문", "강남", "여의도", "판교", "마곡", "성수", "가산·구로"];   // build_site.py COMMUTE_HUBS 순서
const cwIdx = () => +($("#f-cw")?.value ?? 1);
const ctOf = (i) => i.ct?.[cwIdx()] ?? null;   // 선택한 출근지까지 분
const weights = () => {
  const w = store.get("weights", null);
  return w && WKEYS.every((k) => k in w) ? w : { ...PRESETS["데이터 추천형"] };   // 예전 3요소 저장값은 새 기본값으로
};
function scoreSize(h) {
  if (h == null) return 20;   // K-apt 미등록 = 대부분 150세대 미만 소규모 단지
  return h >= 2000 ? 100 : h >= 1000 ? 80 : h >= 500 ? 60 : h >= 300 ? 40 : 20;
}
function scoreStation(sd, sl) {
  if (sd == null) return null;
  const base = sd <= 300 ? 100 : sd <= 500 ? 80 : sd <= 800 ? 60 : sd <= 1000 ? 45 : sd <= 1500 ? 25 : 10;
  return Math.min(100, base + Math.max(0, (sl || 0) - 1) * 10);
}
const step = (m, cuts) => m == null ? null : m <= cuts[0] ? 100 : m <= cuts[1] ? 75 : m <= cuts[2] ? 50 : 25;
// 학군 = 초등 35% · 중등 20% · 고등 15% · 학원가 30% (있는 항목만으로 가중평균)
function eduParts(i) {
  return {
    초: step(i.em, [300, 500, 800]),        // 매일 걸어서 → 가까울수록
    중: step(i.mm, [500, 800, 1200]),
    고: step(i.hm, [700, 1000, 1500]),       // 버스 통학도 흔해 허용 거리 넓게
    학원: i.a1 == null ? null : state.acadPct(i.a1),
  };
}
function scoreEdu(i) {
  const p = eduParts(i), w = { 초: 35, 중: 20, 고: 15, 학원: 30 };
  let s = 0, t = 0;
  for (const k in w) if (p[k] != null) { s += p[k] * w[k]; t += w[k]; }
  return t ? Math.round(s / t) : null;
}
function computeScores() {
  const a = state.items.map((i) => i.a1).filter((x) => x != null).sort((x, y) => x - y);
  // 학원 수 백분위: 서울 전체 단지 중 몇 %보다 많은가
  state.acadPct = (v) => {
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
    return Math.round((lo / Math.max(a.length, 1)) * 100);
  };
  const w = weights();
  for (const i of state.items) {
    if (!i.la) { i.sA = i.sH = i.sE = i.sS = i.ls = null; continue; }   // 위치 정보 수집 전 단지는 점수 보류
    i.sA = i.ac == null ? null : Math.round(i.ac);
    i.sH = scoreSize(i.h); i.sE = scoreEdu(i); i.sS = scoreStation(i.sd, i.sl);
    let sum = 0, wt = 0;
    for (const [s, k] of [[i.sA, "a"], [i.sH, "h"], [i.sE, "e"], [i.sS, "s"]]) if (s != null) { sum += s * w[k]; wt += w[k]; }
    i.ls = wt ? Math.round(sum / wt) : null;
  }
}
const bar = (label, v) => `<span class="sb"><em>${label}</em><i style="--v:${v ?? 0}%"></i><b>${v ?? "–"}</b></span>`;
const scoreBars = (i) => `<div class="sbars">${bar("출근", i.sA)}${bar("규모", i.sH)}${bar("학군", i.sE)}${bar("역", i.sS)}</div>`;
// 학군지 태그: 서울 3대 학원가 + 학원 밀집 상위 지역
const EDU_ZONES = { "대치 학원가": ["대치동", "도곡동", "개포동", "일원동"], "목동 학원가": ["목동", "신정동"],
                    "중계 학원가": ["중계동", "하계동"] };
function eduTags(i) {
  const tags = Object.entries(EDU_ZONES).filter(([, ds]) => ds.includes(i.d) && (i.a1 ?? 0) >= 150).map(([z]) => z);
  const p = i.a1 == null ? null : state.acadPct(i.a1);
  if (p != null && p >= 95) tags.push("학원 밀집 상위 5%");
  else if (p != null && p >= 85) tags.push("학원 밀집 상위 15%");
  if (i.em != null && i.em <= 300) tags.push("초품아");
  return tags;
}

// ---------- 시작 ----------
async function init() {
  const data = await (await fetch("data/complexes.json", { cache: "no-cache" })).json();
  state.items = data.items;
  state.meta = data.meta;
  state.items.forEach((it) => (state.byCode[it.c] = it));
  computeScores();

  const gus = [...new Set(state.items.map((i) => i.g))].sort();
  $("#f-gu").insertAdjacentHTML("beforeend", gus.map((g) => `<option>${g}</option>`).join(""));
  $("#f-sort").insertAdjacentHTML("afterbegin", `<option value="ls">입지점수 높은 순</option>`);
  $("#f-sort").value = "ls";
  $("#m-color").insertAdjacentHTML("afterbegin", `<option value="ls">색: 입지점수</option>`);

  const saved = store.get("filters", {});
  for (const [id, v] of Object.entries(saved)) if ($(id)) $(id).value = v;

  buildWeightPanel();

  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $$("#tab-list .filters select").forEach((s) => s.addEventListener("change", () => { saveFilters(); renderList(); }));
  $("#f-more").addEventListener("click", () => ($("#more").hidden = !$("#more").hidden));
  $$("#list-seg button").forEach((b) => b.addEventListener("click", () => setListView(b.dataset.v)));
  $$("#list-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === store.get("listView", "rank")));
  $("#q").addEventListener("input", () => {
    if ($("#tab-supply").classList.contains("active")) return renderSupply();   // 청약 탭에서는 청약 공고 검색
    if (!$("#tab-list").classList.contains("active")) showTab("list");
    renderList();
  });
  $$("#sub-seg button").forEach((b) => b.addEventListener("click", () => {
    $$("#sub-seg button").forEach((x) => x.classList.toggle("on", x === b)); renderSupply();
  }));
  $$("#sub-filters select").forEach((s) => s.addEventListener("change", renderSupply));
  $("#sheet-bg").addEventListener("click", () => history.back());
  $("#m-color").addEventListener("change", () => { store.set("mcolor", $("#m-color").value); drawMarkers(); });
  $("#m-supply").addEventListener("change", toggleSupplyLayer);
  $("#m-subway").addEventListener("change", onZoom);
  $("#m-gu").addEventListener("change", onZoom);
  $("#m-base").value = store.get("mbase", "clean");
  $("#m-base").addEventListener("change", () => { store.set("mbase", $("#m-base").value); setBase($("#m-base").value); });
  $("#cmp-bar").addEventListener("click", () => (location.hash = "cmp"));
  window.addEventListener("hashchange", route);
  $("#m-color").value = store.get("mcolor", "ls");

  const metaLine = `데이터 ${state.meta.dataFrom} ~ ${state.meta.dataTo} · 단지 ${state.meta.count.toLocaleString()}개 · 갱신 ${state.meta.updated}<br>국토교통부 실거래가 기반 · 투자 권유가 아닙니다`;
  $$(".tab").forEach((t) => t.id !== "tab-map" && t.insertAdjacentHTML("beforeend", `<div class="meta-line">${metaLine}</div>`));

  initMap();
  renderList();
  renderFav();
  renderCmpBar();
  showTab(store.get("tab", "map"));
  route();

  // 로그인 상태가 바뀌면 (로그인·가입·리마크 작성) 화면 갱신
  cloud.onChange(() => {
    renderAuth(); renderList(); renderFav(); drawMarkers();
    const m = location.hash.match(/^#c=([^&]+)/);
    if (m) renderRemarks(decodeURIComponent(m[1]));
    else if (location.hash.startsWith("#s=") && state.subByNo) {
      const s = state.subByNo[decodeURIComponent(location.hash.slice(3))];
      if (s) renderRemarks("청약-" + s.no);
    }
    if ($("#tab-supply").classList.contains("active")) renderSupply();
    if (location.hash === "#join" && cloud.ready) history.back();
  });
  renderAuth();
  cloud.init().catch((e) => console.warn("로그인 서버 연결 실패", e));
  // 가이드 버튼 — 화면 파일(index.html)이 캐시된 옛 버전이어도 항상 보이도록 코드에서 보장
  if (!document.querySelector('a[href="#guide"]')) {
    $("#auth-btn").insertAdjacentHTML("beforebegin", `<a href="#guide" class="auth-btn" style="text-decoration:none;margin-right:4px">📖 가이드</a>`);
  }
}

// 새 버전이 배포돼 서비스워커가 바뀌면 한 번 새로고침해서 화면·코드 버전을 맞춤
if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

function saveFilters() {
  const ids = ["#f-gu", "#f-sort", "#f-budget", "#f-hh", "#f-sd", "#f-es", "#f-age", "#f-n", "#f-dg", "#f-cw", "#f-cm"];
  store.set("filters", Object.fromEntries(ids.map((id) => [id, $(id).value])));
}

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  store.set("tab", name);
  if (name === "map" && state.map) setTimeout(() => state.map.invalidateSize(), 0);
  if (name === "fav") renderFav();
  if (name === "supply") renderSupply();
  if (name === "news") renderNews();
}

// ---------- 입지점수 비중 패널 ----------
function buildWeightPanel() {
  $("#more").insertAdjacentHTML("beforebegin", `
    <div class="wpanel">
      <div class="wtitle">📍 입지점수 비중${guideLink("ls")} <span class="note">— 출근 · 규모 · 학군(초중고+학원) · 역</span></div>
      <div class="presets">${Object.keys(PRESETS).map((p) => `<button class="chip" data-p="${p}">${p === "데이터 추천형" ? "⭐ " : ""}${p}</button>`).join("")}</div>
      <div class="note" style="margin-bottom:4px">⭐ 데이터 추천형 = 2022~26 백테스트에서 이후 상승과 관련이 컸던 순서대로 비중 (<a href="#score">성적표</a>)</div>
      ${[["a", "🏙️ 출근 접근성"], ["h", "🏢 단지 규모"], ["e", "🎒 학군"], ["s", "🚇 역세권"]].map(([k, l]) =>
        `<label class="wrow"><span>${l}</span><input type="range" min="0" max="100" step="5" data-k="${k}"><b data-v="${k}"></b></label>`).join("")}
    </div>`);
  const sync = () => {
    const w = weights(), tot = WKEYS.reduce((t, k) => t + w[k], 0) || 1;
    $$(".wrow input").forEach((r) => (r.value = w[r.dataset.k]));
    $$(".wrow b").forEach((b) => (b.textContent = Math.round((w[b.dataset.v] / tot) * 100) + "%"));
    $$(".presets button").forEach((b) => {
      const p = PRESETS[b.dataset.p];
      b.classList.toggle("on", WKEYS.every((k) => p[k] === w[k]));
    });
  };
  const apply = () => { computeScores(); sync(); renderList(); drawMarkers(); };
  $$(".presets button").forEach((b) => b.addEventListener("click", () => { store.set("weights", { ...PRESETS[b.dataset.p] }); apply(); }));
  $$(".wrow input").forEach((r) => r.addEventListener("input", () => {
    store.set("weights", { ...weights(), [r.dataset.k]: +r.value }); apply();
  }));
  sync();
}

// ---------- 지도 ----------
const COLOR_MODES = {
  ls: { label: "입지점수", stops: [[80, "#b91c1c", "80+"], [65, "#ef4444", "65+"], [50, "#fca5a5", "50+"], [35, "#93c5fd", "35+"], [-1e9, "#2563eb", "35미만"]] },
  r1: { label: "1년 상승률", stops: [[10, "#b91c1c", "10%+"], [5, "#ef4444", "5%+"], [0, "#fca5a5", "0%+"], [-5, "#93c5fd", "-5%"], [-1e9, "#2563eb", "더 하락"]] },
  r3: { label: "3년 상승률", stops: [[30, "#b91c1c", "30%+"], [15, "#ef4444", "15%+"], [0, "#fca5a5", "0%+"], [-10, "#93c5fd", "-10%"], [-1e9, "#2563eb", "더 하락"]] },
  jr: { label: "전세가율", stops: [[65, "#b91c1c", "65%+"], [55, "#ef4444", "55%+"], [45, "#fca5a5", "45%+"], [35, "#93c5fd", "35%+"], [-1e9, "#2563eb", "35%미만"]] },
  kp: { label: "주변 대비 가격", stops: [[15, "#2563eb", "15%+ 비쌈"], [5, "#93c5fd", "5%+"], [-5, "#d1d5db", "비슷"], [-15, "#fca5a5", "5%+ 쌈"], [-1e9, "#b91c1c", "15%+ 쌈"]] },
  df: { label: "하락 방어력", stops: [[75, "#047857", "A"], [50, "#34d399", "B"], [25, "#fbbf24", "C"], [-1e9, "#ef4444", "D"]] },
  ac: { label: "출근 접근성", stops: [[80, "#b91c1c", "80+"], [60, "#ef4444", "60+"], [40, "#fca5a5", "40+"], [20, "#93c5fd", "20+"], [-1e9, "#2563eb", "20미만"]] },
};
function colorOf(mode, v) {
  if (v == null) return "#9ca3af";
  for (const [min, c] of COLOR_MODES[mode].stops) if (v >= min) return c;
}
// 배경지도: OpenFreeMap 벡터 지도 (무료·키 없음) — 네이버·카카오처럼 깔끔한 스타일. 불러오기 실패 시 OSM 기본 지도
const BASES = { clean: "https://tiles.openfreemap.org/styles/positron", color: "https://tiles.openfreemap.org/styles/liberty" };
async function koreanStyle(url) {
  // 배경지도 글자를 한글 이름으로 (기본 스타일은 영문 병기)
  try {
    const st = await (await fetch(url)).json();
    for (const l of st.layers) if (l.layout?.["text-field"]) l.layout["text-field"] = ["coalesce", ["get", "name:ko"], ["get", "name"]];
    return st;
  } catch { return url; }
}
async function setBase(kind) {
  if (state.base) state.map.removeLayer(state.base);
  state.base = L.maplibreGL
    ? L.maplibreGL({ style: await koreanStyle(BASES[kind] || BASES.clean),
        attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })
    : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
  state.base.addTo(state.map);
}
function initMap() {
  state.map = L.map("map", { preferCanvas: true, zoomControl: false, maxZoom: 18 }).setView([37.5565, 126.99], 11);
  for (const [name, z] of [["guPane", 350], ["linePane", 360], ["stationPane", 420], ["labelPane", 430]]) {
    state.map.createPane(name).style.zIndex = z;
  }
  state.map.getPane("labelPane").style.pointerEvents = "none";
  setBase(store.get("mbase", "clean"));
  L.control.zoom({ position: "topright" }).addTo(state.map);
  state.layer = L.layerGroup().addTo(state.map);
  drawMarkers();
  loadOverlays();
  state.map.on("zoomend", onZoom);
}
// 구 경계 + 구 이름, 지하철 노선 + 역 (지도 위 보조 레이어)
async function loadOverlays() {
  try {
    const gu = await (await fetch("static/seoul_gu.geojson")).json();
    state.guLayer = L.geoJSON(gu, { pane: "guPane", interactive: false,
      style: { color: "#334155", weight: 1.6, opacity: 0.75, fill: true, fillOpacity: 0.02, dashArray: "5 4" } });
    state.guLabels = L.layerGroup(gu.features.map((f) => {
      const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const c = ring.reduce((a, p) => [a[0] + p[1] / ring.length, a[1] + p[0] / ring.length], [0, 0]);
      return L.marker(c, { pane: "labelPane", interactive: false,
        icon: L.divIcon({ className: "gu-label", html: f.properties.name, iconSize: null }) });
    }));
  } catch (e) { console.warn("구 경계 불러오기 실패", e); }
  try {
    const sub = await (await fetch("static/subway.json")).json();
    const lineR = L.canvas({ pane: "linePane" });
    state.subLines = L.layerGroup(sub.lines.map((l) =>
      L.polyline(l.segs, { color: l.color, weight: 3, opacity: 0.85, renderer: lineR, interactive: false })));
    const stR = L.canvas({ pane: "stationPane" });
    state.stations = L.layerGroup(sub.stations.map((s) =>
      L.circleMarker([s.la, s.lo], { renderer: stR, radius: s.c.length > 1 ? 4.5 : 3.5, weight: 2,
        color: s.c.length > 1 ? "#111827" : s.c[0], fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(`${esc(s.n)}역`, { direction: "top" })));
    state.stLabels = L.layerGroup(sub.stations.map((s) => L.marker([s.la, s.lo], { pane: "labelPane", interactive: false,
      icon: L.divIcon({ className: "st-label", html: `${esc(s.n)}`, iconSize: null, iconAnchor: [-6, 6] }) })));
  } catch (e) { console.warn("지하철 노선 불러오기 실패", e); }
  onZoom();
}
function onZoom() {
  const z = state.map.getZoom(), m = state.map;
  const show = (layer, on) => layer && (on ? !m.hasLayer(layer) && layer.addTo(m) : m.hasLayer(layer) && m.removeLayer(layer));
  const sub = $("#m-subway")?.checked ?? true, gu = $("#m-gu")?.checked ?? true;
  show(state.guLayer, gu); show(state.guLabels, gu && z <= 13);
  show(state.subLines, sub); show(state.stations, sub && z >= 12); show(state.stLabels, sub && z >= 14);
  state.subLines?.eachLayer((l) => l.setStyle({ weight: z <= 11 ? 2 : z <= 13 ? 3 : 5 }));
  const k = z <= 10 ? 0.45 : z <= 11 ? 0.6 : z <= 12 ? 0.8 : z <= 14 ? 1 : 1.3;   // 축소하면 단지 점을 작게
  for (const [mk, r] of state.markers || []) mk.setRadius(r * k);
}
function drawMarkers() {
  if (!state.layer) return;
  const mode = $("#m-color").value;
  state.layer.clearLayers();
  state.markers = [];
  const z = state.map.getZoom(), k = z <= 10 ? 0.45 : z <= 11 ? 0.6 : z <= 12 ? 0.8 : z <= 14 ? 1 : 1.3;
  for (const it of state.items) {
    if (!it.la) continue;
    const r = it.h ? Math.min(4 + Math.sqrt(it.h) / 6, 14) : 4;
    const rm = cloud.counts[it.c];   // 지인 리마크가 있는 단지는 굵은 테두리
    const mk = L.circleMarker([it.la, it.lo], { radius: r * k, weight: rm ? 3 : 1, color: rm ? "#111827" : "#fff", fillColor: colorOf(mode, it[mode]), fillOpacity: 0.85 })
      .bindTooltip(`${esc(it.n)} · 입지 ${it.ls ?? "–"} · ${won(it.p84)}`, { direction: "top" })
      .on("click", () => openDetail(it.c))
      .addTo(state.layer);
    state.markers.push([mk, r]);
  }
  $("#legend").innerHTML = COLOR_MODES[mode].label + " " +
    [...COLOR_MODES[mode].stops.map(([, c, t]) => [c, t]), ["#9ca3af", "자료없음"]]
      .map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("");
}

// ---------- 청약 · 입주예정 ----------
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 날짜
const dday = (d) => Math.round((new Date(d) - new Date(today())) / 86400e3);
const md = (d) => d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : "–";
const ym = (v) => v ? `${v.slice(0, 4)}.${v.slice(4, 6)}` : "–";
function subStatus(s) {
  const t = today(), d = s.dt;
  const start = d.특공접수일 || d.접수시작 || d["1순위해당지역"];
  const end = d.접수종료 || d["2순위"] || d["1순위기타지역"] || d["1순위해당지역"] || start;
  if (start && t < start) return { k: "upcoming", label: `접수예정 D-${dday(start)}`, next: start };
  if (start && t <= end) return { k: "open", label: "접수중", next: end };
  if (d.당첨자발표일 && t <= d.당첨자발표일) return { k: "wait", label: `발표 ${md(d.당첨자발표일)}`, next: d.당첨자발표일 };
  if (d.계약종료 && t <= d.계약종료) return { k: "contract", label: "계약중", next: d.계약종료 };
  return { k: "done", label: "마감", next: d.모집공고일 };
}
async function loadSubs() {
  if (state.subs) return state.subs;
  if (!state.meta.hasSubs) return (state.subs = []);
  try { state.subs = await (await fetch("data/subs.json")).json(); } catch { state.subs = []; }
  state.subByNo = Object.fromEntries(state.subs.map((s) => [s.k + s.no, s]));
  return state.subs;
}
const subKey = (s) => s.k + s.no;
const marginHTML = (s) => s.mg == null ? `<span class="note">주변 시세 비교 불가</span>`
  : `<span class="${cls(s.mg)}">주변${s.nnew ? " 신축" : ""} 대비 ${s.mg > 0 ? "차익" : "고분양"} ${pct(s.mg)}</span>` +
    (s.m84 != null ? `<br><span class="note">84㎡ 기준 ${s.m84 > 0 ? "+" : ""}${won(s.m84)}</span>` : "");
function subItemHTML(s) {
  const st = subStatus(s);
  return `<li class="item" data-s="${esc(subKey(s))}">
    <div class="nm"><span class="kbadge ${s.k === "무순위" ? "k2" : ""}">${s.k === "무순위" ? "무순위" : esc(s.pv || "APT")}</span>
      ${esc(s.n)}${remarkBadge("청약-" + s.no)}</div>
    <div class="px"><span class="st st-${st.k}">${st.label}</span></div>
    <div class="sub">${esc(s.g)} · ${s.h ? s.h.toLocaleString() + "세대" : ""} · 입주 ${ym(s.mv)}
      ${s.reg.map((r) => `<span class="tag">${r}</span>`).join("")}<br>
      ${s.s84 ? "84㎡ " + won(s.s84) : s.s59 ? "59㎡ " + won(s.s59) : s.sppp ? "평당 " + won(s.sppp) : ""}
      ${s.dt.당첨자발표일 ? ` · 발표 ${md(s.dt.당첨자발표일)}` : ""}
      ${s.cm != null ? `<br>🔥 경쟁률 ${s.cm}:1${s.sc != null ? ` · 최저 ${s.sc}점` : ""}` : ""}</div>
    <div class="chg">${marginHTML(s)}</div>
  </li>`;
}
async function renderSupply() {
  const subs = await loadSubs();
  if (!subs.length) { $("#supply").innerHTML = `<div class="empty">청약 데이터가 아직 없습니다</div>`; return; }
  const view = $("#sub-seg .on").dataset.v;
  $("#sub-filters").hidden = view !== "sched";
  const t = today();
  const q = $("#q").value.trim().toLowerCase();
  const match = (s) => !q || [s.n, s.g, s.a].some((x) => x && x.toLowerCase().includes(q));

  if (view === "move") {   // 입주 예정: 일반분양 공고 기준 (무순위는 같은 단지라 제외)
    const ym0 = t.slice(0, 4) + t.slice(5, 7);
    const xs = subs.filter((s) => s.k === "APT" && s.mv >= ym0 && match(s));
    const byGu = {}, years = {};
    for (const s of xs) { byGu[s.g] = (byGu[s.g] || 0) + s.h; (years[s.mv.slice(0, 4)] ??= []).push(s); }
    $("#supply").innerHTML = `<div class="count">일반분양 세대수 기준 · 재건축 조합원 물량은 빠져 실제 입주 세대보다 적습니다</div>
      <div class="sup-gu">${Object.entries(byGu).sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `<span>${esc(g)} <b>${n.toLocaleString()}</b></span>`).join("")}</div>` +
      Object.entries(years).sort().map(([y, ys]) => `
        <div class="sup-year">${y}년 입주 · ${ys.reduce((a, s) => a + s.h, 0).toLocaleString()}세대</div>
        <ol class="list">${ys.sort((a, b) => a.mv.localeCompare(b.mv)).map(subItemHTML).join("")}</ol>`).join("");
  } else {
    const when = $("#s-when").value, kind = $("#s-kind").value, sort = $("#s-sort").value;
    const since = new Date(Date.now() - 183 * 86400e3).toISOString().slice(0, 10);
    let xs = subs.filter((s) => match(s) && (!kind || s.k === kind) &&
      (when === "all" || (when === "6m" ? (s.dt.모집공고일 || "") >= since : subStatus(s).k !== "done")));
    xs = sort === "mg" ? xs.sort((a, b) => (b.mg ?? -1e9) - (a.mg ?? -1e9))
      : sort === "cm" ? xs.sort((a, b) => (b.cm ?? -1) - (a.cm ?? -1))
      : sort === "sc" ? xs.sort((a, b) => (a.sc ?? 1e9) - (b.sc ?? 1e9))
      : xs.sort((a, b) => {
          const sa = subStatus(a), sb = subStatus(b);
          if ((sa.k === "done") !== (sb.k === "done")) return sa.k === "done" ? 1 : -1;
          return sa.k === "done" ? sb.next.localeCompare(sa.next) : sa.next.localeCompare(sb.next);
        });
    // 앞으로 2주 일정
    const evs = [];
    const until = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
    for (const s of subs) for (const [k, d] of Object.entries(s.dt))
      if (d >= t && d <= until && k !== "모집공고일" && k !== "접수종료" && k !== "계약종료") evs.push([d, k, s]);
    evs.sort((a, b) => a[0].localeCompare(b[0]));
    $("#supply").innerHTML =
      (evs.length ? `<div class="card cal"><h3>🗓️ 앞으로 2주</h3>${evs.slice(0, 12).map(([d, k, s]) =>
        `<a class="ev" href="#s=${encodeURIComponent(subKey(s))}"><b>${md(d)}</b><span class="tag">${k.replace("해당지역", "").replace("접수일", "")}</span>${esc(s.n)}</a>`).join("")}</div>` : "") +
      `<div class="count">${xs.length}건</div><ol class="list">${xs.slice(0, 200).map(subItemHTML).join("") ||
        '<div class="empty">조건에 맞는 공고가 없습니다</div>'}</ol>`;
  }
  $$("#supply .item[data-s]").forEach((el) => el.addEventListener("click", () => (location.hash = "s=" + encodeURIComponent(el.dataset.s))));
}
async function toggleSupplyLayer() {
  if (state.supLayer) { state.map.removeLayer(state.supLayer); state.supLayer = null; }
  if (!$("#m-supply").checked) return;
  const subs = await loadSubs();
  const ym0 = today().slice(0, 4) + today().slice(5, 7);
  state.supLayer = L.layerGroup().addTo(state.map);
  for (const s of subs) {
    const st = subStatus(s);
    const show = st.k !== "done" || (s.k === "APT" && s.mv >= ym0);
    if (!show || !s.la) continue;
    L.marker([s.la, s.lo], { icon: L.divIcon({ className: "sup-marker", html: st.k !== "done" ? "📢" : "🏗️", iconSize: [22, 22] }) })
      .bindTooltip(`${esc(s.n)} · ${st.k !== "done" ? st.label : "입주 " + ym(s.mv)}`)
      .on("click", () => (location.hash = "s=" + encodeURIComponent(subKey(s))))
      .addTo(state.supLayer);
  }
}
async function renderSub(key) {
  await loadSubs();
  const s = state.subByNo[key];
  if (!s) return closeSheet();
  const st = subStatus(s);
  const steps = [["모집공고일", "모집공고"], ["특공접수일", "특별공급"], ["1순위해당지역", "1순위 (해당지역)"],
    ["1순위기타지역", "1순위 (기타지역)"], ["2순위", "2순위"], ["접수시작", "청약 접수"], ["당첨자발표일", "당첨자 발표"],
    ["계약시작", "계약"]].filter(([k]) => s.dt[k]);
  const t = today();
  openSheet(`
    <div class="sh-head">
      <div style="flex:1"><h2>${esc(s.n)}</h2><div class="addr">${esc(s.a)}</div></div>
      <button class="icon-btn" data-close aria-label="닫기">✕</button>
    </div>
    <div class="sh-actions">
      ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">📄 청약홈 공고</a>` : ""}
      ${s.hp ? `<a href="${esc(s.hp)}" target="_blank" rel="noopener">🏠 분양 홈페이지</a>` : ""}
      ${s.la ? `<a href="https://map.kakao.com/link/map/${encodeURIComponent(s.n)},${s.la},${s.lo}" target="_blank" rel="noopener">🗺️ 위치</a>` : ""}
    </div>
    <div class="stats">
      <div class="stat"><small>상태</small><b><span class="st st-${st.k}">${st.label}</span></b></div>
      <div class="stat"><small>구분</small><b>${s.k === "무순위" ? "무순위" : esc(s.pv || "APT")}</b></div>
      <div class="stat"><small>공급</small><b>${s.h.toLocaleString()}세대</b></div>
      <div class="stat"><small>84㎡ 분양가</small><b>${won(s.s84)}</b></div>
      <div class="stat"><small>59㎡ 분양가</small><b>${won(s.s59)}</b></div>
      <div class="stat"><small>입주 예정</small><b>${ym(s.mv)}</b></div>
    </div>
    ${s.reg.length ? `<div class="note" style="margin:-4px 0 10px">규제: ${s.reg.join(" · ")} — 전매제한·실거주의무는 모집공고문에서 꼭 확인하세요</div>` : ""}
    <div class="card"><h3>💰 분양가 vs 주변 시세${guideLink("subs")}</h3>
      ${s.mg == null ? `<div class="note">주변 1km 안에 비교할 거래가 부족합니다</div>` : `
      <div class="kmsg">주변 1km ${s.nnew ? "<b>10년 이내 신축</b>" : "단지"} ${s.nn}곳 평당 시세 <b>${won(s.nppp)}</b>
        vs 분양 평당가 <b>${won(s.sppp)}</b> → <b class="${cls(s.mg)}">${s.mg > 0 ? "시세가 " + pct(s.mg) + " 높음 (차익 기대)" : "분양가가 시세보다 높음"}</b></div>
      ${s.m84 != null ? `<div class="kmsg">84㎡ 기준: 주변 시세 ${won(s.n84)} − 분양가 ${won(s.s84)} = <b class="${cls(s.m84)}">${s.m84 > 0 ? "+" : ""}${won(s.m84)}</b></div>` : ""}
      <table class="near">${s.near.map((o) => `<tr data-c="${o.c}"><td class="nm">${esc(o.n)}</td><td>${o.y ?? ""}년</td><td>${o.km}km</td><td>${o.p84 ? "84㎡ " + won(o.p84) : "평당 " + won(o.p)}</td></tr>`).join("")}</table>
      <div class="note">평당가는 전용면적 기준 (시세와 같은 기준). 최고 분양가 기준이며 옵션·발코니 확장비는 제외됩니다.</div>`}
    </div>
    <div class="card"><h3>📅 일정</h3><ol class="timeline">${steps.map(([k, l]) =>
      `<li class="${s.dt[k] < t ? "past" : s.dt[k] === t ? "now" : ""}"><b>${s.dt[k]}</b> ${l}${s.dt[k] >= t ? ` <span class="note">D-${dday(s.dt[k])}</span>` : ""}</li>`).join("")}</ol></div>
    <div class="card" style="overflow-x:auto"><h3>🏷️ 주택형별 분양가${s.tyc ? " · 경쟁률 · 당첨가점" : ""}</h3>
      ${s.cm != null || s.sc != null ? `<div class="kmsg">최고 경쟁률 <b>${s.cm ?? "–"} : 1</b> · 최저 당첨가점 <b>${s.sc ?? "–"}점</b> <span class="note">(1순위 해당지역)</span></div>` : ""}
      <table><tr><th>타입</th><th>일반</th><th>최고 분양가</th><th>평당</th>${s.tyc ? "<th>경쟁률</th><th>최저/평균</th>" : "<th>특공</th>"}</tr>
      ${s.ty.sort((a, b) => a[1] - b[1]).map(([ty, a, g, sp, p]) => {
        const c = s.tyc?.[ty];
        return `<tr><td>${esc(ty.replace(/^0+/, ""))}</td><td>${g}</td><td>${won(p)}</td><td>${won(Math.round(p / a * 3.305785))}</td>
          ${s.tyc ? `<td>${c?.[0] != null ? c[0] + ":1" : "–"}</td><td>${c?.[1] != null ? `${c[1]}/${Math.round(c[2])}` : "–"}</td>` : `<td>${sp}</td>`}</tr>`;
      }).join("")}
      </table>${s.tyc ? `<div class="note">가점은 84점 만점 (무주택기간 32 + 부양가족 35 + 청약통장 17)</div>` : ""}</div>
    <div class="card" id="remarks"></div>`);
  $$("#sheet .near tr[data-c]").forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.c)));
  renderRemarks("청약-" + s.no);
}

// ---------- 📰 이슈 브리핑 ----------
async function renderNews() {
  const box = $("#news"), sel = $("#news-date");
  if (!state.newsDates) {
    try { state.newsDates = await (await fetch("data/news/index.json")).json(); } catch { state.newsDates = []; }
    sel.innerHTML = state.newsDates.map((d) => `<option>${d}</option>`).join("");
    sel.onchange = renderNews;
  }
  if (!state.newsDates.length) {
    box.innerHTML = `<div class="empty">아직 브리핑이 없습니다.<br>매일 아침 7시에 자동으로 채워집니다.</div>`;
    sel.hidden = true; return;
  }
  sel.hidden = false;
  const d = sel.value || state.newsDates[0];
  let n;
  try { n = await (await fetch(`data/news/${d}.json`)).json(); } catch { box.innerHTML = `<div class="empty">브리핑을 불러오지 못했습니다</div>`; return; }
  const item = (x) => `<li class="nw"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>
    <div class="note">${esc(x.source || x.agency || "")}${x.date ? " · " + esc(x.date) : ""}</div>
    ${x.summary ? `<div>${esc(x.summary)}</div>` : ""}</li>`;
  box.innerHTML = `
    ${n.briefing?.length ? `<div class="card brief"><h3>🗞️ 오늘의 3줄 브리핑 <span class="note">${esc(n.date)}</span></h3>
      <ol>${n.briefing.map((b) => `<li>${esc(b)}</li>`).join("")}</ol></div>` : ""}
    ${n.policy?.length ? `<div class="card"><h3>🏛️ 정책·정부 발표</h3><ul class="nws">${n.policy.map(item).join("")}</ul></div>` : ""}
    ${(n.topics || []).filter((t) => t.items?.length).map((t) => `<div class="card"><h3>${esc(t.topic)}</h3><ul class="nws">${t.items.map(item).join("")}</ul></div>`).join("")}
    ${n.watch?.length ? `<div class="card"><h3>📌 이번 주 체크</h3><ul>${n.watch.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    <div class="note" style="padding:0 16px 12px">Claude가 공개된 기사·보도자료를 검색해 직접 요약했습니다. 정확한 내용은 원문 링크에서 확인하세요.</div>`;
}

// ---------- 순위 ----------
function filtered(ignoreGu = false) {
  const q = $("#q").value.trim().toLowerCase();
  const gu = $("#f-gu").value, budget = +$("#f-budget").value * 10000, hh = +$("#f-hh").value,
        sd = +$("#f-sd").value, es = +$("#f-es").value, age = +$("#f-age").value, n = +$("#f-n").value,
        dg = $("#f-dg").value, cm = +$("#f-cm").value;
  // 띄어쓴 단어가 모두 들어 있으면 일치 (예: "천호동 528", "천호 삼성", "잠실 엘스")
  const words = q.split(/\s+/).filter(Boolean);
  const hay = (i) => (i._hay ??= [i.n, i.al, i.d, i.g, i.st, i.d + " " + i.j, i.j].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " "));
  const xs = state.items.filter((i) =>
    (!words.length || words.every((w) => hay(i).includes(w))) &&
    (!gu || ignoreGu || i.g === gu) &&
    (!budget || (i.p84 != null && i.p84 <= budget)) &&
    (!hh || (i.h ?? 0) >= hh) &&
    (!sd || (i.sd != null && i.sd <= sd)) &&
    (!es || (i.em != null && i.em <= es)) &&
    (!age || (age > 0 ? i.y && thisYear - i.y <= age : i.y && thisYear - i.y >= -age)) &&
    (!n || i.n12 >= n) &&
    (!dg || (i.dg && dg.includes(i.dg))) &&
    (!cm || (ctOf(i) != null && ctOf(i) <= cm)));
  const hi = (k) => (i) => -(i[k] ?? -1e9), lo = (k) => (i) => i[k] ?? 1e9;
  const key = {
    ls: hi("ls"), r1: hi("r1"), r3: hi("r3"), kp: lo("kp"), kr: lo("kr"), jr: hi("jr"), n12: hi("n12"), vt: hi("vt"),
    sd: lo("sd"), bk: lo("bk"), em: lo("em"), a1: hi("a1"), pAsc: lo("p"), pDesc: hi("p"),
    rm: (i) => -(cloud.counts[i.c]?.n ?? 0),
    df: hi("df"), dd: (i) => (i.de ? 1e8 : 0) + (i.dd ?? 1e9), ac: hi("ac"),   // 낙폭 추정치는 뒤로
    gpA: lo("gp"), gpD: hi("gp"), sE: hi("sE"), ct: (i) => ctOf(i) ?? 1e9,
  }[$("#f-sort").value];
  return xs.sort((a, b) => key(a) - key(b));
}
function sortMetric(i) {        // 정렬 기준에 맞는 오른쪽 아래 수치
  const s = $("#f-sort").value;
  return {
    r3: [`3년 ${pct(i.r3)}`, cls(i.r3)], kp: [`주변대비 ${pct(i.kp)}`, cls(-i.kp)], kr: [`주변대비 ${pctp(i.kr)}`, cls(i.kr)],
    jr: [`전세가율 ${i.jr ?? "–"}%`, ""], vt: [`거래 ${pct(i.vt)}`, cls(i.vt)],
    em: [`초 ${dist(i.em)}`, ""], a1: [`학원 ${i.a1 ?? "–"}`, ""],
    df: [`방어 ${i.dg ?? "–"} (${i.df ?? "–"})`, ""], dd: [`'22 낙폭 ${i.dd != null ? "-" + i.dd + "%" : "–"}${i.de ? " 추정" : ""}`, "down"],
    ac: [`출근 ${i.ac ?? "–"}`, ""],
    gpA: [`모델 대비 ${pct(i.gp)}`, cls(i.gp)], gpD: [`모델 대비 ${pct(i.gp)}`, cls(i.gp)],
    sE: [`학군 ${i.sE ?? "–"}점`, ""],
    ct: [`${HUB_NAMES[cwIdx()]} ${ctOf(i) ?? "–"}분`, ""],
  }[s] || [`1년 ${pct(i.r1)}`, cls(i.r1)];
}
function remarkBadge(code) {
  const c = cloud.counts[code];
  if (!c) return "";
  const top = Object.entries(c.kinds).sort((a, b) => b[1] - a[1])[0][0];
  return `<span class="tag">${REMARK_KINDS[top]} ${c.n}</span>`;
}
function itemHTML(i, rank) {
  const [m, c] = sortMetric(i);
  return `<li class="item" data-c="${i.c}">
    <div class="nm">${rank ? `<span class="rk">${rank}</span>` : ""}${isFav(i.c) ? "⭐ " : ""}${esc(i.n)}${isNew(i) ? '<span class="badge">새 거래</span>' : ""}${remarkBadge(i.c)}</div>
    <div class="px">${i.p84 ? "84㎡ " + won(i.p84) : i.p59 ? "59㎡ " + won(i.p59) : "평당 " + won(i.p)}</div>
    <div class="sub">${esc(i.g)} ${esc(i.d)} · ${i.y ?? "?"}년 · ${i.h ? i.h.toLocaleString() + "세대" : "세대수 ?"}<br>
      🚇 ${esc(i.st ?? "–")} ${dist(i.sd)}${i.sl > 1 ? ` · ${i.sl}개 노선` : ""}${ctOf(i) != null ? ` · 🏙️ ${HUB_NAMES[cwIdx()]} ${ctOf(i)}분` : ""}${i.em != null ? `<br>🎒 초 ${dist(i.em)} 중 ${dist(i.mm)} 고 ${dist(i.hm)}` : ""}</div>
    <div class="chg"><span class="lsc">${i.ls ?? "–"}<small>점</small></span><br><span class="${c}">${m}</span></div>
    ${scoreBars(i)}
  </li>`;
}
function bindItems(root) {
  root.querySelectorAll(".item[data-c]").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.c)));
}
// ---------- 🗺️ 구별 비교 ----------
const median = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const GU_COLS = [
  ["n", "단지", (g) => g.n.toLocaleString(), true],
  ["ls", "입지점수", (g) => g.ls ?? "–", true],
  ["p", "평당가", (g) => won(g.p), true],
  ["p84", "84㎡", (g) => won(g.p84), true],
  ["r1", "1년", (g) => `<span class="${cls(g.r1)}">${pct(g.r1)}</span>`, true],
  ["r3", "3년", (g) => `<span class="${cls(g.r3)}">${pct(g.r3)}</span>`, true],
  ["jr", "전세가율", (g) => g.jr != null ? g.jr + "%" : "–", true],
  ["dA", "방어 A", (g) => g.dA != null ? g.dA + "%" : "–", true],
  ["ct", "출근(분)", (g) => g.ct ?? "–", false],
];
function renderGuTable() {
  const xs = filtered(true), by = {};
  for (const i of xs) (by[i.g] ??= []).push(i);
  const rows = Object.entries(by).map(([g, a]) => ({
    g, n: a.length, ls: median(a.map((i) => i.ls)), p: median(a.map((i) => i.p)), p84: median(a.map((i) => i.p84)),
    r1: median(a.map((i) => i.r1)), r3: median(a.map((i) => i.r3)), jr: median(a.map((i) => i.jr)),
    dA: a.some((i) => i.dg) ? Math.round(a.filter((i) => i.dg === "A").length / a.filter((i) => i.dg).length * 100) : null,
    ct: median(a.map(ctOf)),
  }));
  const [key, desc] = store.get("guSort", ["ls", true]);
  rows.sort((a, b) => ((a[key] ?? (desc ? -1e12 : 1e12)) - (b[key] ?? (desc ? -1e12 : 1e12))) * (desc ? -1 : 1));
  $("#count").textContent = `${rows.length}개 구 · 단지 ${xs.length.toLocaleString()}개 기준 (값은 구 안 단지들의 중앙값)`;
  $("#list").innerHTML = `<div class="card gu-card" style="overflow-x:auto"><table class="gu-tbl">
    <tr><th>구</th>${GU_COLS.map(([k, l]) => `<th data-k="${k}" class="${k === key ? "on" : ""}">${l}${k === key ? (desc ? " ▼" : " ▲") : ""}</th>`).join("")}</tr>
    ${rows.map((r, n) => `<tr data-g="${esc(r.g)}"><td><span class="rk">${n + 1}</span><b>${esc(r.g)}</b></td>${GU_COLS.map(([, , f]) => `<td>${f(r)}</td>`).join("")}</tr>`).join("")}
  </table></div>
  <div class="note" style="padding:0 16px">머리글을 누르면 정렬, 구를 누르면 그 구의 단지 순위로 이동합니다. 출근(분) = 필터의 출근지(${HUB_NAMES[cwIdx()]}) 기준.</div>`;
  $$(".gu-tbl th[data-k]").forEach((th) => (th.onclick = () => {
    const col = GU_COLS.find((c) => c[0] === th.dataset.k);
    store.set("guSort", [th.dataset.k, key === th.dataset.k ? !desc : col[3]]); renderList();
  }));
  $$(".gu-tbl tr[data-g]").forEach((tr) => (tr.onclick = () => {
    $("#f-gu").value = tr.dataset.g; saveFilters(); setListView("rank");
  }));
}
function setListView(v) {
  store.set("listView", v);
  $$("#list-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  renderList();
}

function renderList() {
  if (store.get("listView", "rank") === "gu") return renderGuTable();
  const xs = filtered();
  $("#count").textContent = `${xs.length.toLocaleString()}개 단지` + (xs.length > 200 ? " (상위 200개 표시)" : "");
  $("#list").innerHTML = xs.length ? xs.slice(0, 200).map((i, k) => itemHTML(i, k + 1)).join("")
    : `<div class="empty">조건에 맞는 단지가 없습니다</div>`;
  bindItems($("#list"));
}
function renderFav() {
  const xs = favs().map((c) => state.byCode[c]).filter(Boolean);
  $("#fav").innerHTML = xs.length ? xs.map((i) => itemHTML(i)).join("")
    : `<div class="empty">아직 관심단지가 없습니다.<br>단지를 열고 ☆를 눌러 추가하세요.</div>`;
  bindItems($("#fav"));
  $("#fav-note").textContent = cloud.ready ? "(내 계정에 저장 · 폰·PC 공통)" : "(이 기기에만 저장 — 로그인하면 모든 기기에서 보입니다)";
  if ($("#tab-fav").classList.contains("active")) renderFeed();
}
function renderCmpBar() {
  const n = cmps().length;
  $("#cmp-bar").hidden = n === 0;
  $("#cmp-bar").textContent = `📊 단지 비교 (${n})`;
}

// ---------- 라우팅 (#c=단지코드 / #s=청약공고 / #cmp / #join) ----------
function openDetail(code) { location.hash = "c=" + encodeURIComponent(code); }
function route() {
  const m = location.hash.match(/^#c=([^&]+)/);
  if (m && state.byCode[decodeURIComponent(m[1])]) renderDetail(decodeURIComponent(m[1]));
  else if (location.hash.startsWith("#s=")) renderSub(decodeURIComponent(location.hash.slice(3)));
  else if (location.hash === "#cmp" && cmps().length) renderCompare();
  else if (location.hash === "#join") renderJoin();
  else if (location.hash === "#score") renderScorecard();
  else if (location.hash.startsWith("#guide")) renderGuide(location.hash.split("-")[1]);
  else closeSheet();
}
function closeSheet() {
  $("#sheet").hidden = $("#sheet-bg").hidden = true;
  for (const k of ["chart", "cmpChart"]) if (state[k]) { state[k].destroy(); state[k] = null; }
}
function openSheet(html) {
  closeSheet();
  $("#sheet").innerHTML = `<div class="grab"></div>` + html;
  $("#sheet").hidden = $("#sheet-bg").hidden = false;
  $("#sheet").scrollTop = 0;
  $$("#sheet [data-close]").forEach((b) => (b.onclick = () => history.back()));
}
const getDetail = async (code) => (await fetch(`data/c/${encodeURIComponent(code)}.json`)).json();
const chartColors = () => matchMedia("(prefers-color-scheme: dark)").matches ? "#9aa1ac" : "#6b7280";

// ---------- 단지 상세 ----------
async function renderDetail(code) {
  const i = state.byCode[code];
  const s = seen(); s[code] = i.last; store.set("seen", s);   // 새 거래 표시 해제
  const kakaoUrl = i.la ? `https://map.kakao.com/link/map/${encodeURIComponent(i.n)},${i.la},${i.lo}`
    : `https://map.kakao.com/?q=${encodeURIComponent(`서울 ${i.g} ${i.d} ${i.j}`)}`;
  const roadUrl = i.la ? `https://map.kakao.com/link/roadview/${i.la},${i.lo}` : kakaoUrl;
  const naverUrl = `https://m.land.naver.com/search/result/${encodeURIComponent(i.g + " " + i.n)}`;
  const kmsg = i.kp == null ? "주변(1.5km) 비교 단지가 부족합니다" :
    `주변 1.5km 단지보다 평당가가 <b class="${cls(-i.kp)}">${Math.abs(i.kp)}% ${i.kp < 0 ? "싸고" : "비싸고"}</b>` +
    (i.kr == null ? "" : `, 3년 상승률은 <b class="${cls(i.kr)}">${Math.abs(i.kr)}%p ${i.kr < 0 ? "덜 올랐습니다" : "더 올랐습니다"}</b>`);

  openSheet(`
    <div class="sh-head">
      <div style="flex:1"><h2>${esc(i.n)}</h2><div class="addr">${esc(i.g)} ${esc(i.d)} ${esc(i.j)}${i.b ? " · " + esc(i.b) : ""}</div>
        ${i.al && i.al !== i.n ? `<div class="note">다른 이름: ${esc(i.al)}</div>` : ""}</div>
      <button class="icon-btn ${isFav(code) ? "on" : ""}" id="fav-btn" aria-label="관심단지">${isFav(code) ? "★" : "☆"}</button>
      <button class="icon-btn" data-close aria-label="닫기">✕</button>
    </div>
    <div class="sh-actions">
      <button id="cmp-btn" class="${inCmp(code) ? "on" : ""}">📊 ${inCmp(code) ? "비교에서 빼기" : "비교에 추가"}</button>
      <a href="${naverUrl}" target="_blank" rel="noopener">🏷️ 현재 매물</a>
      <a href="${roadUrl}" target="_blank" rel="noopener">👀 로드뷰</a>
      <a href="${kakaoUrl}" target="_blank" rel="noopener">🗺️ 카카오맵</a>
    </div>
    <div class="card lscard"><h3>📍 입지점수 <b class="lsc">${i.ls ?? "–"}</b><small>점</small>${guideLink("ls")}</h3>${i.la ? scoreBars(i)
      : `<div class="note">이 단지의 위치·세대수·학군 정보를 수집 중입니다. 매일 새벽 자동 수집으로 곧 채워집니다.</div>`}</div>
    <div class="stats">
      <div class="stat"><small>84㎡ 매매</small><b>${won(i.p84)}</b></div>
      <div class="stat"><small>84㎡ 전세</small><b>${won(i.j84)}</b></div>
      <div class="stat"><small>전세가율</small><b>${i.jr != null ? i.jr + "%" : "–"}</b></div>
      <div class="stat"><small>59㎡ 매매</small><b>${won(i.p59)}</b></div>
      <div class="stat"><small>59㎡ 전세</small><b>${won(i.j59)}</b></div>
      <div class="stat"><small>평당가</small><b>${won(i.p)}</b></div>
      <div class="stat"><small>1년 변동</small><b class="${cls(i.r1)}">${pct(i.r1)}</b></div>
      <div class="stat"><small>3년 변동</small><b class="${cls(i.r3)}">${pct(i.r3)}</b></div>
      <div class="stat"><small>거래(1년)</small><b>${i.n12}건 <small class="${cls(i.vt)}">${i.vt != null ? pct(i.vt) : ""}</small></b></div>
      <div class="stat"><small>준공</small><b>${i.y ?? "–"}년</b></div>
      <div class="stat"><small>세대수</small><b>${i.h ? i.h.toLocaleString() : "–"}</b></div>
      <div class="stat"><small>${esc(i.bz ?? "업무지구")}까지</small><b>${i.bk != null ? i.bk + "km" : "–"}</b></div>
    </div>
    <div class="card"><h3>시세 · 거래량 <span class="note">월별 중앙값 · 막대=거래건수</span></h3>
      <div class="bands" id="bands"></div><div class="chart-box"><canvas id="chart"></canvas></div></div>
    <div class="card"><h3>🔑 키맞추기${guideLink("keymatch")} <span class="note">주변 1.5km 단지</span></h3>
      <div class="kmsg">${kmsg}</div><table class="near" id="near"><tr><td>불러오는 중…</td></tr></table></div>
    ${i.dg ? `<div class="card"><h3>🛡️ 하락 방어력${guideLink("defense")} <span class="grade g${i.dg}">${i.dg}</span> <span class="note">${i.df}점 / 100${i.th ? " · 표본 적음" : ""}</span></h3>
      <table class="kv">
        <tr><td>2022 하락기 낙폭</td><td><b class="down">${i.dd != null ? "-" + i.dd + "%" : "–"}</b>${i.de ? ' <span class="note">(같은 구·연식대 평균으로 추정)</span>' : ""}</td></tr>
        <tr><td>지역 베타 <span class="note">1보다 크면 구 평균보다 출렁임</span></td><td>${i.bt ?? "–"}</td></tr>
        <tr><td>전세가율 (최근 6개월)</td><td>${i.jr2 != null ? i.jr2 + "%" : "–"}${i.jw ? ' <span class="badge">80%↑ 깡통전세 주의</span>' : ""}</td></tr>
        <tr><td>${esc(i.g)} 2년 내 입주물량</td><td>${i.su != null ? "구 세대의 " + i.su + "%" : "–"}</td></tr>
        <tr><td>거래회전율 (1년 거래÷세대)</td><td>${i.to != null ? i.to + "%" : "–"}</td></tr>
      </table>
      <div class="note">구성: 낙폭 35% · 베타 15% · 전세가율 20% · 입주물량 15% · 회전율 15% (서울 내 백분위). 가중치는 백테스트로 조정 예정.</div></div>` : ""}
    ${i.fv ? `<div class="card"><h3>⚖️ 모델 적정가${guideLink("fair")} <span class="note">위치·연식·규모·브랜드·역·학군으로 학습 (이 동네는 빼고 예측)</span></h3>
      <div class="kmsg">모델 적정가 평당 <b>${won(Math.round(i.fv))}</b> vs 보정 시세 <b>${won(Math.round(i.vp))}</b>
        → <b class="${cls(i.gp)}">${i.gp > 0 ? "모델보다 " + i.gp + "% 비쌈" : "모델보다 " + Math.abs(i.gp) + "% 쌈"}</b></div>
      ${i.rs ? `<div>가격을 만드는 요인: ${i.rs.map((r) => `<span class="tag">${esc(r)}</span>`).join(" ")}</div>` : ""}
      <div class="note" style="margin-top:6px">⚠️ 백테스트 결과 '모델보다 싼 단지'가 이후 더 오르지는 않았습니다 (모델이 못 보는 약점 때문에 싼 경우가 많음).
        매수 신호가 아니라 <b>가격 수준 참고용</b>입니다. <a href="#score">점수 성적표 보기</a></div></div>` : ""}
    ${i.vp ? `<div class="card"><h3>🧹 보정 시세${guideLink("price")} <span class="note">해제·직거래·이상치 제외, 층 보정, 거래 적으면 주변 시세로 보완</span></h3>
      <div>평당 <b>${won(Math.round(i.vp))}</b> <span class="tag">신뢰도 ${{ high: "높음", mid: "보통", low: "낮음" }[i.cf] ?? "–"}</span>
      ${i.ac != null ? ` · 출근 접근성 <b>${i.ac}</b>점 <span class="note">(임시: 업무지구 7곳 직선거리 기반)</span>` : ""}</div></div>` : ""}
    <div class="card"><h3>🚇 교통 · 출근 시간${guideLink("ac")}</h3>
      <div>${esc(i.st ?? "–")} <b>${dist(i.sd)}</b>${i.sl > 1 ? ` · 500m 안 ${i.sl}개 노선` : ""}</div>
      ${i.ct ? `<table class="kv commute">${HUB_NAMES.map((h, k) => [h, i.ct[k]]).filter(([, m]) => m != null).sort((x, y) => x[1] - y[1])
        .map(([h, m]) => `<tr class="${h === HUB_NAMES[cwIdx()] ? "sel" : ""}"><td>🏙️ ${h}</td><td><i style="--v:${Math.max(4, 100 - m)}%"></i></td><td><b>${m}분</b></td></tr>`).join("")}</table>
        <div class="note">대중교통(지하철·광역철도) 기준 근사치 — 도보·대기·환승 포함. 버스 노선은 일부만 반영됩니다.</div>`
        : `<div class="note">출근 시간 계산 대기 중 (위치 정보 수집 후 자동 계산)</div>`}</div>
    <div class="card"><h3>🎒 학군 <b class="lsc">${i.sE ?? "–"}</b><small>점</small>${guideLink("edu")}
      ${eduTags(i).map((t) => `<span class="tag">${t}</span>`).join(" ")}</h3>
      ${i.es == null && i.a1 == null ? `<div class="note">학군 정보를 수집 중입니다 (곧 자동으로 채워집니다)</div>` : `
      <table class="kv">${(() => { const p = eduParts(i); return [
        ["초등학교", i.es, i.em, p.초, "35%"], ["중학교", i.ms, i.mm, p.중, "20%"], ["고등학교", i.hs, i.hm, p.고, "15%"],
      ].map(([k, n, m, s, w]) => `<tr><td>${k} <span class="note">${w}</span></td><td>${esc(n ?? "2km 안 없음")}</td><td><b>${dist(m)}</b></td><td>${s ?? "–"}점</td></tr>`).join("") +
        `<tr><td>학원가 <span class="note">30%</span></td><td>1km 안 ${i.a1 ?? "–"}개 · 500m 안 ${i.a5 ?? "–"}개</td>
          <td>${i.a1 != null ? "상위 " + (100 - p.학원) + "%" : "–"}</td><td>${p.학원 ?? "–"}점</td></tr>`; })()}</table>
      <div class="note">초품아 = 초등학교 300m 이내. 거리는 직선거리. 학교별 학업성취도는 2017년 이후 비공개라 학원가 밀도를 학군 대리지표로 사용합니다.</div>`}</div>
    <div class="card"><h3>최근 거래</h3><table id="trades"><tr><td>불러오는 중…</td></tr></table></div>
    <div class="card" id="remarks"></div>
    <div class="card"><h3>📝 내 메모 <span class="note">나만 보임</span></h3>
      <textarea id="memo" placeholder="임장 메모, 장단점, 호가 등">${esc(memo(code))}</textarea>
      <div class="note">${cloud.ready ? "내 계정에 자동 저장 (폰·PC 공통)" : "이 기기에 자동 저장 — 로그인하면 모든 기기에서 보입니다"}</div></div>`);

  $("#fav-btn").onclick = (e) => {
    toggleFav(code);
    e.currentTarget.classList.toggle("on", isFav(code));
    e.currentTarget.textContent = isFav(code) ? "★" : "☆";
    renderList(); renderFav();
  };
  $("#cmp-btn").onclick = (e) => {
    if (!inCmp(code) && cmps().length >= 4) return alert("비교는 최대 4개 단지까지 가능합니다");
    store.set("cmp", inCmp(code) ? cmps().filter((x) => x !== code) : [...cmps(), code]);
    e.currentTarget.classList.toggle("on", inCmp(code));
    e.currentTarget.textContent = "📊 " + (inCmp(code) ? "비교에서 빼기" : "비교에 추가");
    renderCmpBar();
  };
  $("#memo").oninput = (e) => { store.set("memo:" + code, e.target.value); cloud.setMemo(code, e.target.value); };
  renderRemarks(code);

  const d = await getDetail(code);
  $("#trades").innerHTML = "<tr><th>계약일</th><th>전용</th><th>층</th><th>거래가</th></tr>" +
    d.trades.map(([dt, a, f, p]) => `<tr><td>${dt}</td><td>${a}㎡</td><td>${f}</td><td>${won(p)}</td></tr>`).join("");
  $("#near").innerHTML = d.near?.length ? "<tr><th>단지</th><th>거리</th><th>평당가</th><th>3년</th><th>전세가율</th></tr>" +
    d.near.map((o) => `<tr data-c="${o.c}"><td class="nm">${esc(o.n)}</td><td>${o.km}km</td><td>${won(o.p)}</td>
      <td class="${cls(o.r3)}">${pct(o.r3)}</td><td>${o.jr != null ? o.jr + "%" : "–"}</td></tr>`).join("")
    : "<tr><td>주변 비교 단지 없음</td></tr>";
  $$("#near tr[data-c]").forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.c)));

  const bands = Object.keys(d.series).sort((a, b) => d.series[b].length - d.series[a].length);
  const vol = Object.fromEntries(d.vol);
  const draw = (band) => {
    $$("#bands button").forEach((b) => b.classList.toggle("on", b.dataset.b === band));
    const sale = Object.fromEntries(d.series[band].map((x) => [x[0], x]));
    const jeon = Object.fromEntries((d.jseries[band] || []).map((x) => [x[0], x]));
    const months = [...new Set([...Object.keys(sale), ...Object.keys(jeon)])].sort();
    if (state.chart) state.chart.destroy();
    const tc = chartColors();
    state.chart = new Chart($("#chart"), {
      data: { labels: months, datasets: [
        { type: "line", label: "매매", data: months.map((m) => sale[m] ? sale[m][1] / 10000 : null), borderColor: "#0f766e",
          backgroundColor: "#0f766e", spanGaps: true, tension: 0.25, pointRadius: months.length > 24 ? 0 : 3, yAxisID: "y" },
        { type: "line", label: "전세", data: months.map((m) => jeon[m] ? jeon[m][1] / 10000 : null), borderColor: "#f59e0b",
          backgroundColor: "#f59e0b", spanGaps: true, tension: 0.25, pointRadius: months.length > 24 ? 0 : 3, yAxisID: "y" },
        { type: "bar", label: "거래량(전체)", data: months.map((m) => vol[m] || 0), backgroundColor: "#94a3b855", yAxisID: "v" },
      ] },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: tc, boxWidth: 12 } },
          tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === "v" ? `거래 ${c.raw}건` : `${c.dataset.label} ${won(Math.round(c.raw * 10000))}` } } },
        scales: { y: { ticks: { callback: (v) => v + "억", color: tc } },
                  v: { position: "right", grid: { display: false }, ticks: { color: tc, precision: 0 }, beginAtZero: true },
                  x: { ticks: { maxTicksLimit: 6, color: tc } } } },
    });
  };
  $("#bands").innerHTML = bands.map((b) => `<button data-b="${b}">${/^\d+$/.test(b) ? b + "㎡" : b}</button>`).join("");
  $$("#bands button").forEach((b) => b.addEventListener("click", () => draw(b.dataset.b)));
  if (bands.length) draw(bands.includes("84") ? "84" : bands[0]);
  renderList(); renderFav();
}

// ---------- 지인 리마크 ----------
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 3600 ? Math.max(1, Math.floor(s / 60)) + "분 전" : s < 86400 ? Math.floor(s / 3600) + "시간 전"
    : s < 86400 * 30 ? Math.floor(s / 86400) + "일 전" : iso.slice(0, 10);
};
function remarkTarget(code) {   // 리마크가 달린 단지 또는 청약 공고 링크
  if (state.byCode[code]) return `<a class="rm-cx" href="#c=${encodeURIComponent(code)}">${esc(state.byCode[code].n)}</a>`;
  const no = code.startsWith("청약-") ? code.slice(3) : null;
  const s = no && (state.subs || []).find((x) => x.no === no);
  return s ? `<a class="rm-cx" href="#s=${encodeURIComponent(subKey(s))}">🏠 ${esc(s.n)} (청약)</a>` : "";
}
const remarkHTML = (r, withComplex) => `
  <li class="rm" data-id="${r.id}">
    <div class="rm-head"><span class="rm-kind">${REMARK_KINDS[r.kind] || "💬"} ${esc(r.kind)}</span>
      <b>${esc(r.members?.nickname ?? "?")}</b> <span class="note">${ago(r.created_at)}</span>
      ${r.user_id === cloud.user?.id ? `<button class="rm-del" data-del="${r.id}">삭제</button>` : ""}</div>
    ${withComplex ? remarkTarget(r.complex_code) : ""}
    ${r.body ? `<div class="rm-body">${esc(r.body)}</div>` : ""}
  </li>`;
function bindRemarkDeletes(root, after) {
  root.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("이 리마크를 삭제할까요?")) return;
    await cloud.deleteRemark(+b.dataset.del); after();
  }));
}
async function renderRemarks(code) {
  const box = $("#remarks");
  if (!box) return;
  if (!cloud.ready) {
    box.innerHTML = `<h3>👥 지인 리마크</h3><div class="note">${cloud.user ? "초대코드를 입력하면 그룹 리마크를 보고 남길 수 있습니다."
      : "로그인하면 지인들이 남긴 추천·주의·임장 후기를 보고 남길 수 있습니다."}</div>
      <button class="btn" id="rm-login">${cloud.user ? "그룹 가입하기" : "카카오로 로그인"}</button>`;
    $("#rm-login").onclick = () => (cloud.user ? openJoin() : cloud.login());
    return;
  }
  box.innerHTML = `<h3>👥 지인 리마크</h3>
    <div class="kinds">${Object.entries(REMARK_KINDS).map(([k, e], n) =>
      `<button data-k="${k}" class="${n === 0 ? "on" : ""}">${e} ${k}</button>`).join("")}</div>
    <textarea id="rm-body" maxlength="500" placeholder="예: 역까지 실제로 걸어보니 7분, 언덕 없음"></textarea>
    <button class="btn" id="rm-add">남기기</button>
    <ol class="rms" id="rm-list"><li class="note">불러오는 중…</li></ol>`;
  let kind = "추천";
  box.querySelectorAll(".kinds button").forEach((b) => (b.onclick = () => {
    kind = b.dataset.k; box.querySelectorAll(".kinds button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#rm-add").onclick = async () => {
    const btn = $("#rm-add"); btn.disabled = true;
    try { await cloud.addRemark(code, kind, $("#rm-body").value); $("#rm-body").value = ""; await list(); }
    catch (e) { alert("저장 실패: " + e.message); }
    btn.disabled = false;
  };
  const list = async () => {
    const rs = await cloud.remarks(code);
    $("#rm-list").innerHTML = rs.length ? rs.map((r) => remarkHTML(r)).join("") : `<li class="note">아직 리마크가 없습니다. 첫 리마크를 남겨보세요!</li>`;
    bindRemarkDeletes($("#rm-list"), list);
  };
  list();
}
async function renderFeed() {
  const box = $("#feed");
  if (!cloud.ready) { box.innerHTML = ""; return; }
  const [rs] = await Promise.all([cloud.recent(30), loadSubs()]);
  box.innerHTML = `<div class="count">👥 최근 지인 리마크</div>` +
    (rs.length ? `<ol class="rms feed">${rs.map((r) => remarkHTML(r, true)).join("")}</ol>` : `<div class="empty">아직 리마크가 없습니다</div>`);
  bindRemarkDeletes(box, renderFeed);
}

// ---------- 로그인 · 그룹 가입 ----------
function renderAuth() {
  const b = $("#auth-btn");
  b.textContent = cloud.ready ? `👤 ${cloud.member.nickname}` : cloud.user ? "그룹 가입" : "로그인";
  b.onclick = () => {
    if (cloud.ready) { if (confirm(`${cloud.member.nickname}님, 로그아웃할까요?`)) cloud.logout(); }
    else if (cloud.user) openJoin();
    else cloud.login();
  };
}
function openJoin() {
  if (location.hash === "#join") renderJoin(); else location.hash = "join";
}
function renderJoin() {
  if (!cloud.user) return history.back();
  openSheet(`
    <div class="sh-head"><h2 style="flex:1">👥 그룹 가입</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="card">
      <label class="field">초대코드<input id="j-code" autocomplete="off" placeholder="그룹 관리자에게 받은 코드"></label>
      <label class="field">닉네임<input id="j-nick" maxlength="20" placeholder="리마크에 표시될 이름"></label>
      <button class="btn" id="j-go">가입하기</button>
      <div class="note" id="j-msg">닉네임은 리마크에 표시됩니다. 지인들이 알아볼 수 있는 이름으로 정해주세요.</div>
    </div>`);
  $("#j-go").onclick = async () => {
    const code = $("#j-code").value, nick = $("#j-nick").value;
    if (!code.trim() || !nick.trim()) return ($("#j-msg").textContent = "초대코드와 닉네임을 모두 입력해주세요");
    try { await cloud.join(code, nick); history.back(); }
    catch (e) { $("#j-msg").textContent = "❌ " + e.message; }
  };
}

// ---------- 점수 가이드 ----------
const GUIDE = [
  ["data", "📦 데이터는 어디서 오나", `
    <ul>
      <li><b>매매·전월세 실거래가</b>: 국토교통부 (2016년~, 매일 새벽 3시 최근 3개월 다시 받음 — 늦은 신고·취소 반영)</li>
      <li><b>단지 정보</b>: 공동주택관리정보시스템(K-apt) 세대수·사용승인일·건설사</li>
      <li><b>위치·역·학교·학원</b>: 카카오 지도 검색 (역·학교 거리는 <b>직선거리</b>)</li>
      <li><b>청약</b>: 한국부동산원 청약홈 (공고·일정·분양가·경쟁률·당첨가점)</li>
    </ul>
    <div class="note">실거래는 계약 후 30일 안에 신고되므로 <b>최근 한 달은 계속 채워지는 중</b>입니다.</div>`],
  ["ls", "📍 입지점수 (0~100점)", `
    <div>네 가지 점수를 <b>비중</b>대로 평균합니다. 비중은 순위 탭에서 직접 바꾸거나 프리셋을 고를 수 있습니다.</div>
    <table class="kv"><tr><th>프리셋</th><th>출근</th><th>규모</th><th>학군</th><th>역</th></tr>
      ${Object.entries(PRESETS).map(([k, w]) => `<tr><td>${k === "데이터 추천형" ? "⭐ " : ""}${k}</td><td>${w.a}</td><td>${w.h}</td><td>${w.e}</td><td>${w.s}</td></tr>`).join("")}</table>
    <div class="note">⭐ 데이터 추천형 = 2022~26 백테스트에서 이후 상승률과 관련이 컸던 순서(업무지구 > 규모 ≈ 학군 > 역)대로 정한 비중.
      위치 정보가 아직 없는 단지는 점수를 보류합니다.</div>`],
  ["ac", "🏙️ 출근 시간 · 출근 접근성", `
    <div><b>출근 시간(분)</b>: 단지 → (도보 또는 버스) → 지하철역 → (노선·환승) → 업무지구 역 → 도보 5분.
      수도권 지하철·광역철도 22개 노선(1~9호선, 신분당, 경의중앙, 수인분당, 공항철도, GTX-A, 서해, 경춘, 경강, 우이신설, 신림, 김포골드 등)의
      역 순서·위치(OpenStreetMap)로 계산합니다.</div>
    <table class="kv"><tr><td>도보</td><td>직선거리 × 1.25 ÷ 시속 4.5km</td></tr>
      <tr><td>역이 1.2km보다 멀면</td><td>버스 연계도 비교 (시속 15km + 대기 7분)</td></tr>
      <tr><td>승차 대기 / 환승</td><td>4분 / 5~6분</td></tr>
      <tr><td>열차 평균 속도(정차 포함)</td><td>일반 31 · 수인분당 36 · 경의중앙·경춘 42 · 급행 45 · 공항철도 50 · 신분당 55 · GTX-A 80 km/h</td></tr></table>
    <div><b>출근 접근성(0~100)</b>: 업무지구 7곳 출근 시간을 일자리 가중치로 합친 값(가까울수록 큼)의 서울 내 백분위.
      가중치 강남 1.5 · 광화문 1.0 · 여의도 0.6 · 판교 0.3 · 성수 0.3 · 마곡 0.2 · 가산 0.2 (고소득 일자리 밀집도 기준 임시값).</div>
    <div class="note">실제 길찾기 앱보다 ±5~10분 차이가 날 수 있는 <b>근사치</b>입니다. 배차 간격·혼잡·급행 대기는 반영하지 않습니다.
      순위 탭 필터에서 "출근지 + 몇 분 이내"로 거를 수 있습니다.</div>`],
  ["size", "🏢 단지 규모", `
    <table class="kv"><tr><td>2,000세대 이상</td><td>100</td></tr><tr><td>1,000~1,999</td><td>80</td></tr><tr><td>500~999</td><td>60</td></tr>
      <tr><td>300~499</td><td>40</td></tr><tr><td>300 미만 · 세대수 정보 없음</td><td>20</td></tr></table>
    <div class="note">세대수 정보가 없는 단지는 대부분 K-apt 미등록 소규모 단지라 20점으로 봅니다.</div>`],
  ["edu", "🎒 학군 (초·중·고 + 학원가)", `
    <table class="kv"><tr><th>항목</th><th>비중</th><th>100점</th><th>75점</th><th>50점</th><th>25점</th></tr>
      <tr><td>초등학교</td><td>35%</td><td>≤300m</td><td>≤500m</td><td>≤800m</td><td>그 이상</td></tr>
      <tr><td>중학교</td><td>20%</td><td>≤500m</td><td>≤800m</td><td>≤1.2km</td><td>그 이상</td></tr>
      <tr><td>고등학교</td><td>15%</td><td>≤700m</td><td>≤1km</td><td>≤1.5km</td><td>그 이상</td></tr></table>
    <div>학원가(30%): 1km 안 학원 수가 서울 단지 중 상위 몇 %인지(백분위)를 점수로 씁니다.</div>
    <div class="note">태그: <b>초품아</b>(초등학교 300m 이내) · <b>대치/목동/중계 학원가</b> · <b>학원 밀집 상위 5%/15%</b>.
      학교별 학업성취도는 2017년 이후 비공개라 학원가 밀도를 학군 대리지표로 씁니다. 거리는 직선거리입니다.</div>`],
  ["st", "🚇 역세권", `
    <table class="kv"><tr><td>≤300m</td><td>100</td></tr><tr><td>≤500m</td><td>80</td></tr><tr><td>≤800m</td><td>60</td></tr>
      <tr><td>≤1km</td><td>45</td></tr><tr><td>≤1.5km</td><td>25</td></tr><tr><td>그 이상</td><td>10</td></tr></table>
    <div class="note">환승 보너스: 500m 안에 노선이 하나 더 있을 때마다 +10점 (최대 100).</div>`],
  ["price", "🧹 보정 시세 · 상승률", `
    <ol>
      <li><b>정제</b>: 취소(해제)된 거래와 직거래(가족 간 저가 거래 등) 제외</li>
      <li><b>층 보정</b>: 저층(3층 이하·하위 20%)·고층(상위 20%) 거래를 구별 계수로 중층 기준 가격으로 환산</li>
      <li><b>이상치 제거</b>: 같은 단지·면적·분기 안에서 너무 튀는 거래(로버스트 Z 3 초과) 제외</li>
      <li><b>보정</b>: 최근 6개월 거래가 적으면 같은 동·비슷한 연식 시세 쪽으로 당겨 안정화 (거래 n건 : 기준값 5건 비율)</li>
    </ol>
    <div>신뢰도: 최근 6개월 거래 <b>10건 이상 높음</b> · 3~9건 보통 · 2건 이하 낮음</div>
    <div class="note">목록의 1년·3년 상승률은 최근 12개월 평당가 중앙값을 1년 전·3년 전 같은 기간과 비교한 값입니다.</div>`],
  ["defense", "🛡️ 하락 방어력 (A~D)", `
    <table class="kv"><tr><th>요소</th><th>비중</th><th>위험한 쪽</th></tr>
      <tr><td>2022 하락기 낙폭 (2021.1~22.6 고점 → 22.7~23.12 저점)</td><td>35%</td><td>클수록</td></tr>
      <tr><td>지역 베타 (구 시세보다 얼마나 출렁이나)</td><td>15%</td><td>클수록</td></tr>
      <tr><td>전세가율 (최근 6개월)</td><td>20%</td><td>낮을수록</td></tr>
      <tr><td>구 2년 내 입주물량 ÷ 구 세대수</td><td>15%</td><td>클수록</td></tr>
      <tr><td>거래회전율 (1년 거래 ÷ 세대수)</td><td>15%</td><td>낮을수록</td></tr></table>
    <div>각 요소를 서울 내 백분위로 바꿔 합친 뒤 0~100점(높을수록 방어력 강함), <b>4등분해 A~D</b>로 나눕니다.</div>
    <div class="note">2022년 이후 준공 등 낙폭 자료가 없거나 고점·저점 거래가 2건 미만이면 같은 구·연식대 평균으로 추정합니다.
      2021~23년 거래 10건 미만은 <b>표본 적음</b>으로 표시합니다. 전세가율 80% 초과는 깡통전세 주의 표시.
      서울 아파트는 토지거래허가구역이라 전세가율은 투자 매력이 아니라 실수요 지지력으로만 해석하세요.</div>`],
  ["fair", "⚖️ 모델 적정가", `
    <div>2019년 이후 정제된 거래로 <b>AI 모델(LightGBM)</b>이 "위치·연식·면적·층·세대수·역·학교·학원·브랜드·업무지구 거리 → 가격" 관계를 학습합니다.</div>
    <div>단지의 적정가는 <b>그 단지가 있는 동네(법정동)를 빼고 학습한 모델</b>로 예측합니다 — 모델이 그 단지 가격을 외워버리는 것을 막기 위해서입니다.</div>
    <div>"가격을 만드는 요인"은 각 특성이 가격을 몇 % 올리거나 내렸는지(SHAP 기여도) 상위 3개입니다.</div>
    <div class="note">⚠️ 백테스트 결과 '모델보다 싼 단지'가 이후 더 오르지는 않았습니다. <b>매수 신호가 아니라 가격 수준 참고용</b>입니다.</div>`],
  ["keymatch", "🔑 키맞추기", `
    <div>반경 1.5km 안 단지들과 비교해 <b>평당가가 몇 % 싼지/비싼지</b>, <b>3년 상승률이 몇 %p 덜/더 올랐는지</b>를 보여줍니다.</div>
    <div class="note">연식 차이는 아직 보정하지 않아 신축은 '비싸게', 구축은 '싸게' 나오기 쉽습니다.</div>`],
  ["subs", "🏠 청약 예상 차익", `
    <div>분양가(최고가, 전용면적 기준 평당가) vs <b>주변 1km 안 10년 이내 신축</b> 시세(3곳 미만이면 1km 안 전체)를 비교합니다.
      84㎡ 기준 차익 = 주변 84㎡ 시세 − 84㎡ 분양가.</div>
    <div class="note">옵션·발코니 확장비 제외. 전매제한·실거주의무·자금조달은 반드시 모집공고문에서 확인하세요.
      경쟁률·당첨가점은 1순위 해당지역(서울 거주) 기준입니다.</div>`],
  ["limit", "⚠️ 꼭 알아둘 한계", `
    <ul>
      <li>모든 점수는 <b>과거 데이터 기반 참고 지표</b>이며 미래 수익을 보장하지 않습니다. 투자 판단은 본인 책임입니다.</li>
      <li>조망·동 배치·소음·관리 상태·재건축 진행 등 데이터로 안 잡히는 요소는 반영되지 않습니다 — <b>임장 필수</b>.</li>
      <li>거리는 직선거리라 실제 도보 시간(언덕·횡단보도)과 다를 수 있습니다.</li>
      <li>백테스트는 2022~26년 한 번의 시장 국면 결과입니다. 자세한 검증은 <a href="#score">📊 점수 성적표</a>에서 볼 수 있습니다.</li>
    </ul>`],
];
function renderGuide(focus) {
  openSheet(`
    <div class="sh-head"><h2 style="flex:1">📖 점수 가이드</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="note" style="margin-bottom:10px">이 앱의 모든 점수가 어떻게 계산되는지 설명합니다. 계산 코드와 같은 기준입니다.</div>
    <div class="toc">${GUIDE.map(([id, t]) => `<a href="#guide-${id}">${t}</a>`).join("")}</div>
    ${GUIDE.map(([id, t, body]) => `<section class="card guide" id="g-${id}"><h3>${t}</h3>${body}</section>`).join("")}`);
  if (focus) document.getElementById("g-" + focus)?.scrollIntoView();
}
const guideLink = (id) => ` <a class="ginfo" href="#guide-${id}" title="어떻게 계산되나요?">ⓘ</a>`;

// ---------- 점수 성적표 (백테스트 공개) ----------
function renderScorecard() {
  const bt = state.meta.backtest || [], fm = state.meta.fair;
  const factors = bt.length ? Object.keys(bt[0].factors || {}) : [];
  const cell = (v) => `<td class="${v > 0.1 ? "up" : v < -0.1 ? "down" : ""}">${v > 0 ? "+" : ""}${v.toFixed(2)}</td>`;
  openSheet(`
    <div class="sh-head"><h2 style="flex:1">📊 점수 성적표</h2><button class="icon-btn" data-close>✕</button></div>
    <div class="card"><h3>무엇을 검증했나</h3>
      <div>과거 시점(T)에 알 수 있었던 값으로 단지를 줄 세웠을 때, <b>T 이후 실제 상승률</b>과 얼마나 맞았는지(순위상관)를 봅니다.
      <b class="up">+</b>는 "값이 클수록 더 올랐다", <b class="down">−</b>는 "값이 작을수록(가까울수록) 더 올랐다". ±0.1 미만은 사실상 무관입니다.</div></div>
    ${bt.length ? `<div class="card" style="overflow-x:auto"><h3>요인별 성적 (순위상관)</h3>
      <table><tr><th>요인</th>${bt.map((b) => `<th>${b.cutoff.slice(2, 7).replace("-", ".")}<br><span class="note">→${b.years}년</span></th>`).join("")}</tr>
      ${factors.map((f) => `<tr><td>${esc(f)}</td>${bt.map((b) => cell(b.factors[f])).join("")}</tr>`).join("")}</table>
      <div class="note">검증 단지 수: ${bt.map((b) => b.n.toLocaleString()).join(" / ")}개 (기준 시점 직전 6개월 거래 3건 이상)</div></div>
    <div class="card"><h3>적정가 괴리율 5분위별 이후 상승률</h3>
      <table><tr><th></th>${Object.keys(bt[0].quintile_return_pct).map((q) => `<th>${q}</th>`).join("")}</tr>
      ${bt.map((b) => `<tr><td>${b.cutoff.slice(0, 7)}</td>${Object.values(b.quintile_return_pct).map((v) => `<td>${v}%</td>`).join("")}</tr>`).join("")}</table></div>` : `<div class="empty">백테스트 결과가 아직 없습니다</div>`}
    <div class="card"><h3>💡 해석</h3>
      <div>이 기간(2022~2026) 서울에서는 <b>업무지구에 가깝고, 이미 비싼 상급지, 대단지·브랜드</b>일수록 더 올랐고,
      <b>'모델보다 싼 단지'는 오히려 덜 올랐습니다</b>. 싼 데는 이유가 있는 경우가 많았다는 뜻입니다.</div>
      <div class="note" style="margin-top:6px">한계: 세 검증 구간이 모두 현재에서 끝나 서로 독립적이지 않고, 양극화 장세 한 번의 결과입니다.
      과거 패턴이 미래에도 반복된다는 보장은 없습니다. 투자 판단은 본인 책임입니다.</div></div>
    ${fm ? `<div class="card"><h3>⚖️ 적정가 모델 정보</h3>
      <div>학습: 거래 ${fm.trades.toLocaleString()}건 · 단지 ${fm.complexes.toLocaleString()}개 (${fm.since.slice(0, 4)}년~)</div>
      <div>공간 교차검증 오차: 전체 <b>${(fm.mape * 100).toFixed(1)}%</b> · 최근 1년 ${(fm.mape_recent * 100).toFixed(1)}% <span class="note">(그 동네를 빼고 예측했을 때)</span></div>
      <div style="margin-top:6px">가격 결정 요인 비중: ${Object.entries(fm.weights).filter(([, v]) => v > 0.005).map(([k, v]) => `<span class="tag">${esc(k)} ${Math.round(v * 100)}%</span>`).join(" ")}</div></div>` : ""}`);
}

// ---------- 단지 비교 ----------
async function renderCompare() {
  const codes = cmps().filter((c) => state.byCode[c]);
  const xs = codes.map((c) => state.byCode[c]);
  const palette = ["#0f766e", "#f59e0b", "#6366f1", "#e11d48"];
  const rows = [
    ["입지점수", (i) => i.ls ?? "–"], ["출근/규모/학군/역", (i) => `${i.sA ?? "–"}/${i.sH ?? "–"}/${i.sE ?? "–"}/${i.sS ?? "–"}`],
    ["초·중·고", (i) => `${dist(i.em)}<br>${dist(i.mm)}<br>${dist(i.hm)}`],
    ["84㎡ 매매", (i) => won(i.p84)], ["84㎡ 전세", (i) => won(i.j84)], ["전세가율", (i) => i.jr != null ? i.jr + "%" : "–"],
    ["평당가", (i) => won(i.p)], ["1년", (i) => `<span class="${cls(i.r1)}">${pct(i.r1)}</span>`],
    ["3년", (i) => `<span class="${cls(i.r3)}">${pct(i.r3)}</span>`], ["주변대비", (i) => pct(i.kp)],
    ["준공", (i) => i.y ?? "–"], ["세대수", (i) => i.h?.toLocaleString() ?? "–"],
    ["역", (i) => `${esc(i.st ?? "–")}<br>${dist(i.sd)}`], ["초등학교", (i) => dist(i.em)], ["학원(1km)", (i) => i.a1 ?? "–"],
    ["거래(1년)", (i) => i.n12], ["하락 방어력", (i) => i.dg ? `${i.dg} (${i.df})` : "–"],
    ["'22 낙폭", (i) => i.dd != null ? `-${i.dd}%${i.de ? "*" : ""}` : "–"], ["출근 접근성", (i) => i.ac ?? "–"], ["출근(분) 강남/광화문/여의도", (i) => i.ct ? `${i.ct[1]}/${i.ct[0]}/${i.ct[2]}` : "–"],
  ];
  openSheet(`
    <div class="sh-head"><h2 style="flex:1">📊 단지 비교</h2>
      <button class="icon-btn" id="cmp-clear">비우기</button><button class="icon-btn" data-close>✕</button></div>
    <div class="card"><h3>평당가 추이 <span class="note">월별 중앙값 (평형 무관 비교)</span></h3>
      <div class="chart-box"><canvas id="cmp-chart"></canvas></div></div>
    <div class="card" style="overflow-x:auto"><table class="cmp-tbl">
      <tr><th></th>${xs.map((i, k) => `<th style="color:${palette[k]}">${esc(i.n)}</th>`).join("")}</tr>
      ${rows.map(([l, f]) => `<tr><td>${l}</td>${xs.map((i) => `<td>${f(i)}</td>`).join("")}</tr>`).join("")}
    </table></div>
    <div class="note">단지 상세에서 "비교에 추가"로 최대 4개까지 담을 수 있습니다.</div>`);
  $("#cmp-clear").onclick = () => { store.set("cmp", []); renderCmpBar(); history.back(); };

  const ds = await Promise.all(codes.map(getDetail));
  const months = [...new Set(ds.flatMap((d) => d.pp.map((x) => x[0])))].sort();
  const tc = chartColors();
  state.cmpChart = new Chart($("#cmp-chart"), {
    type: "line",
    data: { labels: months, datasets: ds.map((d, k) => {
      const m = Object.fromEntries(d.pp);
      return { label: xs[k].n, data: months.map((x) => (m[x] != null ? m[x] : null)), borderColor: palette[k],
               backgroundColor: palette[k], spanGaps: true, tension: 0.25, pointRadius: months.length > 24 ? 0 : 3 };
    }) },
    options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: tc, boxWidth: 12 } },
                 tooltip: { callbacks: { label: (c) => `${c.dataset.label} 평당 ${won(c.raw)}` } } },
      scales: { y: { ticks: { callback: (v) => won(v), color: tc } }, x: { ticks: { maxTicksLimit: 6, color: tc } } } },
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
init().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<div class="empty">데이터를 불러오지 못했습니다: ${esc(e.message)}</div>`); });
