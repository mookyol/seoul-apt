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
}

function saveFilters() {
  const ids = ["#f-gu", "#f-sort", "#f-budget", "#f-hh", "#f-sd", "#f-es", "#f-age", "#f-n", "#f-dg"];
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
      <div class="wtitle">📍 입지점수 비중 <span class="note">— 출근 · 규모 · 학군(초중고+학원) · 역</span></div>
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
    if (!it.la) continue;
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
    <div class="card"><h3>💰 분양가 vs 주변 시세</h3>
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

// ---------- 순위 ----------
function filtered() {
  const q = $("#q").value.trim().toLowerCase();
  const gu = $("#f-gu").value, budget = +$("#f-budget").value * 10000, hh = +$("#f-hh").value,
        sd = +$("#f-sd").value, es = +$("#f-es").value, age = +$("#f-age").value, n = +$("#f-n").value,
        dg = $("#f-dg").value;
  // 띄어쓴 단어가 모두 들어 있으면 일치 (예: "천호동 528", "천호 삼성", "잠실 엘스")
  const words = q.split(/\s+/).filter(Boolean);
  const hay = (i) => (i._hay ??= [i.n, i.al, i.d, i.g, i.st, i.d + " " + i.j, i.j].filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " "));
  const xs = state.items.filter((i) =>
    (!words.length || words.every((w) => hay(i).includes(w))) &&
    (!gu || i.g === gu) &&
    (!budget || (i.p84 != null && i.p84 <= budget)) &&
    (!hh || (i.h ?? 0) >= hh) &&
    (!sd || (i.sd != null && i.sd <= sd)) &&
    (!es || (i.em != null && i.em <= es)) &&
    (!age || (age > 0 ? i.y && thisYear - i.y <= age : i.y && thisYear - i.y >= -age)) &&
    (!n || i.n12 >= n) &&
    (!dg || (i.dg && dg.includes(i.dg))));
  const hi = (k) => (i) => -(i[k] ?? -1e9), lo = (k) => (i) => i[k] ?? 1e9;
  const key = {
    ls: hi("ls"), r1: hi("r1"), r3: hi("r3"), kp: lo("kp"), kr: lo("kr"), jr: hi("jr"), n12: hi("n12"), vt: hi("vt"),
    sd: lo("sd"), bk: lo("bk"), em: lo("em"), a1: hi("a1"), pAsc: lo("p"), pDesc: hi("p"),
    rm: (i) => -(cloud.counts[i.c]?.n ?? 0),
    df: hi("df"), dd: (i) => (i.de ? 1e8 : 0) + (i.dd ?? 1e9), ac: hi("ac"),   // 낙폭 추정치는 뒤로
    gpA: lo("gp"), gpD: hi("gp"), sE: hi("sE"),
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
      🚇 ${esc(i.st ?? "–")} ${dist(i.sd)}${i.sl > 1 ? ` · ${i.sl}개 노선` : ""}${i.em != null ? ` · 🎒 초 ${dist(i.em)} 중 ${dist(i.mm)} 고 ${dist(i.hm)}` : ""}</div>
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

// ---------- 라우팅 (#c=단지코드 / #s=청약공고 / #cmp / #join) ----------
function openDetail(code) { location.hash = "c=" + encodeURIComponent(code); }
function route() {
  const m = location.hash.match(/^#c=([^&]+)/);
  if (m && state.byCode[decodeURIComponent(m[1])]) renderDetail(decodeURIComponent(m[1]));
  else if (location.hash.startsWith("#s=")) renderSub(decodeURIComponent(location.hash.slice(3)));
  else if (location.hash === "#cmp" && cmps().length) renderCompare();
  else if (location.hash === "#join") renderJoin();
  else if (location.hash === "#score") renderScorecard();
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
    <div class="card lscard"><h3>📍 입지점수 <b class="lsc">${i.ls ?? "–"}</b><small>점</small></h3>${i.la ? scoreBars(i)
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
    <div class="card"><h3>🔑 키맞추기 <span class="note">주변 1.5km 단지</span></h3>
      <div class="kmsg">${kmsg}</div><table class="near" id="near"><tr><td>불러오는 중…</td></tr></table></div>
    ${i.dg ? `<div class="card"><h3>🛡️ 하락 방어력 <span class="grade g${i.dg}">${i.dg}</span> <span class="note">${i.df}점 / 100${i.th ? " · 표본 적음" : ""}</span></h3>
      <table class="kv">
        <tr><td>2022 하락기 낙폭</td><td><b class="down">${i.dd != null ? "-" + i.dd + "%" : "–"}</b>${i.de ? ' <span class="note">(같은 구·연식대 평균으로 추정)</span>' : ""}</td></tr>
        <tr><td>지역 베타 <span class="note">1보다 크면 구 평균보다 출렁임</span></td><td>${i.bt ?? "–"}</td></tr>
        <tr><td>전세가율 (최근 6개월)</td><td>${i.jr2 != null ? i.jr2 + "%" : "–"}${i.jw ? ' <span class="badge">80%↑ 깡통전세 주의</span>' : ""}</td></tr>
        <tr><td>${esc(i.g)} 2년 내 입주물량</td><td>${i.su != null ? "구 세대의 " + i.su + "%" : "–"}</td></tr>
        <tr><td>거래회전율 (1년 거래÷세대)</td><td>${i.to != null ? i.to + "%" : "–"}</td></tr>
      </table>
      <div class="note">구성: 낙폭 35% · 베타 15% · 전세가율 20% · 입주물량 15% · 회전율 15% (서울 내 백분위). 가중치는 백테스트로 조정 예정.</div></div>` : ""}
    ${i.fv ? `<div class="card"><h3>⚖️ 모델 적정가 <span class="note">위치·연식·규모·브랜드·역·학군으로 학습 (이 동네는 빼고 예측)</span></h3>
      <div class="kmsg">모델 적정가 평당 <b>${won(Math.round(i.fv))}</b> vs 보정 시세 <b>${won(Math.round(i.vp))}</b>
        → <b class="${cls(i.gp)}">${i.gp > 0 ? "모델보다 " + i.gp + "% 비쌈" : "모델보다 " + Math.abs(i.gp) + "% 쌈"}</b></div>
      ${i.rs ? `<div>가격을 만드는 요인: ${i.rs.map((r) => `<span class="tag">${esc(r)}</span>`).join(" ")}</div>` : ""}
      <div class="note" style="margin-top:6px">⚠️ 백테스트 결과 '모델보다 싼 단지'가 이후 더 오르지는 않았습니다 (모델이 못 보는 약점 때문에 싼 경우가 많음).
        매수 신호가 아니라 <b>가격 수준 참고용</b>입니다. <a href="#score">점수 성적표 보기</a></div></div>` : ""}
    ${i.vp ? `<div class="card"><h3>🧹 보정 시세 <span class="note">해제·직거래·이상치 제외, 층 보정, 거래 적으면 주변 시세로 보완</span></h3>
      <div>평당 <b>${won(Math.round(i.vp))}</b> <span class="tag">신뢰도 ${{ high: "높음", mid: "보통", low: "낮음" }[i.cf] ?? "–"}</span>
      ${i.ac != null ? ` · 출근 접근성 <b>${i.ac}</b>점 <span class="note">(임시: 업무지구 7곳 직선거리 기반)</span>` : ""}</div></div>` : ""}
    <div class="card"><h3>🚇 교통</h3>
      <div>${esc(i.st ?? "–")} <b>${dist(i.sd)}</b>${i.sl > 1 ? ` · 500m 안 ${i.sl}개 노선` : ""}</div>
      <div class="note">${esc(i.bz ?? "")} 업무지구 직선거리 ${i.bk ?? "–"}km</div></div>
    <div class="card"><h3>🎒 학군 <b class="lsc">${i.sE ?? "–"}</b><small>점</small>
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
    ["'22 낙폭", (i) => i.dd != null ? `-${i.dd}%${i.de ? "*" : ""}` : "–"], ["출근 접근성", (i) => i.ac ?? "–"],
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
