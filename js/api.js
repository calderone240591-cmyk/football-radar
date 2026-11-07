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
    if (st.state === 'in') { ev.clock = st.shortDetail || e.status.displayClock || ''; ev.period = e.status.period || 0; }
    if (st.state !== 'pre') addFacts(ev, c);   // під час матчу — поточні кутові й картки
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

  // Кутові 1-го тайму кожної команди — з текстового коментаря матчу (у розкладі ESPN їх немає).
  // Рахуємо, лише коли в коментарі всі кутові матчу, інакше null. Матч уже не зміниться — кеш на рік.
  function halfCorners(slug, ev) {
    return cached(`c1:${ev.id}`, 365 * 24 * 60 * MIN, `${SITE}${slug}/summary?event=${ev.id}`, d => {
      const list = (d.commentary || []).filter(x => /^Corner,/.test(x.text || ''));
      if (!list.length || ev.home.c == null || ev.away.c == null || list.length !== ev.home.c + ev.away.c) return null;
      let h = 0, a = 0;
      for (const x of list) {
        const period = x.play && x.play.period ? x.play.period.number : (minuteOf(x.time && x.time.displayValue) <= 45 ? 1 : 2);
        if (period !== 1) continue;
        const name = (x.play && x.play.team && x.play.team.displayName) || (/^Corner, ([^.]+)\./.exec(x.text) || [])[1];
        if (name === ev.home.name) h++;
        else if (name === ev.away.name) a++;
        else return null;
      }
      return { h, a };
    });
  }

  // Дописує c1 (кутові 1-го тайму) у матчі items: [{ slug, ev }].
  async function addHalfCorners(items, onProgress) {
    let done = 0;
    await pool(items, 6, async ({ slug, ev }) => {
      let r = null;
      try { r = await halfCorners(slug, ev); } catch {}
      ev.home.c1 = r ? r.h : null;
      ev.away.c1 = r ? r.a : null;
      if (onProgress) onProgress(++done, items.length);
    });
  }

  // ---------- live ----------
  // Матчі турніру за дні, коли починаються матчі tss, без кешу — поточний рахунок, хвилина, кутові, картки.
  // ESPN приймає лише один день за запит; день — за UTC, а пізні матчі він відносить до дня за часом США,
  // тож беремо і день на 6 год раніше.
  const ymd = ts => { const d = new Date(ts * 1000); return `${d.getUTCFullYear()}${FP.pad(d.getUTCMonth() + 1)}${FP.pad(d.getUTCDate())}`; };
  async function liveEvents(slug, tss) {
    const days = [...new Set(tss.flatMap(ts => [ymd(ts), ymd(ts - 6 * 3600)]))];
    const parts = await Promise.all(days.map(d => getJson(`${SITE}${slug}/scoreboard?dates=${d}`).then(x => x.events || [], () => [])));
    return parts.flat().map(slimEvent);
  }

  // Кутові 1-го тайму матчу, що йде, — з коментаря, без кешу. null — команда в коментарі не впізнана.
  async function liveHalfCorners(slug, ev) {
    const d = await getJson(`${SITE}${slug}/summary?event=${ev.id}`);
    let h = 0, a = 0;
    for (const x of (d.commentary || []).filter(y => /^Corner,/.test(y.text || ''))) {
      const period = x.play && x.play.period ? x.play.period.number : (minuteOf(x.time && x.time.displayValue) <= 45 ? 1 : 2);
      if (period !== 1) continue;
      const name = (x.play && x.play.team && x.play.team.displayName) || (/^Corner, ([^.]+)\./.exec(x.text) || [])[1];
      if (name === ev.home.name) h++;
      else if (name === ev.away.name) a++;
      else return null;
    }
    return { h, a };
  }

  // Свіжі дані матчів items: [{ slug, id, ts, c1 }] → Map(id → ev). c1 — потрібні кутові 1-го тайму (з коментаря).
  async function live(items) {
    const bySlug = new Map();
    for (const x of items) { if (!bySlug.has(x.slug)) bySlug.set(x.slug, []); bySlug.get(x.slug).push(x); }
    const out = new Map();
    await pool([...bySlug], 4, async ([slug, list]) => {
      let evs = [];
      try { evs = await liveEvents(slug, list.map(x => x.ts)); } catch { return; }
      const want = new Map(list.map(x => [x.id, x]));
      for (const e of evs) if (want.has(e.id)) out.set(e.id, e);
      await pool(list.filter(x => x.c1 && out.has(x.id) && out.get(x.id).state === 'in' && FP.C1_COMPS.has(slug)), 3, async x => {
        const e = out.get(x.id);
        try { const r = await liveHalfCorners(slug, e); if (r) { e.home.c1 = r.h; e.away.c1 = r.a; } } catch {}
      });
    });
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

  return { season, allSeasons, addHalfCorners, live, pool };
})();
