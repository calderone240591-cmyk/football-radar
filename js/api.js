// Дані ESPN: безкоштовно, без ключа (неофіційний публічний API).
// Матчі всіх футбольних турнірів ESPN (≈ 220: чемпіонати, кубки, єврокубки, Ліга націй, відбори, товариські
// збірних…) — по днях через soccer/all: одна відповідь — усі матчі дня. Минулі дні не змінюються й кешуються
// надовго, останні дні й майбутні — на кілька хвилин.
FP.api = (() => {
  const BASE = 'https://site.web.api.espn.com/apis/site/v2/';
  const SITE = `${BASE}sports/soccer/`;
  const MIN = 60 * 1000;

  async function getJson(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('Немає з\'єднання з сервером даних.'); }
    if (!res.ok) throw new Error(`Сервер даних відповів помилкою (${res.status}).`);
    return res.json();
  }

  // Виконує fn для кожного елемента, не більше n запитів одночасно.
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // ---------- турніри: id ESPN → { slug, name } ----------
  let LG = new Map();
  async function leagues() {
    await FP.store.ready;
    const k = 'lg', e = FP.store.get(k);
    if (e && Date.now() - e.t < 7 * 24 * 60 * MIN) { LG = new Map(e.data); return LG; }
    try {
      const d = await getJson(`${BASE}leagues/dropdown?sport=soccer&limit=1000`);
      const data = (d.leagues || []).map(l => [String(l.id), { slug: l.slug, name: l.name }]);
      FP.store.put(k, { t: Date.now(), data });
      LG = new Map(data);
    } catch { if (e) LG = new Map(e.data); }
    return LG;
  }
  const leagueOf = id => LG.get(String(id)) || null;

  // ---------- компактний вигляд матчу ----------
  const side = (c, ha) => {
    const t = c.competitors.find(x => x.homeAway === ha) || {};
    const team = t.team || {};
    const score = t.score === undefined || t.score === null || t.score === '' ? null : Number(t.score);
    return { id: String(team.id), name: team.displayName, short: team.shortDisplayName || team.displayName, score };
  };

  function slimEvent(e) {
    const c = e.competitions && e.competitions[0];
    if (!c || !c.competitors) return null;
    const st = e.status.type;
    const lg = (/~l:(\d+)/.exec(e.uid || '') || [])[1] || null;
    const L = leagueOf(lg);
    const ln = (L && L.name) || String(c.altGameNote || '').split(',')[0].trim() || (e.season && e.season.slug) || '';
    const sl = L ? L.slug : null;
    if ((sl && FP.SKIP.slug.test(sl)) || FP.SKIP.name.test(ln)) return null;
    const ev = {
      id: String(e.id),
      ts: Math.floor(Date.parse(e.date) / 1000),
      state: st.state,               // pre / in / post
      status: st.name,               // STATUS_FULL_TIME, STATUS_FINAL_AET, STATUS_POSTPONED…
      completed: !!st.completed,
      lg, ln, sl,
      home: side(c, 'home'),
      away: side(c, 'away'),
    };
    if (st.state === 'in') { ev.clock = st.shortDetail || e.status.displayClock || ''; ev.period = e.status.period || 0; }
    return ev;
  }

  // ---------- дні ----------
  const ymd = ts => { const d = new Date(ts * 1000); return `${d.getUTCFullYear()}${FP.pad(d.getUTCMonth() + 1)}${FP.pad(d.getUTCDate())}`; };
  const dayUrl = d => `${SITE}all/scoreboard?dates=${d}&limit=1000`;

  // День, що закінчився понад 2 доби тому, уже не зміниться: такий запис лишається в кеші назавжди.
  // Записи, отримані раніше (коли день ще тривав), оновлюються.
  async function day(d, force) {
    await FP.store.ready;
    const k = `d:${d}`, e = FP.store.get(k);
    const now = Date.now() / 1000;
    const final = d < ymd(now - 2 * 86400);
    const ttl = d > ymd(now) ? 15 * MIN : 2 * MIN;
    if (!force && e && (e.final || Date.now() - e.t < ttl)) return e.data;
    try {
      const data = ((await getJson(dayUrl(d))).events || []).map(slimEvent).filter(Boolean);
      FP.store.put(k, { t: Date.now(), final, data });
      return data;
    } catch (err) {
      if (e) return e.data;
      throw err;
    }
  }

  // Матчі за HISTORY_DAYS днів назад і HORIZON уперед. Подвійні (матч у двох днях) — за найсвіжішим станом.
  async function history(force, onProgress) {
    await leagues();
    const now = Date.now() / 1000;
    const days = [];
    for (let t = now - FP.CFG.HISTORY_DAYS * 86400; t <= now + FP.CFG.HORIZON + 86400; t += 86400) days.push(ymd(t));
    let done = 0, errors = 0;
    const parts = await pool(days, 6, async d => {
      let r = [];
      try { r = await day(d, force); } catch { errors++; }
      if (onProgress) onProgress(++done, days.length);
      return r;
    });
    const rank = { post: 2, in: 1, pre: 0 };
    const byId = new Map();
    for (const list of parts) for (const e of list) {
      const o = byId.get(e.id);
      if (!o || (rank[e.state] || 0) >= (rank[o.state] || 0)) byId.set(e.id, e);
    }
    return { events: [...byId.values()].sort((a, b) => a.ts - b.ts), errors, days: days.length };
  }

  // ---------- live ----------
  // Свіжі дані матчів items: [{ id, slug, ts }] → Map(id → ev), без кешу. Табло турніру за день (а без slug —
  // усі матчі дня). ESPN відносить пізні матчі до дня за часом США, тож беремо і день на 6 год раніше.
  async function live(items) {
    await leagues();
    const groups = new Map();
    for (const x of items) { const k = x.slug || 'all'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    const out = new Map();
    await pool([...groups], 4, async ([slug, list]) => {
      const days = [...new Set(list.flatMap(x => [ymd(x.ts), ymd(x.ts - 6 * 3600)]))];
      const want = new Set(list.map(x => x.id));
      await Promise.all(days.map(async d => {
        try {
          const j = await getJson(slug === 'all' ? dayUrl(d) : `${SITE}${slug}/scoreboard?dates=${d}`);
          for (const e of j.events || []) if (want.has(String(e.id))) { const s = slimEvent(e); if (s) out.set(s.id, s); }
        } catch {}
      }));
    });
    return out;
  }

  return { history, live, pool, leagues, leagueOf };
})();
