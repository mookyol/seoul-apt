// 로그인 · 그룹 · 동기화 · 리마크 (Supabase)
// 로그인 안 했거나 서버 연결이 안 되면 모든 기능이 이 기기 저장(localStorage)으로 동작
const REMARK_KINDS = {
  추천: "👍", 주의: "⚠️", 임장: "🚶", 매수검토: "💰", 코멘트: "💬",
};

const cloud = {
  sb: null, user: null, member: null, counts: {},
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach((fn) => fn()); },
  get ready() { return !!(this.user && this.member); },

  async init() {
    const cfg = window.APP_CONFIG;
    if (!cfg || !window.supabase) return;
    this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    this.sb.auth.onAuthStateChange((_ev, session) => {
      const u = session?.user ?? null;
      if (u?.id === this.user?.id) return;
      this.user = u;
      setTimeout(() => this.afterAuth(), 0);  // 콜백 안에서 바로 쿼리하면 교착될 수 있어 분리
    });
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user ?? null;
    await this.afterAuth();
  },

  async afterAuth() {
    this.member = null;
    this.counts = {};
    if (this.user) {
      const { data } = await this.sb.from("members").select("nickname").eq("user_id", this.user.id).maybeSingle();
      this.member = data;
      if (this.member) await Promise.all([this.pullPrivate(), this.loadCounts()]);
    }
    this.emit();
  },

  login() {
    return this.sb.auth.signInWithOAuth({
      provider: "kakao",
      options: { redirectTo: location.origin + location.pathname },
    });
  },
  async logout() { await this.sb.auth.signOut(); this.user = null; await this.afterAuth(); },

  async join(code, nick) {
    const { error } = await this.sb.rpc("join_group", { code: code.trim(), nick: nick.trim() });
    if (error) throw new Error(error.message.includes("duplicate") ? "이미 쓰는 닉네임입니다" : error.message);
    await this.afterAuth();
  },

  // ---- 관심단지 · 메모: 로그인 시 서버 ↔ 이 기기 합치기 ----
  async pullPrivate() {
    const [{ data: fav }, { data: memos }] = await Promise.all([
      this.sb.from("favorites").select("complex_code"),
      this.sb.from("memos").select("complex_code, body"),
    ]);
    const localFav = store.get("favs", []);
    const serverFav = (fav || []).map((r) => r.complex_code);
    const onlyLocal = localFav.filter((c) => !serverFav.includes(c));
    if (onlyLocal.length) await this.sb.from("favorites").upsert(onlyLocal.map((c) => ({ complex_code: c })));
    store.set("favs", [...new Set([...serverFav, ...localFav])]);

    const serverMemo = Object.fromEntries((memos || []).map((m) => [m.complex_code, m.body]));
    const up = [];
    for (let k = 0; k < localStorage.length; k++) {
      const key = localStorage.key(k);
      if (!key?.startsWith("memo:")) continue;
      const code = key.slice(5), body = store.get(key, "");
      if (body && !serverMemo[code]) up.push({ complex_code: code, body });
    }
    if (up.length) await this.sb.from("memos").upsert(up);
    for (const [code, body] of Object.entries(serverMemo)) store.set("memo:" + code, body);
  },
  async setFav(code, on) {
    if (!this.ready) return;
    if (on) await this.sb.from("favorites").upsert({ complex_code: code });
    else await this.sb.from("favorites").delete().eq("complex_code", code);
  },
  _memoTimers: {},
  setMemo(code, body) {
    if (!this.ready) return;
    clearTimeout(this._memoTimers[code]);
    this._memoTimers[code] = setTimeout(() =>
      this.sb.from("memos").upsert({ complex_code: code, body, updated_at: new Date().toISOString() }), 800);
  },

  // ---- 리마크 ----
  async loadCounts() {
    const { data } = await this.sb.from("remarks").select("complex_code, kind");
    this.counts = {};
    for (const r of data || []) {
      const c = (this.counts[r.complex_code] ??= { n: 0, kinds: {} });
      c.n++; c.kinds[r.kind] = (c.kinds[r.kind] || 0) + 1;
    }
  },
  async remarks(code) {
    const { data, error } = await this.sb.from("remarks")
      .select("id, kind, body, created_at, user_id, members(nickname)")
      .eq("complex_code", code).order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async recent(limit = 30) {
    const { data } = await this.sb.from("remarks")
      .select("id, complex_code, kind, body, created_at, user_id, members(nickname)")
      .order("created_at", { ascending: false }).limit(limit);
    return data || [];
  },
  async addRemark(code, kind, body) {
    const { error } = await this.sb.from("remarks").insert({ complex_code: code, kind, body: body.trim() });
    if (error) throw error;
    await this.loadCounts(); this.emit();
  },
  async deleteRemark(id) {
    const { error } = await this.sb.from("remarks").delete().eq("id", id);
    if (error) throw error;
    await this.loadCounts(); this.emit();
  },
};
