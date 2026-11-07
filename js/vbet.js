// Коефіцієнти VBET (vbet.ua) — єдине джерело кф. VBET працює на платформі BetConstruct: лінію віддає
// WebSocket-сервер Swarm, яким користується сам сайт (неофіційний інтерфейс, формат може змінитися).
//
// Ключі ринків у book (лінія — число з крапкою):
//   1, X, 2 — результат;  O2.5 / U2.5 — тотал голів матчу (1.5, 2.5, 3.5);
//   T1O1.5 / T1U1.5 — індивідуальний тотал господарів, T2… — гостей (0.5, 1, 1.5, 2, 2.5);
//   YO3.5 / YU3.5 — жовті картки матчу;  Y1O0.5 / Y1U0.5 — жовті 1-го тайму;  CO9.5 / CU9.5 — кутові матчу.
// Цілі лінії (1, 2, 3…) — азійські: рівно стільки — повернення ставки.
FP.vbet = (() => {
  const SOCKET = 'wss://eu-swarm-newm.betcoswarm.com/';
  const SITE_ID = 18746530;   // vbet.ua (з https://www.vbet.ua/conf.json)
  const TTL = 2 * 60 * 1000;
  const TIMEOUT = 20000;

  // Турнір ESPN → ID турніру у VBET.
  const COMPS = {
    'uefa.champions': 566, 'uefa.europa': 1861, 'uefa.europa.conf': 18278410,
    'eng.1': 538, 'esp.1': 545, 'ita.1': 543, 'ger.1': 541, 'fra.1': 548, 'ned.1': 1957, 'por.1': 560,
    'bel.1': 557, 'tur.1': 3013, 'eng.2': 539, 'sco.1': 555, 'aut.1': 556, 'gre.1': 1884, 'den.1': 1833,
    'bra.1': 1792, 'ger.2': 542, 'esp.2': 553, 'ita.2': 544, 'fra.2': 549, 'nor.1': 562, 'swe.1': 3000,
    'usa.1': 3025, 'arg.1': 1685, 'mex.1': 1951, 'ksa.1': 2971,
  };

  const whole = b => Number.isInteger(b * 2);   // лінії .0 і .5 (без азійських .25 / .75)
  const MARKETS = {
    P1XP2: { result: true },
    OverUnder: { prefix: '', ok: b => [1.5, 2.5, 3.5].includes(b) },
    Team1OverUnder: { prefix: 'T1', ok: b => [0.5, 1, 1.5, 2, 2.5].includes(b) },
    Team2OverUnder: { prefix: 'T2', ok: b => [0.5, 1, 1.5, 2, 2.5].includes(b) },
    YellowCardsOverUnder: { prefix: 'Y', ok: b => whole(b) && b >= 1 && b <= 9 },
    '1stHalfYellowCardsOver/Under': { prefix: 'Y1', ok: b => whole(b) && b >= 0.5 && b <= 4 },
    CornersOverUnder: { prefix: 'C', ok: b => whole(b) && b >= 4 && b <= 15 },
  };
  const TYPES = Object.keys(MARKETS);

  function request(ids) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(SOCKET); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('VBET: немає відповіді')); }, TIMEOUT);
      const send = (rid, command, params) => ws.send(JSON.stringify({ command, params, rid }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('VBET: помилка з\'єднання')); };
      ws.onopen = () => send('s', 'request_session', { site_id: SITE_ID, language: 'eng' });
      ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.rid === 's') {
          if (m.code !== 0) { clearTimeout(timer); ws.close(); reject(new Error('VBET: сесію не відкрито')); return; }
          send('g', 'get', {
            source: 'betting',
            what: { competition: ['id'], game: ['id', 'team1_name', 'team2_name', 'start_ts'], market: ['type', 'base'], event: ['type', 'name', 'price', 'base'] },
            where: { sport: { alias: 'Soccer' }, competition: { id: { '@in': ids } }, game: { type: { '@in': [0, 2] } }, market: { type: { '@in': TYPES } } },
          });
        } else if (m.rid === 'g') {
          clearTimeout(timer);
          ws.close();
          if (m.code !== 0 || !m.data || !m.data.data) reject(new Error('VBET: лінію не отримано'));
          else resolve(m.data.data);
        }
      };
    });
  }

  // Матч VBET → { id, ts, home, away, book }.
  function slimGame(g) {
    const book = {};
    for (const mk of Object.values(g.market || {})) {
      const def = MARKETS[mk.type];
      if (!def) continue;
      for (const ev of Object.values(mk.event || {})) {
        if (!(ev.price > 1)) continue;
        const type = String(ev.type || ev.name || '').trim();
        if (def.result) {
          const k = { P1: '1', X: 'X', P2: '2', W1: '1', W2: '2' }[type];
          if (k) book[k] = ev.price;
          continue;
        }
        const b = Number(mk.base != null ? mk.base : ev.base);
        if (!isFinite(b) || !def.ok(b)) continue;
        const dir = /^over/i.test(type) ? 'O' : /^under/i.test(type) ? 'U' : null;
        if (dir) book[`${def.prefix}${dir}${b}`] = ev.price;
      }
    }
    return { id: g.id, ts: g.start_ts, home: g.team1_name, away: g.team2_name, book };
  }

  let games = new Map();   // ID турніру VBET → [матчі]
  let loadedAt = 0, loading = null, lastError = null;

  // Лінія всіх турнірів (раз на 2 хв). Помилка не ламає додаток: рекомендацій просто не буде.
  function load(force) {
    if (loading) return loading;
    if (!force && loadedAt && Date.now() - loadedAt < TTL) return Promise.resolve();
    loading = request(Object.values(COMPS)).then(data => {
      const next = new Map();
      for (const [id, c] of Object.entries(data.competition || {})) {
        next.set(+id, Object.values(c.game || {}).map(slimGame).filter(g => Object.keys(g.book).length));
      }
      games = next;
      matched.clear();
      loadedAt = Date.now();
      lastError = null;
    }).catch(e => { lastError = e.message; loadedAt = Date.now(); }).finally(() => { loading = null; });
    return loading;
  }

  // ---------- зіставлення матчів ESPN і VBET ----------
  // За часом початку (±90 хв) і назвами команд: «Brighton & Hove Albion» = «Brighton and Hove Albion» тощо.
  const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'cd', 'ud', 'sd', 'rc', 'us', 'fk', 'sk', 'if', 'bk', 'club', 'de', 'the', 'and', 'calcio', 'sv', 'vfl', 'vfb', 'tsg', 'ca', 'cs', 'se', 'rcd', 'ogc', 'losc', 'stade']);
  const tokens = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t) && !/^\d+$/.test(t));
  const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  function sim(a, b) {
    const x = tokens(a), y = tokens(b);
    if (!x.length || !y.length) return 0;
    return x.filter(t => y.some(u => same(t, u))).length / Math.min(x.length, y.length);
  }

  const matched = new Map();   // id матчу ESPN → матч VBET або null
  function find(slug, ev) {
    if (matched.has(ev.id)) return matched.get(ev.id);
    const list = games.get(COMPS[slug]) || [];
    let best = null, bestScore = 0;
    for (const g of list) {
      const dt = Math.abs(g.ts - ev.ts);
      if (dt > 90 * 60) continue;
      const sh = Math.max(sim(ev.home.name, g.home), sim(ev.home.short, g.home));
      const sa = Math.max(sim(ev.away.name, g.away), sim(ev.away.short, g.away));
      const ok = (sh >= 0.5 && sa >= 0.5) || (dt <= 10 * 60 && sh + sa >= 1);
      if (ok && sh + sa > bestScore) { best = g; bestScore = sh + sa; }
    }
    if (loadedAt) matched.set(ev.id, best);
    return best;
  }

  // Кф матчу ESPN у лінії VBET або null.
  const book = (slug, ev) => { const g = find(slug, ev); return g ? g.book : null; };
  const status = () => ({ loadedAt, error: lastError, games: [...games.values()].reduce((s, l) => s + l.length, 0) });

  return { load, book, status };
})();
