// 💸 내 예산 계산기 — 독립 페이지 (budget.html). 앱(app.js)과는 이 기기 저장소(localStorage)의 "budgetOn"으로만 연결
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const state = {};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function won(man) {            // 만원 → "12억 3,000"
  if (man == null) return "–";
  const eok = Math.floor(man / 10000), rest = man % 10000;
  if (!eok) return rest.toLocaleString() + "만";
  return eok + "억" + (rest ? " " + rest.toLocaleString() : "");
}
const budgetOn = () => store.get("budgetOn", null);

// 최대 매수가 = 현금 + 대출 ≥ 집값 + 취득세·중개비 를 만족하는 가장 높은 가격.
// 대출 = min(LTV×집값, 주담대 한도, DSR 한도). 기본값은 2025.10.15 대책(서울 전역 규제지역) 기준 — 바뀌면 화면에서 수정.
// 입력값(소득 등)은 이 기기(localStorage)에만 저장, 서버로 보내지 않음.
const BUDGET_DEF = { cash: 3, income: 8000, debt: 0, rate: 4.0, years: 30, first: false,
  ltv: 40, ltvFirst: 70, ltvSeomin: 60, dsr: 40, stress: 3.0, cap1: 6, cap2: 4, cap3: 2 };
const MAX_YEARS = 30;          // 수도권·규제지역 주담대 만기 최대 30년 (2025.6.27 대책)
// 서민·실수요자 (부부합산 연소득 9천만원 이하 · 집값 8억 이하 · 무주택 세대주) → 규제지역 LTV 60%
const ltvAt = (P, b) => b.first ? b.ltvFirst : (b.income <= 9000 && P <= 80000 ? Math.max(b.ltv, b.ltvSeomin) : b.ltv);
const bIn = () => ({ ...BUDGET_DEF, ...store.get("budgetIn", {}) });
const loanCap = (P, b) => (P <= 150000 ? b.cap1 : P <= 250000 ? b.cap2 : b.cap3) * 10000;   // 만원
function acqCost(P) {          // 1주택 취득세(지방교육세 포함 근사) + 중개보수 + 기타(법무·등기 등) — 만원
  const eok = P / 10000;
  const tax = (eok <= 6 ? 1 : eok <= 9 ? eok * 2 / 3 - 3 : 3) * 1.1;
  return P * (tax + (P <= 150000 ? 0.5 : 0.7) + 0.2) / 100;
}
const mPay = (rate, years) => { const m = rate / 1200; return m ? m / (1 - Math.pow(1 + m, -years * 12)) : 1 / (years * 12); };   // 원리금균등 월상환 ÷ 원금
function calcBudget(b) {
  const years = Math.min(b.years, MAX_YEARS), cash = b.cash * 10000;
  const dsrLoan = Math.max(0, b.income * b.dsr / 100 - b.debt) / 12 / mPay(b.rate + b.stress, years);
  const loanAt = (P) => Math.min(ltvAt(P, b) / 100 * P, loanCap(P, b), dsrLoan);
  let lo = 0, hi = 3000000;
  for (let k = 0; k < 60; k++) { const P = (lo + hi) / 2; cash + loanAt(P) >= P + acqCost(P) ? (lo = P) : (hi = P); }
  const P = Math.floor(lo / 100) * 100, L = loanAt(P);
  const bind = L >= dsrLoan - 1 ? "DSR (소득 대비 상환액)" : L >= loanCap(P, b) - 1 ? "주담대 한도" : "LTV (집값 대비 비율)";
  return { P, L, bind, cost: acqCost(P), own: P + acqCost(P) - L, monthly: L * mPay(b.rate, years), dsrLoan, ltv: ltvAt(P, b), years };
}

function renderBudget() {
  const f = budgetOn();
  const b = bIn();
  const num = (k, label, unit, step = 1, hint = "") => `<label class="bf"><span>${label}${hint ? `<small>${hint}</small>` : ""}</span>
    <span><input type="number" inputmode="decimal" step="${step}" data-k="${k}" value="${b[k]}"> ${unit}</span></label>`;
  $("#budget").innerHTML = (`
    <div class="card">
      ${num("cash", "보유 현금", "억", 0.1, "전세보증금·예금 등 바로 쓸 수 있는 돈")}
      ${num("income", "연소득 (세전)", "만원", 100, "부부 합산이면 합쳐서")}
      ${num("debt", "기존 대출 연 상환액", "만원", 100, "신용대출·차량할부 등 1년 원리금")}
      ${num("rate", "주담대 금리", "%", 0.1)}
      ${num("years", "대출 기간", "년", 5, "수도권 주담대는 최대 30년")}
      <label class="bf chkrow"><span>생애최초 주택 구입</span><input type="checkbox" data-k="first" ${b.first ? "checked" : ""}></label>
    </div>
    <div class="card bres" id="bres"></div>
    <div class="card">
      <div class="bf"><span>지도·순위에 적용할 평형</span>
        <span class="seg mini" id="bband">${["59", "84"].map((v) => `<button data-v="${v}" class="${(f?.band || "84") === v ? "on" : ""}">${v}㎡</button>`).join("")}</span></div>
      <div class="bbtns"><button class="btn" id="b-apply">🗺️ 이 예산으로 지도 보기</button>
        <button class="btn sub" id="b-list">📋 순위로 보기</button></div>
      ${f ? `<div class="note">지금 적용 중: ${f.band}㎡ ${won(f.max)} 이하 · <a href="#" id="b-off">해제</a></div>` : ""}
    </div>
    <details class="card"><summary>⚙️ 규제 기준 (정책이 바뀌면 여기서 수정)</summary>
      ${num("ltv", "LTV (일반)", "%", 5, "규제지역 무주택")}
      ${num("ltvFirst", "LTV (생애최초)", "%", 5)}
      ${num("ltvSeomin", "LTV (서민·실수요자)", "%", 5, "부부 연소득 9천 이하·8억 이하 집·무주택 세대주")}
      ${num("dsr", "DSR 한도", "%", 5, "은행권")}
      ${num("stress", "스트레스 금리 가산", "%p", 0.5, "DSR 계산에만 더함")}
      ${num("cap1", "주담대 한도: 집값 15억 이하", "억", 1)}
      ${num("cap2", "주담대 한도: 15~25억", "억", 1)}
      ${num("cap3", "주담대 한도: 25억 초과", "억", 1)}
      <div class="note">기본값: 2025.10.15 대책 기준 (서울 전역 규제지역 · LTV 40%, 생애최초 70%, 서민·실수요자 60% · 주담대 한도 6/4/2억 ·
        수도권 스트레스 금리 3%p · 만기 최대 30년), 2026년 4월 자료로 재확인. 그 뒤 바뀐 정책은 반영되지 않았을 수 있습니다.
        <br>반영 안 됨: 디딤돌·보금자리·신생아 특례 같은 <b>정책대출</b>(LTV 70% 등 별도 기준), 1주택자 갈아타기(처분 조건),
        고정금리 기간이 긴 상품의 스트레스 금리 완화, 생애최초 취득세 감면. <button class="chip" id="b-reset">기본값으로</button></div>
    </details>
    <div class="note" style="padding:0 16px 16px">⚠️ 대략적인 계산입니다. 실제 한도는 은행·소득 증빙·신용에 따라 다르니 대출 상담으로 꼭 확인하세요.
      취득세는 1주택 기준 근사(6억 이하 1% · 9억 초과 3%, 지방교육세 포함)에 중개보수·등기비를 더했습니다.
      입력값은 이 기기에만 저장되고 서버로 보내지 않습니다.</div>`);
  const show = () => {
    const x = bIn(), r = calcBudget(x);
    $("#bres").innerHTML = `<div class="bmax"><small>살 수 있는 최대 집값</small><b>${won(r.P)}</b></div>
      <table class="kv">
        <tr><td>🏦 대출</td><td><b>${won(Math.round(r.L))}</b> <span class="note">제한 요인: ${r.bind} · 적용 LTV ${r.ltv}%${
          !x.first && r.ltv > x.ltv ? " (서민·실수요자)" : x.first ? " (생애최초)" : ""}</span></td></tr>
        <tr><td>💰 내 돈 (현금)</td><td>${won(Math.round(r.own))}</td></tr>
        <tr><td>🧾 취득세·중개비 등</td><td>${won(Math.round(r.cost))}</td></tr>
        <tr><td>📅 월 상환액</td><td><b>${Math.round(r.monthly).toLocaleString()}만원</b> <span class="note">${x.rate}% · ${r.years}년 원리금균등${x.years > MAX_YEARS ? " (최대 30년 적용)" : ""}</span></td></tr>
        <tr><td>소득 기준 대출 가능액</td><td>${won(Math.round(r.dsrLoan))} <span class="note">DSR ${x.dsr}% · 금리 ${x.rate}+${x.stress}%p로 계산</span></td></tr>
      </table>
      <div class="note">${r.bind.startsWith("DSR") ? "소득이 한도를 정하고 있어요 — 소득이 늘거나 기존 대출을 줄이면 한도가 커집니다."
        : r.bind.startsWith("주담대") ? "정부 주담대 한도에 걸려 있어요 — 현금을 늘리는 것만 효과가 있습니다."
        : "LTV에 걸려 있어요 — 현금이 늘면 그 2.5배 가까이 집값이 올라갑니다."}</div>`;
    state.budgetResult = r;
  };
  $$("#budget [data-k]").forEach((el) => el.addEventListener("input", () => {
    const x = bIn();
    x[el.dataset.k] = el.type === "checkbox" ? el.checked : +el.value || 0;
    store.set("budgetIn", x); show();
  }));
  let band = f?.band || "84";
  $$("#bband button").forEach((bt) => (bt.onclick = () => { band = bt.dataset.v; $$("#bband button").forEach((x) => x.classList.toggle("on", x === bt)); }));
  // 결과를 이 기기에 저장해 두고 지도·순위 화면으로 이동 (앱이 열리면서 예산 필터로 적용)
  $("#b-apply").onclick = () => { store.set("budgetOn", { max: state.budgetResult.P, band }); location.href = "./?tab=map"; };
  $("#b-list").onclick = () => { store.set("budgetOn", { max: state.budgetResult.P, band }); location.href = "./?tab=list"; };
  $("#b-off") && ($("#b-off").onclick = (e) => { e.preventDefault(); store.set("budgetOn", null); renderBudget(); });
  $("#b-reset").onclick = () => { store.set("budgetIn", {}); renderBudget(); };
  show();
}

renderBudget();
