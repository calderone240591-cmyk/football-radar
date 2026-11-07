// Дані ESPN: безкоштовно, без ключа, запити дозволені прямо з браузера (неофіційний публічний API).
// Матчі вантажимо помісячно: одна відповідь — усі матчі турніру за місяць, і зіграні з рахунком,
// кутовими й картками, і майбутні. Минулі місяці кешуються надовго, поточний — на 2 хвилини.
FP.api = (() => {
  // Саме site.web.api — браузери блокують запити до site.api.espn.com, хоча дані ті самі.
  const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/';
  const MIN = 60 * 1000;
  const TTL_PAST = 3 * 24 * 60 * MIN;
  const TTL_CURRENT = 2 * MIN;
  const TTL_FUTURE = 30 * MIN;
  const TTL_PREVIOUS = 30 * 24 * 60 * MIN;

  async function getJson(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('Немає з\'єднання з сервером даних.'); }
    if (!res.ok) throw new Error(`Сервер даних відповів помилкою (${res.status}).`);
    return res.json();
  }

  // Без мережі віддаємо застарілий кеш, ніж нічого.
  async function cached(k, ttl, url, transform, force) {
    await FP.store.ready;
    const e = FP.store.get(k);
    if (!force && e && Date.now() - e.t < ttl) return e.data;
    try {
      const data = transform(await getJson(url));
      FP.store.put(k, { t: Date.now(), data });
      return data;
    } catch (err) {
      if (e) return e.data;
      throw err;
    }
  }

  // ---------- компактний вигляд матчу ----------
  const side = (c, ha) => {
    const t = c.competitors.find(x => x.homeAway === ha) || {};
    const team = t.team || {};
    const score = t.score === undefined || t.score === null || t.score === '' ? null : Number(t.score);
    return { id: String(team.id), name: team.displayName, short: team.shortDisplayName, score };
  };

  // Хвилина події: «45'+2'» → 45 (ще 1-й тайм), «90'+4'» → 90, «105'» → 105 (додатковий час).
  const minuteOf = dv => { const m = /^(\d+)/.exec(dv || ''); return m ? +m[1] : null; };

  // Факти зіграного матчу для розрахунку ставок і серій: кутові команди (c), жовті картки за основний
  // час (y) і в 1-му таймі (y1). null — ESPN не дав даних.
  function addFacts(ev, c) {
    for (const ha of ['home', 'away']) {
      const comp = c.competitors.find(x => x.homeAway === ha) || {};
      const s = (comp.statistics || []).find(x => x.name === 'wonCorners');
      const v = s ? Number(s.displayValue) : NaN;
      ev[ha].c = s && s.displayValue !== '' && isFinite(v) ? v : null;
      ev[ha].y = null; ev[ha].y1 = null;
    }
    if (!Array.isArray(c.details)) return;
    const y = { [ev.home.id]: 0, [ev.away.id]: 0 }, y1 = { [ev.home.id]: 0, [ev.away.id]: 0 };
    for (const d of c.details) {
      if (!d.yellowCard) continue;
      const m = minuteOf(d.clock && d.clock.displayValue);
      const tid = String(d.team && d.team.id);
      if (m == null || !(tid in y)) return;   // неповні дані — карток не рахуємо зовсім
      if (m > 90) continue;                   // додатковий час у ставках не враховується
      y[tid]++;
      if (m <= 45) y1[tid]++;
    }
    for (const ha of ['home', 'away']) { ev[ha].y = y[ev[ha].id]; ev[ha].y1 = y1[ev[ha].id]; }
  }

  function slimEvent(e) {
    const c = e.competitions[0];
    const st = e.status.type;
    const ev = {
      id: String(e.id),
      ts: Math.floor(Date.parse(e.date) / 1000),
      state: st.state,               // pre / in / post
      status: st.name,               // STATUS_FULL_TIME, STATUS_FINAL_AET, STATUS_POSTPONED…
      completed: !!st.completed,
      season: e.season && e.season.year,
      home: side(c, 'home'),
      away: side(c, 'away'),
    };
    if (st.state === 'post') addFacts(ev, c);
    return ev;
  }

  const slimMonth = d => {
    const l = d.leagues && d.leagues[0];
    return {
      season: l && l.season ? { year: l.season.year, start: l.season.startDate } : null,
      events: (d.events || []).map(slimEvent),
    };
  };

  const ym = d => `${d.getFullYear()}${FP.pad(d.getMonth() + 1)}`;
  const ttlOf = m => { const now = ym(new Date()); return m < now ? TTL_PAST : m === now ? TTL_CURRENT : TTL_FUTURE; };
  const url = (slug, m) => `${SITE}${slug}/scoreboard?dates=${m}&limit=500`;
  const month = (slug, m, force) => cached(`m2:${slug}:${m}`, ttlOf(m), url(slug, m), slimMonth, force);

  // Минулий сезон потрібен лише для серій і рейтингів на початку сезону: тільки рахунки, надовго.
  const lite = s => ({ id: s.id, score: s.score });
  const monthLite = (slug, m) => cached(`pm2:${slug}:${m}`, TTL_PREVIOUS, url(slug, m), d => ({
    events: (d.events || []).map(slimEvent).filter(e => e.state === 'post' && e.completed)
      .map(e => ({ id: e.id, ts: e.ts, state: e.state, status: e.status, completed: e.completed, season: e.season, home: lite(e.home), away: lite(e.away) })),
  }));

  async function previousSeason(slug, info) {
    if (!info || !info.start) return [];
    const start = new Date(info.start);
    const months = [];
    const d = new Date(start.getFullYear() - 1, start.getMonth(), 1);
    while (d < new Date(start.getFullYear(), start.getMonth(), 1)) { months.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    const parts = await pool(months, 4, m => monthLite(slug, m).catch(() => ({ events: [] })));
    const byId = new Map();
    for (const p of parts) for (const e of p.events) if (e.season === info.year - 1) byId.set(e.id, e);
    return [...byId.values()];
  }

  // Усі матчі поточного сезону турніру (від місяця старту до наступного місяця);
  // withPrevious — додати результати минулого сезону.
  async function season(slug, force, withPrevious) {
    const now = new Date();
    const cur = await month(slug, ym(now), force);
    const info = cur.season;
    const start = info && info.start ? new Date(info.start) : new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const months = [];
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    while (d <= next) { months.push(ym(d)); d.setMonth(d.getMonth() + 1); }
    const parts = await pool(months, 4, m => (m === ym(now) ? cur : month(slug, m, force)));
    const byId = new Map();
    for (const p of parts) for (const e of p.events) if (!info || e.season === info.year) byId.set(e.id, e);
    const previous = withPrevious ? await previousSeason(slug, info) : [];
    return { info, events: [...byId.values()].sort((a, b) => a.ts - b.ts), previous };
  }

  // Виконує fn для кожного елемента, не більше n запитів одночасно.
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // Усі турніри: чемпіонати — з минулим сезоном. onProgress(done, total).
  async function allSeasons(force, onProgress) {
    let done = 0, errors = 0;
    const list = await pool(FP.LEAGUES, 4, async comp => {
      let s = null;
      try { s = { comp, ...(await season(comp.slug, force, !comp.cup)) }; } catch { errors++; }
      done++;
      if (onProgress) onProgress(done, FP.LEAGUES.length);
      return s;
    });
    return { seasons: list.filter(Boolean), errors };
  }

  return { season, allSeasons, pool };
})();
