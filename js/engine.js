// Аналіз: однаковий код на сервері (tools/record.js) і в браузері (js/app.js).
//
// Серії команди рахуються за всіма її матчами в усіх турнірах ESPN за ≈ 150 днів. Рекомендація — лише на
// НАСТУПНИЙ матч команди в межах 3 днів, кф — VBET, лише від 1.35.
//   • Засуха: команда не забиває 2+ матчі поспіль → ІТБ 0.5 і ІТБ 1.5 цієї команди;
//   • Тотали: у 3+ останніх матчах команди поспіль на двох було не більше 1 гола (не зайшов ТБ 1.5)
//     → ТБ 1.5 і ТБ 2.5 у її наступному матчі.
//   • Топ: 10 рекомендацій з найбільшою ймовірністю з обох вкладок (лише з кф VBET від 1.35).
// Ймовірність: модель голів + ринок VBET (70/30).
FP.engine = (() => {
  const { CFG } = FP;
  const G = FP.goals;
  const VOID = /POSTPONED|CANCELED|CANCELLED|ABANDONED|SUSPENDED|FORFEIT/;
  const EXTRA = /AET|PEN/;

  const MARKETS = [
    { key: 'd05', tab: 'dry', label: 'ІТБ 0.5', line: 0.5 },
    { key: 'd15', tab: 'dry', label: 'ІТБ 1.5', line: 1.5 },
    { key: 't15', tab: 'low', label: 'ТБ 1.5', line: 1.5 },
    { key: 't25', tab: 'low', label: 'ТБ 2.5', line: 2.5 },
  ];
  const MARKET = new Map(MARKETS.map(m => [m.key, m]));
  const DRY = MARKETS.filter(m => m.tab === 'dry');
  const LOW = MARKETS.filter(m => m.tab === 'low');

  const r4 = x => Math.round(x * 1e4) / 1e4;
  const r2 = x => Math.round(x * 100) / 100;
  const teamOf = t => ({ id: t.id, name: t.name, short: t.short || t.name });
  const scoreOf = ev => (ev.home.score == null || ev.away.score == null ? null : `${ev.home.score}:${ev.away.score}`);

  // Ймовірність ставки: модель, а якщо VBET дає обидві сторони лінії — 70% ринок (без маржі) + 30% модель.
  function cell(key, line, pModel, over, under) {
    const p = over && under ? G.MARKET_WEIGHT * (1 / over) / (1 / over + 1 / under) + (1 - G.MARKET_WEIGHT) * pModel : pModel;
    // Кф нижче 1.35 — не рекомендація: такої ставки немає ні в додатку, ні в статистиці.
    if (over && over < CFG.MIN_ODDS) return { key, line, odds: null, low: true, p: null };
    return { key, line, odds: over || null, p: r4(p) };
  }

  function analyze(events, bookOf, now = Date.now() / 1000) {
    // ---------- усі зіграні матчі кожної команди за часом ----------
    const games = new Map(), info = new Map();
    for (const e of events) {
      if (!G.isResult(e) || VOID.test(e.status || '') || e.ts > now) continue;
      for (const [me, op, home] of [[e.home, e.away, true], [e.away, e.home, false]]) {
        if (!games.has(me.id)) games.set(me.id, []);
        games.get(me.id).push({ ts: e.ts, ev: e.id, g: me.score, ga: op.score, h: home, vs: op.short || op.name, ln: e.ln });
        info.set(me.id, { team: teamOf(me), league: e.ln, slug: e.sl });
      }
    }
    for (const l of games.values()) l.sort((a, b) => a.ts - b.ts);
    // Команда, якої в історії менше 4 матчів, — найімовірніше ESPN бачить лише її кубкові матчі: серія була б хибна.
    const covered = id => (games.get(id) || []).length >= CFG.MIN_GAMES;

    const runOf = (id, test) => {
      const l = games.get(id) || [];
      let n = 0;
      for (let i = l.length - 1; i >= 0 && test(l[i]); i--) n++;
      return { n, capped: n > 0 && n === l.length };   // capped — серія довша за історію (≥ n)
    };
    const isDry = x => x.g === 0;
    const isLow = x => x.g + x.ga <= 1;
    const lastGoal = id => { const l = games.get(id) || []; for (let i = l.length - 1; i >= 0; i--) if (l[i].g > 0) return l[i].ts; return null; };
    const recent = (id, k) => (games.get(id) || []).slice(-k).map(x => ({ ts: x.ts, vs: x.vs, g: x.g, ga: x.ga, h: x.h }));

    // ---------- модель голів ----------
    const model = G.build(events, now);

    // ---------- наступний матч кожної команди ----------
    const upcoming = events.filter(e => e.state !== 'post' && !VOID.test(e.status || '') && e.ts > now - 4 * 3600)
      .sort((a, b) => a.ts - b.ts);
    const nextOf = new Map();
    for (const e of upcoming) for (const t of [e.home, e.away]) if (!nextOf.has(t.id)) nextOf.set(t.id, e);

    // ---------- рекомендації ----------
    const rows = [], bets = [], evaluated = [], keep = [];
    const pick = upcoming.filter(e => e.state === 'pre' && e.ts > now && e.ts <= now + CFG.HORIZON);
    for (const ev of pick) {
      const sides = ['home', 'away'].filter(sd => covered(ev[sd].id) && nextOf.get(ev[sd].id) === ev);
      if (!sides.length) continue;
      const dry = {}, low = {};
      for (const sd of sides) { dry[sd] = runOf(ev[sd].id, isDry); low[sd] = runOf(ev[sd].id, isLow); }
      const drySides = sides.filter(sd => dry[sd].n >= CFG.DRY_MIN);
      const lowSides = sides.filter(sd => low[sd].n >= CFG.LOW_MIN);
      if (!drySides.length && !lowSides.length) continue;

      const bk = bookOf(ev);
      if (bk) evaluated.push(ev.id);
      const lam = G.lambdas(model, ev, bk);
      const base = { id: ev.id, ts: ev.ts, slug: ev.sl, league: ev.ln, home: teamOf(ev.home), away: teamOf(ev.away) };
      const add = (c, side, extra) => {
        const id = `${ev.id}:${side ? side[0] + ':' : ''}${c.key}`;
        if (c.odds) {
          bets.push({
            id, key: c.key, tab: MARKET.get(c.key).tab, ev: ev.id, slug: ev.sl, league: ev.ln, ts: ev.ts,
            home: base.home.name, away: base.away.name, side: side || null, line: c.line, odds: c.odds, p: c.p, ...extra,
          });
        } else if (bk && !c.low) keep.push(id);   // матч у лінії, але цього ринку зараз немає — запис лишається
        return { ...c, id };
      };
      const book = k => (bk ? bk[k] : undefined);

      // Засуха.
      for (const sd of drySides) {
        const lambda = sd === 'home' ? lam.lh : lam.la, T = sd === 'home' ? 'T1' : 'T2';
        const pmf = G.poissonPmf(lambda, 12);
        const { n, capped } = dry[sd];
        const extra = { team: ev[sd].name, n, capped, xg: r2(lambda) };
        const cells = DRY.map(mk => add(cell(mk.key, mk.line, G.overProb(pmf, mk.line), book(`${T}O${mk.line}`), book(`${T}U${mk.line}`)), sd, extra));
        if (!cells.some(c => c.odds)) continue;   // у додатку — лише матчі з кф VBET від 1.35
        rows.push({
          type: 'dry', ev: base, side: sd, n, capped, lastGoal: lastGoal(ev[sd].id), lambda: r2(lambda), market: !!bk,
          recent: recent(ev[sd].id, Math.min(Math.max(n, 3), 8)), bets: cells,
        });
      }

      // Тотали: один рядок на матч, виділено команди з серією.
      const lowCells = lowSides.length ? LOW.map(mk => cell(mk.key, mk.line, G.totalOver(lam.lh, lam.la, mk.line), book(`O${mk.line}`), book(`U${mk.line}`))) : [];
      if (lowCells.some(c => c.odds)) {
        const lowN = { home: low.home ? low.home.n : 0, away: low.away ? low.away.n : 0 };
        const capped = { home: !!(low.home && low.home.capped), away: !!(low.away && low.away.capped) };
        const n = Math.max(...lowSides.map(sd => lowN[sd]));
        const extra = { sides: lowSides, low: lowN, n, xg: r2(lam.lh + lam.la) };
        rows.push({
          type: 'low', ev: base, sides: lowSides, low: lowN, capped, n, xg: r2(lam.lh + lam.la), market: !!bk,
          recent: Object.fromEntries(['home', 'away'].map(sd => [sd, recent(ev[sd].id, Math.min(Math.max(lowN[sd], 3), 6))])),
          bets: lowCells.map(c => add(c, null, extra)),
        });
      } else for (const c of lowCells) add(c, null, {});   // ринку тимчасово немає — наявний запис лишається
    }

    // ---------- топ за ймовірністю (обидві вкладки, лише з кф VBET) ----------
    const top = rows.flatMap(r => r.bets.filter(c => c.odds)).sort((a, b) => b.p - a.p || a.id.localeCompare(b.id))
      .slice(0, CFG.TOP_N).map(c => c.id);
    const topSet = new Set(top);
    for (const r of rows) for (const c of r.bets) if (topSet.has(c.id)) c.top = true;
    for (const b of bets) b.top = topSet.has(b.id);

    // ---------- поточні серії всіх команд ----------
    const lists = { dry: [], low: [] };
    for (const [id, o] of info) {
      if (!covered(id)) continue;
      const d = runOf(id, isDry), u = runOf(id, isLow);
      if (d.n < CFG.DRY_MIN && u.n < CFG.LOW_MIN) continue;
      const nx = nextOf.get(id);
      const next = nx ? {
        id: nx.id, ts: nx.ts, league: nx.ln, home: nx.home.id === id, state: nx.state,
        vs: (nx.home.id === id ? nx.away : nx.home).short, line: nx.state === 'pre' && nx.ts <= now + CFG.HORIZON && !!bookOf(nx),
      } : null;
      const l = games.get(id), last = l[l.length - 1];
      const t = { team: o.team, league: o.league, next, last: { ts: last.ts, vs: last.vs, g: last.g, ga: last.ga } };
      if (d.n >= CFG.DRY_MIN) lists.dry.push({ ...t, n: d.n, capped: d.capped, lastGoal: lastGoal(id) });
      if (u.n >= CFG.LOW_MIN) lists.low.push({ ...t, n: u.n, capped: u.capped });
    }
    const byN = (a, b) => b.n - a.n || (a.next ? a.next.ts : 9e10) - (b.next ? b.next.ts : 9e10);
    lists.dry.sort(byN); lists.low.sort(byN);

    return { at: Math.round(now), rows, bets, evaluated, keep, top, teams: [...info.keys()].filter(covered).length, ...lists };
  }

  // ---------- розрахунок ставки ----------
  // Значення, з яким порівнюється лінія: голи команди (засуха) або голи матчу (тотали).
  function valueOf(key, side, ev) {
    const H = ev.home, A = ev.away;
    if (key[0] === 'd') return side === 'home' ? H.score : A.score;
    return H.score == null || A.score == null ? null : H.score + A.score;
  }

  // { res: 'win' | 'loss' | 'void', v, sc, early?, note? } або null — результату ще немає; 'cancel' — матч скасовано.
  // Усі ставки — «більше», тож коли під час матчу лінію вже перевищено, ставка виграла ДОСТРОКОВО, не чекаючи
  // кінця матчу. Лише в основний час.
  function settle(b, ev) {
    if (!ev) return null;
    if (VOID.test(ev.status || '')) return { res: 'cancel' };
    if (ev.state === 'in') {
      if (ev.period > 2) return null;
      const v = valueOf(b.key, b.side, ev);
      if (v == null || !(v > b.line)) return null;
      return { res: 'win', v, sc: scoreOf(ev), early: true, note: `достроково${ev.clock ? `, ${ev.clock}` : ''}` };
    }
    if (!G.isResult(ev)) return null;
    const v = valueOf(b.key, b.side, ev);
    if (v == null) return null;
    // Додатковий час: рахунок 90 хв невідомий. Якщо навіть з додатковим часом лінію не перевищено — програш,
    // інакше — повернення (голи могли бути забиті в додатковий час).
    if (EXTRA.test(ev.status || '') && v > b.line) return { res: 'void', v, sc: scoreOf(ev), note: 'додатковий час' };
    return { res: v > b.line ? 'win' : 'loss', v, sc: scoreOf(ev) };
  }

  // Стан матчу, що йде (для моніторингу).
  const sideLive = t => ({ id: t.id, name: t.name, score: t.score });
  const liveOf = ev => ({ id: ev.id, state: ev.state, status: ev.status, clock: ev.clock || '', period: ev.period || 0, home: sideLive(ev.home), away: sideLive(ev.away) });

  // Рекомендації на матчі, що вже почались: з попереднього знімка, поки матч не закінчився, з поточним станом.
  function liveRows(prev, events, now = Date.now() / 1000, fresh = new Map()) {
    const evById = new Map(events.map(e => [e.id, e]));
    const out = [];
    for (const r of prev || []) {
      if (r.ev.ts > now || now - r.ev.ts > 4 * 3600) continue;
      const ev = fresh.get(r.ev.id) || evById.get(r.ev.id);
      if (!ev || ev.state === 'post' || VOID.test(ev.status || '')) continue;
      out.push({ ...r, live: liveOf(ev) });
    }
    return out;
  }

  // Матчі, за якими треба стежити зараз: почались (до 4 год тому) і мають ставку без результату або рядок рекомендації.
  function liveNeeds(bets, rows, now = Date.now() / 1000) {
    const out = new Map();
    const add = (id, slug, ts) => { if (ts <= now + 60 && now - ts <= 4 * 3600 && !out.has(id)) out.set(id, { id, slug, ts }); };
    for (const b of bets) if (!b.res) add(b.ev, b.slug, b.ts);
    for (const r of rows || []) add(r.ev.id, r.ev.slug, r.ev.ts);
    return [...out.values()];
  }

  const profit = b => (b.res === 'win' ? CFG.STAKE * (b.odds - 1) : b.res === 'loss' ? -CFG.STAKE : 0);

  // ---------- серверний журнал ----------
  // Ставки записуються до початку матчу й оновлюються (кф, ймовірність, місце в топі) до самого старту; перший
  // кф і ймовірність лишаються в odds0 / p0. Після матчу — розрахунок і рахунок. Якщо до старту матч перестав
  // підходити (серія змінилась) — запис видаляється.
  function updateJournal(journal, res, events, now = Date.now() / 1000) {
    const evById = new Map(events.map(e => [e.id, e]));
    const cur = new Map(res.bets.map(b => [b.id, b]));
    const evaluated = new Set(res.evaluated), keep = new Set(res.keep);
    for (const b of res.bets) {
      if (b.ts < CFG.STATS_FROM || b.ts <= now) continue;
      const old = journal.bets[b.id];
      if (old && old.ts <= now) continue;
      journal.bets[b.id] = {
        ...b, odds0: old ? old.odds0 : b.odds, p0: old ? old.p0 : b.p,
        first: old ? old.first : Math.round(now), at: Math.round(now), res: null,
      };
    }
    for (const [id, b] of Object.entries(journal.bets)) {
      const ev = evById.get(b.ev);
      if (b.res) {
        // Рахунок після кінця матчу (і для ставок, що зайшли достроково).
        if (!b.ft && ev && G.isResult(ev)) b.ft = `${scoreOf(ev)}${EXTRA.test(ev.status || '') ? ' д.ч.' : ''}`;
        continue;
      }
      if (b.ts > now) {
        if (ev && VOID.test(ev.status || '')) delete journal.bets[id];
        else if (!cur.has(id) && evaluated.has(b.ev) && !keep.has(id)) delete journal.bets[id];
        else if (ev && ev.ts !== b.ts && ev.ts > now) b.ts = ev.ts;
        continue;
      }
      const s = settle(b, ev);
      if (s && s.res === 'cancel') { delete journal.bets[id]; continue; }
      if (s && s.res) {
        Object.assign(b, { res: s.res, v: s.v, sc: s.sc, settled: Math.round(now) }, s.note ? { note: s.note } : {}, s.early ? { early: true } : {});
        if (ev && G.isResult(ev)) b.ft = `${scoreOf(ev)}${EXTRA.test(ev.status || '') ? ' д.ч.' : ''}`;
      } else if (now - b.ts > 3 * 86400) Object.assign(b, { res: 'void', v: null, note: 'немає даних' });
      if (b.res) { b.profit = r2(profit(b)); delete b.live; }
      else if (ev && ev.state === 'in') b.live = { clock: ev.clock || '', v: valueOf(b.key, b.side, ev), sc: scoreOf(ev) };
    }
    return journal;
  }

  return { analyze, settle, valueOf, liveOf, liveRows, liveNeeds, profit, updateJournal, MARKETS, MARKET };
})();
