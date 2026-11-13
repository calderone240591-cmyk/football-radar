// Коефіцієнти VBET (vbet.ua) — єдине джерело кф. VBET працює на платформі BetConstruct: лінію віддає
// WebSocket-сервер Swarm, яким користується сам сайт (неофіційний інтерфейс, формат може змінитися).
// Беремо всю футбольну лінію (усі турніри) і зіставляємо матчі з ESPN за часом і назвами команд.
//
// Ключі ринків у book (лінія — число з крапкою):
//   1, X, 2 — результат;  O2.5 / U2.5 — тотал голів матчу (1.5, 2.5, 3.5);
//   T1O0.5 / T1U0.5 — індивідуальний тотал господарів (0.5, 1.5), T2… — гостей.
FP.vbet = (() => {
  const SOCKET = 'wss://eu-swarm-newm.betcoswarm.com/';
  const SITE_ID = 18746530;   // vbet.ua (з https://www.vbet.ua/conf.json)
  const TTL = 2 * 60 * 1000;
  const TIMEOUT = 40000;

  const MARKETS = {
    P1XP2: { result: true },
    OverUnder: { prefix: '', ok: b => [1.5, 2.5, 3.5].includes(b) },
    Team1OverUnder: { prefix: 'T1', ok: b => [0.5, 1.5].includes(b) },
    Team2OverUnder: { prefix: 'T2', ok: b => [0.5, 1.5].includes(b) },
  };
  const TYPES = Object.keys(MARKETS);
  // Службові «турніри» VBET зі статистичними ставками — не справжні матчі.
  const SKIP_COMP = /statistic|special|e-?football|esoccer|cyber|fantasy/i;

  function request() {
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
            what: { competition: ['id', 'name'], game: ['id', 'team1_name', 'team2_name', 'start_ts'], market: ['type', 'base'], event: ['type', 'name', 'price', 'base'] },
            where: { sport: { alias: 'Soccer' }, game: { type: { '@in': [0, 2] } }, market: { type: { '@in': TYPES } } },
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

  // Матч VBET → { id, ts, home, away, comp, book }.
  function slimGame(g, comp) {
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
    return { id: g.id, ts: g.start_ts, home: g.team1_name, away: g.team2_name, comp, book };
  }

  // ---------- назви команд ----------
  // «Brighton & Hove Albion» = «Brighton and Hove Albion» тощо. Жіночі, молодіжні й другі команди
  // зіставляються лише між собою: «Arsenal» ≠ «Arsenal (W)», «Barcelona» ≠ «Barcelona B».
  const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'cd', 'ud', 'sd', 'rc', 'us', 'fk', 'sk', 'if', 'bk', 'club', 'de', 'the', 'and', 'calcio', 'sv', 'vfl', 'vfb', 'tsg', 'ca', 'cs', 'se', 'rcd', 'ogc', 'losc', 'stade', 'nk', 'hnk', 'gnk', 'fsv', 'kv', 'krc', 'ks', 'cfr', 'csd', 'futbol', 'football', 'soccer']);
  const MARK = { women: 'W', woman: 'W', wom: 'W', wfc: 'W', ladies: 'W', femenino: 'W', feminino: 'W', fem: 'W', femmes: 'W', feminine: 'W', frauen: 'W', dames: 'W', donne: 'W', kvinner: 'W', dam: 'W',
    u17: 'U17', u18: 'U18', u19: 'U19', u20: 'U20', u21: 'U21', u22: 'U22', u23: 'U23', ii: 'II', reserves: 'II', youth: 'Y', castilla: 'II', jong: 'II', olympic: 'U23' };
  // Жіночий чи молодіжний турнір — за назвою (ESPN не пише «Women» у назві команд жіночих ліг).
  function leagueMarks(name) {
    const s = String(name || '');
    const out = [];
    if (/wom[ae]n|femen|femin|frauen|vrouwen|dames|ladies|liga f\b|\bwsl\b|nwsl|premi[eè]re ligue|damallsvenskan|toppserien|kvinde|w-league|usl super league|northern super league|\(w\)/i.test(s)) out.push('W');
    const u = /\bu-?(\d{2})\b|under[- ]?(\d{2})/i.exec(s);
    if (u) out.push(`U${u[1] || u[2]}`);
    return out;
  }
  function parse(s, extra = []) {
    const raw = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
    const marks = new Set(extra), tokens = [];
    for (const [i, t] of raw.entries()) {
      if (MARK[t]) { marks.add(MARK[t]); continue; }
      // «Barcelona B», «Arsenal (W)» — лише в кінці назви, щоб не сплутати з «B. Dortmund», «W. Bremen».
      if ((t === 'b' || t === 'w') && i === raw.length - 1 && i > 0) { marks.add(t === 'b' ? 'II' : 'W'); continue; }
      if (STOP.has(t) || /^\d+$/.test(t)) continue;
      tokens.push(t);
    }
    return { tokens, marks: [...marks].sort().join(',') };
  }
  const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  function sim(x, y) {
    if (!x.tokens.length || !y.tokens.length) return 0;
    // Різні позначки — різні команди. Виняток: жіноча позначка лише з одного боку (ESPN не завжди знає, що ліга
    // жіноча) — такий збіг слабший, і точний збіг, якщо він є, завжди виграє.
    let k = 1;
    if (x.marks !== y.marks) {
      if ((x.marks === '' && y.marks === 'W') || (x.marks === 'W' && y.marks === '')) k = 0.75;
      else return 0;
    }
    return k * x.tokens.filter(t => y.tokens.some(u => same(t, u))).length / Math.min(x.tokens.length, y.tokens.length);
  }

  let games = [];   // матчі VBET за часом
  let loadedAt = 0, loading = null, lastError = null;

  // Лінія всіх турнірів (раз на 2 хв). Помилка не ламає додаток: кф просто не буде.
  function load(force) {
    if (loading) return loading;
    if (!force && loadedAt && Date.now() - loadedAt < TTL) return Promise.resolve();
    loading = request().then(data => {
      const list = [];
      const comps = [];
      for (const r of Object.values(data.region || {})) comps.push(...Object.values(r.competition || {}));
      comps.push(...Object.values(data.competition || {}));
      for (const c of comps) {
        if (SKIP_COMP.test(c.name || '')) continue;
        for (const g of Object.values(c.game || {})) {
          const s = slimGame(g, c.name || '');
          if (!Object.keys(s.book).length) continue;
          const lm = leagueMarks(s.comp);
          s.h = parse(s.home, lm); s.a = parse(s.away, lm);
          list.push(s);
        }
      }
      games = list.sort((a, b) => a.ts - b.ts);
      matched.clear();
      loadedAt = Date.now();
      lastError = null;
    }).catch(e => { lastError = e.message; loadedAt = Date.now(); }).finally(() => { loading = null; });
    return loading;
  }

  // Господарі й гості у VBET бувають переставлені (нейтральне поле) — тоді міняємо місцями й кф.
  const FLIP = k => (k === '1' ? '2' : k === '2' ? '1' : k.startsWith('T1') ? `T2${k.slice(2)}` : k.startsWith('T2') ? `T1${k.slice(2)}` : k);
  const flipBook = b => Object.fromEntries(Object.entries(b).map(([k, v]) => [FLIP(k), v]));

  // ---------- зіставлення матчів ESPN і VBET: час ±90 хв і назви команд ----------
  const matched = new Map();   // id матчу ESPN → { book, comp } або null
  function find(ev) {
    if (matched.has(ev.id)) return matched.get(ev.id);
    const lm = leagueMarks(ev.ln);
    const H = [parse(ev.home.name, lm), parse(ev.home.short, lm)], A = [parse(ev.away.name, lm), parse(ev.away.short, lm)];
    const best2 = (P, q) => Math.max(...P.map(p => sim(p, q)));
    let best = null, bestScore = 0;
    for (const g of games) {
      if (g.ts < ev.ts - 90 * 60) continue;
      if (g.ts > ev.ts + 90 * 60) break;
      const close = Math.abs(g.ts - ev.ts) <= 10 * 60;
      for (const flip of [false, true]) {
        const sh = best2(H, flip ? g.a : g.h), sa = best2(A, flip ? g.h : g.a);
        const ok = (sh >= 0.5 && sa >= 0.5) || (close && sh + sa >= 1);
        const score = sh + sa - (flip ? 0.01 : 0);
        if (ok && score > bestScore) { best = { book: flip ? flipBook(g.book) : g.book, comp: g.comp }; bestScore = score; }
      }
    }
    if (loadedAt) matched.set(ev.id, best);
    return best;
  }

  // Кф матчу ESPN у лінії VBET або null.
  const book = ev => { const g = find(ev); return g ? g.book : null; };
  const status = () => ({ loadedAt, error: lastError, games: games.length });

  return { load, book, status };
})();
