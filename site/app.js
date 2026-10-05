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
const PRESETS = {
  "균형형": { h: 33, e: 33, s: 34 },
  "자녀 학군형": { h: 20, e: 60, s: 20 },
  "출퇴근형": { h: 20, e: 20, s: 60 },
  "대단지 안정형": { h: 50, e: 20, s: 30 },
};
const weights = () => store.get("weights", PRESETS["균형형"]);
function scoreSize(h) {
  if (h == null) return 20;   // K-apt 미등록 = 대부분 150세대 미만 소규모 단지
  return h >= 2000 ? 100 : h >= 1000 ? 80 : h >= 500 ? 60 : h >= 300 ? 40 : 20;
}
function scoreStation(sd, sl) {
  if (sd == null) return null;
  const base = sd <= 300 ? 100 : sd <= 500 ? 80 : sd <= 800 ? 60 : sd <= 1000 ? 45 : sd <= 1500 ? 25 : 10;
  return Math.min(100, base + Math.max(0, (sl || 0) - 1) * 10);
}
function scoreEdu(i) {
  const school = i.em == null ? null : i.em <= 300 ? 100 : i.em <= 500 ? 75 : i.em <= 800 ? 50 : 25;
  const acad = i.a1 == null ? null : state.acadPct(i.a1);
  if (school == null && acad == null) return null;
  if (school == null) return acad;
  if (acad == null) return school;
  return Math.round((school + acad) / 2);
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
    i.sH = scoreSize(i.h); i.sE = scoreEdu(i); i.sS = scoreStation(i.sd, i.sl);
    let sum = 0, wt = 0;
    for (const [s, k] of [[i.sH, "h"], [i.sE, "e"], [i.sS, "s"]]) if (s != null) { sum += s * w[k]; wt += w[k]; }
    i.ls = wt ? Math.round(sum / wt) : null;
  }
}
const bar = (label, v) => `<span class="sb"><em>${label}</em><i style="--v:${v ?? 0}%"></i><b>${v ?? "–"}</b></span>`;
const scoreBars = (i) => `<div class="sbars">${bar("규모", i.sH)}${bar("학군", i.sE)}${bar("역", i.sS)}</div>`;

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
  $$(".filters select").forEach((s) => s.addEventListener("change", () => { saveFilters(); renderList(); }));
  $("#f-more").addEventListener("click", () => ($("#more").hidden = !$("#more").hidden));
  $("#q").addEventListener("input", () => { if (!$("#tab-list").classList.contains("active")) showTab("list"); renderList(); });
  $("#sheet-bg").addEventListener("click", () => history.back());
  $("#m-color").addEventListener("change", () => { store.set("mcolor", $("#m-color").value); drawMarkers(); });
  $("#m-supply").addEventListener("change", toggleSupplyLayer);
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
    const m = location.hash.match(/c=([^&]+)/);
    if (m) renderRemarks(decodeURIComponent(m[1]));
    if (location.hash === "#join" && cloud.ready) history.back();
  });
  renderAuth();
  cloud.init().catch((e) => console.warn("로그인 서버 연결 실패", e));
}

function saveFilters() {
  const ids = ["#f-gu", "#f-sort", "#f-budget", "#f-hh", "#f-sd", "#f-es", "#f-age", "#f-n"];
  store.set("filters", Object.fromEntries(ids.map((id) => [id, $(id).value])));
}

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  store.set("tab", name);
  if (name === "map" && state.map) setTimeout(() => state.map.invalidateSize(), 0);
  if (name === "fav") renderFav();
  if (name === "supply") renderSupply();
}

// ---------- 입지점수 비중 패널 ----------
function buildWeightPanel() {
  $("#more").insertAdjacentHTML("beforebegin", `
    <div class="wpanel">
      <div class="wtitle">📍 입지점수 비중 <span class="note">— 세대수 · 학군 · 역세권</span></div>
      <div class="presets">${Object.keys(PRESETS).map((p) => `<button class="chip" data-p="${p}">${p}</button>`).join("")}</div>
      ${[["h", "🏢 단지 규모"], ["e", "🎒 학군"], ["s", "🚇 역세권"]].map(([k, l]) =>
        `<label class="wrow"><span>${l}</span><input type="range" min="0" max="100" step="5" data-k="${k}"><b data-v="${k}"></b></label>`).join("")}
    </div>`);
  const sync = () => {
    const w = weights(), tot = w.h + w.e + w.s || 1;
    $$(".wrow input").forEach((r) => (r.value = w[r.dataset.k]));
    $$(".wrow b").forEach((b) => (b.textContent = Math.round((w[b.dataset.v] / tot) * 100) + "%"));
    $$(".presets button").forEach((b) => {
      const p = PRESETS[b.dataset.p];
      b.classList.toggle("on", p.h === w.h && p.e === w.e && p.s === w.s);
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
};
function colorOf(mode, v) {
  if (v == null) return "#9ca3af";
  for (const [min, c] of COLOR_MODES[mode].stops) if (v >= min) return c;
}
function initMap() {
  state.map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([37.5565, 126.99], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);
  L.control.zoom({ position: "topright" }).addTo(state.map);
  state.layer = L.layerGroup().addTo(state.map);
  drawMarkers();
}
function drawMarkers() {
  if (!state.layer) return;
  const mode = $("#m-color").value;
  state.layer.clearLayers();
  for (const it of state.items) {
    const r = it.h ? Math.min(4 + Math.sqrt(it.h) / 6, 14) : 4;
    const rm = cloud.counts[it.c];   // 지인 리마크가 있는 단지는 굵은 테두리
    L.circleMarker([it.la, it.lo], { radius: r, weight: rm ? 3 : 1, color: rm ? "#111827" : "#fff", fillColor: colorOf(mode, it[mode]), fillOpacity: 0.85 })
      .bindTooltip(`${esc(it.n)} · 입지 ${it.ls ?? "–"} · ${won(it.p84)}`, { direction: "top" })
      .on("click", () => openDetail(it.c))
      .addTo(state.layer);
  }
  $("#legend").innerHTML = COLOR_MODES[mode].label + " " +
    [...COLOR_MODES[mode].stops.map(([, c, t]) => [c, t]), ["#9ca3af", "자료없음"]]
      .map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("");
}

// ---------- 입주물량 ----------
async function loadSupply() {
  if (state.supply) return state.supply;
  if (!state.meta.hasSupply) return (state.supply = []);
  try { state.supply = await (await fetch("data/supply.json")).json(); } catch { state.supply = []; }
  return state.supply;
}
async function toggleSupplyLayer() {
  if (state.supLayer) { state.map.removeLayer(state.supLayer); state.supLayer = null; }
  if (!$("#m-supply").checked) return;
  const sup = await loadSupply();
  state.supLayer = L.layerGroup().addTo(state.map);
  for (const s of sup) if (s.위도) {
    L.marker([+s.위도, +s.경도], { icon: L.divIcon({ className: "sup-marker", html: "🏗️", iconSize: [22, 22] }) })
      .bindTooltip(`${esc(s.단지명)} · 입주 ${s.입주예정월.slice(0, 4)}.${s.입주예정월.slice(4)} · ${(+s.공급세대수 || 0).toLocaleString()}세대`)
      .addTo(state.supLayer);
  }
  if (!sup.length) alert("입주물량 데이터가 아직 없습니다 (청약홈 API 연결 대기 중)");
}
async function renderSupply() {
  const sup = await loadSupply();
  if (!sup.length) {
    $("#supply").innerHTML = `<div class="empty">입주물량 데이터가 아직 없습니다.<br>청약홈 API 연결 후 자동으로 채워집니다.</div>`;
    return;
  }
  const byGu = {};
  for (const s of sup) byGu[s.구] = (byGu[s.구] || 0) + (+s.공급세대수 || 0);
  const years = {};
  for (const s of sup) (years[s.입주예정월.slice(0, 4)] ??= []).push(s);
  $("#supply").innerHTML =
    `<div class="sup-gu">${Object.entries(byGu).sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `<span>${esc(g)} <b>${n.toLocaleString()}</b></span>`).join("")}</div>` +
    Object.entries(years).sort().map(([y, xs]) => `
      <div class="sup-year">${y}년 입주 · ${xs.reduce((a, s) => a + (+s.공급세대수 || 0), 0).toLocaleString()}세대</div>
      <ol class="list">${xs.map((s) => `<li class="item" data-la="${s.위도}" data-lo="${s.경도}">
        <div class="nm">${esc(s.단지명)}</div><div class="px">${(+s.공급세대수 || 0).toLocaleString()}세대</div>
        <div class="sub">${esc(s.주소)}<br>${esc(s.시공사)}</div>
        <div class="chg">${s.입주예정월.slice(0, 4)}.${s.입주예정월.slice(4)}</div></li>`).join("")}</ol>`).join("");
  $$("#supply .item").forEach((el) => el.addEventListener("click", () => {
    if (!el.dataset.la) return;
    $("#m-supply").checked = true; toggleSupplyLayer(); showTab("map");
    state.map.setView([+el.dataset.la, +el.dataset.lo], 15);
  }));
}

// ---------- 순위 ----------
function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const gu = $("#f-gu").value, budget = +$("#f-budget").value * 10000, hh = +$("#f-hh").value,
        sd = +$("#f-sd").value, es = +$("#f-es").value, age = +$("#f-age").value, n = +$("#f-n").value;
  const xs = state.items.filter((i) =>
    (!q || [i.n, i.d, i.g, i.st].some((s) => s && s.toLowerCase().includes(q))) &&
    (!gu || i.g === gu) &&
    (!budget || (i.p84 != null && i.p84 <= budget)) &&
    (!hh || (i.h ?? 0) >= hh) &&
    (!sd || (i.sd != null && i.sd <= sd)) &&
    (!es || (i.em != null && i.em <= es)) &&
    (!age || (age > 0 ? i.y && thisYear - i.y <= age : i.y && thisYear - i.y >= -age)) &&
    (!n || i.n12 >= n));
  const hi = (k) => (i) => -(i[k] ?? -1e9), lo = (k) => (i) => i[k] ?? 1e9;
  const key = {
    ls: hi("ls"), r1: hi("r1"), r3: hi("r3"), kp: lo("kp"), kr: lo("kr"), jr: hi("jr"), n12: hi("n12"), vt: hi("vt"),
    sd: lo("sd"), bk: lo("bk"), em: lo("em"), a1: hi("a1"), pAsc: lo("p"), pDesc: hi("p"),
    rm: (i) => -(cloud.counts[i.c]?.n ?? 0),
  }[$("#f-sort").value];
  return xs.sort((a, b) => key(a) - key(b));
}
function sortMetric(i) {        // 정렬 기준에 맞는 오른쪽 아래 수치
  const s = $("#f-sort").value;
  return {
    r3: [`3년 ${pct(i.r3)}`, cls(i.r3)], kp: [`주변대비 ${pct(i.kp)}`, cls(-i.kp)], kr: [`주변대비 ${pctp(i.kr)}`, cls(i.kr)],
    jr: [`전세가율 ${i.jr ?? "–"}%`, ""], vt: [`거래 ${pct(i.vt)}`, cls(i.vt)],
    em: [`초 ${dist(i.em)}`, ""], a1: [`학원 ${i.a1 ?? "–"}`, ""],
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
      🚇 ${esc(i.st ?? "–")} ${dist(i.sd)}${i.sl > 1 ? ` · ${i.sl}개 노선` : ""}${i.em != null ? ` · 🎒 초 ${dist(i.em)}` : ""}</div>
    <div class="chg"><span class="lsc">${i.ls ?? "–"}<small>점</small></span><br><span class="${c}">${m}</span></div>
    ${scoreBars(i)}
  </li>`;
}
function bindItems(root) {
  root.querySelectorAll(".item[data-c]").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.c)));
}
function renderList() {
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

// ---------- 라우팅 (#c=단지코드 / #cmp) ----------
function openDetail(code) { location.hash = "c=" + encodeURIComponent(code); }
function route() {
  const m = location.hash.match(/c=([^&]+)/);
  if (m && state.byCode[decodeURIComponent(m[1])]) renderDetail(decodeURIComponent(m[1]));
  else if (location.hash === "#cmp" && cmps().length) renderCompare();
  else if (location.hash === "#join") renderJoin();
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
  const kakaoUrl = `https://map.kakao.com/link/map/${encodeURIComponent(i.n)},${i.la},${i.lo}`;
  const roadUrl = `https://map.kakao.com/link/roadview/${i.la},${i.lo}`;
  const naverUrl = `https://m.land.naver.com/search/result/${encodeURIComponent(i.g + " " + i.n)}`;
  const kmsg = i.kp == null ? "주변(1.5km) 비교 단지가 부족합니다" :
    `주변 1.5km 단지보다 평당가가 <b class="${cls(-i.kp)}">${Math.abs(i.kp)}% ${i.kp < 0 ? "싸고" : "비싸고"}</b>` +
    (i.kr == null ? "" : `, 3년 상승률은 <b class="${cls(i.kr)}">${Math.abs(i.kr)}%p ${i.kr < 0 ? "덜 올랐습니다" : "더 올랐습니다"}</b>`);

  openSheet(`
    <div class="sh-head">
      <div style="flex:1"><h2>${esc(i.n)}</h2><div class="addr">${esc(i.g)} ${esc(i.d)} ${esc(i.j)}${i.b ? " · " + esc(i.b) : ""}</div></div>
      <button class="icon-btn ${isFav(code) ? "on" : ""}" id="fav-btn" aria-label="관심단지">${isFav(code) ? "★" : "☆"}</button>
      <button class="icon-btn" data-close aria-label="닫기">✕</button>
    </div>
    <div class="sh-actions">
      <button id="cmp-btn" class="${inCmp(code) ? "on" : ""}">📊 ${inCmp(code) ? "비교에서 빼기" : "비교에 추가"}</button>
      <a href="${naverUrl}" target="_blank" rel="noopener">🏷️ 현재 매물</a>
      <a href="${roadUrl}" target="_blank" rel="noopener">👀 로드뷰</a>
      <a href="${kakaoUrl}" target="_blank" rel="noopener">🗺️ 카카오맵</a>
    </div>
    <div class="card lscard"><h3>📍 입지점수 <b class="lsc">${i.ls ?? "–"}</b><small>점</small></h3>${scoreBars(i)}</div>
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
    <div class="card"><h3>🔑 키맞추기 <span class="note">주변 1.5km 단지</span></h3>
      <div class="kmsg">${kmsg}</div><table class="near" id="near"><tr><td>불러오는 중…</td></tr></table></div>
    <div class="card"><h3>🚇 교통</h3>
      <div>${esc(i.st ?? "–")} <b>${dist(i.sd)}</b>${i.sl > 1 ? ` · 500m 안 ${i.sl}개 노선` : ""}</div>
      <div class="note">${esc(i.bz ?? "")} 업무지구 직선거리 ${i.bk ?? "–"}km</div></div>
    <div class="card"><h3>🎒 학군</h3>
      <div>초등학교: ${esc(i.es ?? "–")} <b>${dist(i.em)}</b>${i.em != null && i.em <= 300 ? '<span class="tag">초품아</span>' : ""}</div>
      <div>중학교: ${esc(i.ms ?? "–")} <b>${dist(i.mm)}</b></div>
      <div>학원: 500m 안 <b>${i.a5 ?? "–"}</b>개 · 1km 안 <b>${i.a1 ?? "–"}</b>개
        ${i.a1 != null ? `<span class="note">(서울 단지 중 상위 ${100 - state.acadPct(i.a1)}%)</span>` : ""}</div></div>
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
const remarkHTML = (r, withComplex) => `
  <li class="rm" data-id="${r.id}">
    <div class="rm-head"><span class="rm-kind">${REMARK_KINDS[r.kind] || "💬"} ${esc(r.kind)}</span>
      <b>${esc(r.members?.nickname ?? "?")}</b> <span class="note">${ago(r.created_at)}</span>
      ${r.user_id === cloud.user?.id ? `<button class="rm-del" data-del="${r.id}">삭제</button>` : ""}</div>
    ${withComplex && state.byCode[r.complex_code] ? `<a class="rm-cx" href="#c=${encodeURIComponent(r.complex_code)}">${esc(state.byCode[r.complex_code].n)}</a>` : ""}
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
  const rs = await cloud.recent(30);
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

// ---------- 단지 비교 ----------
async function renderCompare() {
  const codes = cmps().filter((c) => state.byCode[c]);
  const xs = codes.map((c) => state.byCode[c]);
  const palette = ["#0f766e", "#f59e0b", "#6366f1", "#e11d48"];
  const rows = [
    ["입지점수", (i) => i.ls ?? "–"], ["규모/학군/역", (i) => `${i.sH ?? "–"}/${i.sE ?? "–"}/${i.sS ?? "–"}`],
    ["84㎡ 매매", (i) => won(i.p84)], ["84㎡ 전세", (i) => won(i.j84)], ["전세가율", (i) => i.jr != null ? i.jr + "%" : "–"],
    ["평당가", (i) => won(i.p)], ["1년", (i) => `<span class="${cls(i.r1)}">${pct(i.r1)}</span>`],
    ["3년", (i) => `<span class="${cls(i.r3)}">${pct(i.r3)}</span>`], ["주변대비", (i) => pct(i.kp)],
    ["준공", (i) => i.y ?? "–"], ["세대수", (i) => i.h?.toLocaleString() ?? "–"],
    ["역", (i) => `${esc(i.st ?? "–")}<br>${dist(i.sd)}`], ["초등학교", (i) => dist(i.em)], ["학원(1km)", (i) => i.a1 ?? "–"],
    ["거래(1년)", (i) => i.n12],
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
