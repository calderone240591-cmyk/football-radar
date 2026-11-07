// Аналіз: однаковий код на сервері (tools/record.js) і в браузері (js/app.js).
//
// Серії команди рахуються за всіма її матчами в 25 чемпіонатах і трьох єврокубках (з кінцем минулого
// сезону чемпіонату). Рекомендація — лише на НАСТУПНИЙ матч команди, у межах 3 днів, лише з кф VBET від 1.49.
//   • Сухі: команда не забиває 2+ матчі поспіль → ІТБ 0.5 / 1 / 1.5 / 2.5 цієї команди;
//   • Тотали: у 2+ останніх матчах команди не було ТБ 2.5 → ТБ 2.5 у її наступному матчі
//     (окремо — коли так в обох команд);
//   • Картки й кутові: у кожному з 2 останніх матчів команда отримала ≤ 1 жовтої (ЖК матчу),
//     0 жовтих у 1-му таймі (ЖК 1-го тайму), подала ≤ 1 кутового в 1-му таймі (кутові 1-го тайму, лише турніри
//     з коментарем ESPN — FP.C1_COMPS), подала ≤ 3 кутових (кутові) → ТБ відповідного тоталу матчу.
// Ймовірність: модель (голи — рейтинги команд, картки й кутові — середні сезону) + ринок VBET 70/30.
FP.engine = (() => {
  const { CFG } = FP;
  const G = FP.goals;
  const CHAMPS = FP.LEAGUES.filter(l => !l.cup);
  const CUPS = FP.LEAGUES.filter(l => l.cup);
  const VOID = /POSTPONED|CANCELED|CANCELLED|ABANDONED|SUSPENDED|FORFEIT/;
  const EXTRA = /AET|PEN/;
  const CORNERS_DISP = 1.45;   // розкид кутових ширший за пуассонівський (бектест)
  const CARDS_DISP = 1.05;

  const MARKETS = [
    { key: 'd05', tab: 'dry', label: 'ІТБ 0.5', line: 0.5 },
    { key: 'd1', tab: 'dry', label: 'ІТБ 1', line: 1 },
    { key: 'd15', tab: 'dry', label: 'ІТБ 1.5', line: 1.5 },
    { key: 'd25', tab: 'dry', label: 'ІТБ 2.5', line: 2.5 },
    { key: 't25o', tab: 'tot', label: 'ТБ 2.5 · одна команда', line: 2.5 },
    { key: 't25b', tab: 'tot', label: 'ТБ 2.5 · обидві команди', line: 2.5 },
    { key: 'y1', tab: 'card', label: 'ЖК 1-й тайм', prefix: 'Y1', field: 'y1', max: CFG.Y1_MAX, disp: CARDS_DISP },
    { key: 'y', tab: 'card', label: 'ЖК матч', prefix: 'Y', field: 'y', max: CFG.Y_MAX, disp: CARDS_DISP },
    { key: 'c1', tab: 'card', label: 'Кутові 1-й тайм', prefix: 'C1', field: 'c1', max: CFG.C1_MAX, disp: CORNERS_DISP },
    { key: 'c', tab: 'card', label: 'Кутові', prefix: 'C', field: 'c', max: CFG.C_MAX, disp: CORNERS_DISP },
  ];
  const AGAINST = { c: 'ca', y: 'ya', y1: 'y1a', c1: 'c1a' };
  const MARKET = new Map(MARKETS.map(m => [m.key, m]));
  const DRY = MARKETS.filter(m => m.tab === 'dry');
  const CARD = MARKETS.filter(m => m.tab === 'card');

  const r4 = x => Math.round(x * 1e4) / 1e4;
  const teamOf = t => ({ id: t.id, name: t.name, short: t.short || t.name });

  // Ймовірність ставки: модель, а якщо VBET дає обидві сторони лінії — 70% ринок (без маржі) + 30% модель.
  function cell(key, line, pModel, over, under) {
    const p = over && under ? G.MARKET_WEIGHT * (1 / over) / (1 / over + 1 / under) + (1 - G.MARKET_WEIGHT) * pModel : pModel;
    return { key, line, odds: over || null, p: r4(p), ok: !!over && over >= CFG.MIN_ODDS };
  }

  function analyze(seasons, bookOf, now = Date.now() / 1000) {
    const bySlug = new Map(seasons.map(s => [s.comp.slug, s]));

    // ---------- якість даних ----------
    // Де ESPN не веде кутові чи картки, він віддає нулі. Якщо в турнірі понад 10% матчів з 0 кутових
    // (або понад 20% без жовтих — у Нідерландах справді ≈ 10%) — таких даних там немає. Матч з 0 кутових
    // у сумі теж вважаємо неповним (насправді так майже не буває).
    const okFacts = new Map();
    for (const s of seasons) {
      let nc = 0, zc = 0, ny = 0, zy = 0;
      for (const e of s.events) {
        if (!G.isResult(e)) continue;
        if (e.home.c != null && e.away.c != null) { nc++; if (e.home.c + e.away.c === 0) zc++; }
        if (e.home.y != null && e.away.y != null) { ny++; if (e.home.y + e.away.y === 0) zy++; }
      }
      okFacts.set(s.comp.slug, { c: nc < 10 || zc / nc <= 0.1, y: ny < 10 || zy / ny <= 0.2 });
    }
    const factsOf = (slug, e) => {
      const q = okFacts.get(slug) || { c: true, y: true };
      const c = q.c && e.home.c != null && e.away.c != null && e.home.c + e.away.c > 0;
      const y = q.y && e.home.y != null && e.away.y != null;
      return { c, y };
    };

    // ---------- усі матчі кожної команди за часом ----------
    const seen = new Set(), games = new Map(), all = [];
    for (const s of seasons) {
      for (const [list, cur] of [[s.previous || [], false], [s.events, true]]) for (const e of list) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (cur) all.push({ slug: s.comp.slug, ev: e });
        if (!G.isResult(e) || VOID.test(e.status || '')) continue;
        const f = cur ? factsOf(s.comp.slug, e) : { c: false, y: false };
        for (const [me, op] of [[e.home, e.away], [e.away, e.home]]) {
          if (!games.has(me.id)) games.set(me.id, []);
          games.get(me.id).push({
            ts: e.ts, cur, slug: s.comp.slug, opp: op.id, oppName: op.short || op.name, g: me.score, ga: op.score,
            c: f.c ? me.c : null, ca: f.c ? op.c : null,
            c1: f.c && me.c1 != null && op.c1 != null ? me.c1 : null, c1a: f.c && me.c1 != null && op.c1 != null ? op.c1 : null,
            y: f.y ? me.y : null, ya: f.y ? op.y : null, y1: f.y ? me.y1 : null, y1a: f.y ? op.y1 : null,
          });
        }
      }
    }
    for (const l of games.values()) l.sort((a, b) => a.ts - b.ts);

    // Команди наших чемпіонатів: про інших (суперники в єврокубках) у даних не всі матчі.
    const ours = new Map();
    for (const c of CHAMPS) {
      const s = bySlug.get(c.slug);
      if (s) for (const e of s.events) for (const t of [e.home, e.away]) if (!ours.has(t.id)) ours.set(t.id, { slug: c.slug, team: teamOf(t) });
    }

    const runOf = (id, test) => {
      const l = games.get(id) || [];
      let n = 0;
      for (let i = l.length - 1; i >= 0 && test(l[i]); i--) n++;
      return n;
    };
    const isDry = x => x.g === 0;
    const isUnder = x => x.g + x.ga <= 2;
    const lastGoal = id => { const l = games.get(id) || []; for (let i = l.length - 1; i >= 0; i--) if (l[i].g > 0) return l[i].ts; return null; };
    const last2 = id => { const l = games.get(id) || []; return l.length >= 2 ? l.slice(-2) : null; };
    const lowIn = (id, mk) => { const l = last2(id); return !!l && l.every(x => x[mk.field] != null && x[mk.field] <= mk.max); };

    // ---------- середні сезону для карток і кутових (згладжені до загального середнього) ----------
    const sums = new Map(), tot = { c: [0, 0], y: [0, 0], y1: [0, 0], c1: [0, 0] };
    for (const [id, l] of games) {
      const a = { c: [0, 0, 0], y: [0, 0, 0], y1: [0, 0, 0], c1: [0, 0, 0] };
      for (const x of l) {
        if (!x.cur) continue;
        for (const k of ['c', 'y', 'y1', 'c1']) {
          const f = x[k], ag = x[AGAINST[k]];
          if (f == null || ag == null) continue;
          a[k][0] += f; a[k][1] += ag; a[k][2]++;
          tot[k][0] += f; tot[k][1]++;
        }
      }
      sums.set(id, a);
    }
    const prior = k => (tot[k][1] > 50 ? tot[k][0] / tot[k][1] : { c: 5, y: 2, y1: 0.8, c1: 2.2 }[k]);
    const shrink = (sum, n, p, k = 3) => (sum + p * k) / (n + k);
    const teamAvg = (id, k) => {
      const a = sums.get(id), p = prior(k);
      return a ? { f: shrink(a[k][0], a[k][2], p), a: shrink(a[k][1], a[k][2], p) } : { f: p, a: p };
    };
    const matchMean = (hid, aid, k) => {
      const H = teamAvg(hid, k), A = teamAvg(aid, k);
      return (H.f + A.a) / 2 + (A.f + H.a) / 2;
    };

    // ---------- моделі голів ----------
    const models = new Map();
    for (const c of CHAMPS) {
      const s = bySlug.get(c.slug);
      if (!s) continue;
      try { if (s.events.some(G.isResult) || (s.previous || []).length) models.set(c.slug, G.build(c, s.events, null, s.previous)); } catch {}
    }
    const domestic = new Map();
    for (const m of models.values()) for (const t of m.teams.values()) domestic.set(t.id, { att: t.att, def: t.def, q: m.league.q });
    for (const c of CUPS) {
      const s = bySlug.get(c.slug);
      if (!s) continue;
      try { models.set(c.slug, G.build(c, s.events, domestic, null)); } catch {}
    }

    // ---------- наступний матч кожної команди ----------
    const upcoming = all.filter(x => x.ev.state !== 'post' && !VOID.test(x.ev.status || '') && x.ev.ts > now - 4 * 3600)
      .sort((a, b) => a.ev.ts - b.ev.ts);
    const nextOf = new Map();
    for (const x of upcoming) for (const t of [x.ev.home, x.ev.away]) if (!nextOf.has(t.id)) nextOf.set(t.id, x);
    const isNext = (t, x) => ours.has(t.id) && nextOf.get(t.id) === x;

    // ---------- рекомендації ----------
    const rows = [], bets = [], evaluated = [], keep = [];
    const pick = upcoming.filter(x => x.ev.state === 'pre' && x.ev.ts > now && x.ev.ts <= now + CFG.HORIZON);
    for (const x of pick) {
      const ev = x.ev;
      const sides = ['home', 'away'].filter(sd => isNext(ev[sd], x));
      if (!sides.length) continue;
      const bk = bookOf(x.slug, ev);
      if (!bk) continue;
      evaluated.push(ev.id);
      const base = { id: ev.id, ts: ev.ts, slug: x.slug, home: teamOf(ev.home), away: teamOf(ev.away) };
      const betOf = (c, side, extra) => ({
        id: `${ev.id}:${side ? side[0] + ':' : ''}${c.key}`, key: c.key, ev: ev.id, slug: x.slug, ts: ev.ts,
        home: base.home.short, away: base.away.short, side: side || null, line: c.line, odds: c.odds, p: c.p, ...extra,
      });
      const add = (c, side, extra) => {
        const b = betOf(c, side, extra);
        if (c.ok) bets.push(b); else if (!c.odds) keep.push(b.id);   // ринку немає в лінії — останній запис лишається
        return { ...c, id: b.id };
      };
      const m = models.get(x.slug);
      const lam = m ? G.lambdas(m, ev, bk) : null;

      // Сухі.
      if (lam) for (const sd of sides) {
        const n = runOf(ev[sd].id, isDry);
        if (n < CFG.DRY_MIN) continue;
        const lambda = sd === 'home' ? lam.lh : lam.la, T = sd === 'home' ? 'T1' : 'T2';
        const pmf = G.poissonPmf(lambda, 12);
        rows.push({
          type: 'dry', ev: base, side: sd, n, lastGoal: lastGoal(ev[sd].id), lambda: r4(lambda),
          bets: DRY.map(mk => add(cell(mk.key, mk.line, G.overProb(pmf, mk.line), bk[`${T}O${mk.line}`], bk[`${T}U${mk.line}`]), sd, { n })),
        });
      }

      // Тотали.
      const under = { home: runOf(ev.home.id, isUnder), away: runOf(ev.away.id, isUnder) };
      const qual = sides.filter(sd => under[sd] >= CFG.UNDER_MIN);
      if (lam && qual.length) {
        const key = qual.length === 2 ? 't25b' : 't25o';
        // Очікувані голи вже підігнані під ринок VBET (1X2 і тотал), тож ймовірність — із сітки рахунків.
        const c = cell(key, 2.5, G.totalOver(lam.lh, lam.la, 2.5), bk['O2.5'], null);
        rows.push({ type: 'tot', ev: base, sides: qual, under, bets: [add(c, null, { sides: qual, under })] });
      }

      // Картки й кутові.
      const cards = [];
      for (const mk of CARD) {
        if (mk.key === 'c1' && !FP.C1_COMPS.has(x.slug)) continue;   // не буде чим розрахувати
        const q = sides.filter(sd => lowIn(ev[sd].id, mk));
        if (!q.length) continue;
        const mean = matchMean(ev.home.id, ev.away.id, mk.field);
        const pmf = G.negBinPmf(mean, mk.disp, 40);
        const re = new RegExp(`^${mk.prefix}O([\\d.]+)$`);
        const cands = Object.keys(bk).map(k => re.exec(k)).filter(Boolean).map(r => +r[1])
          .map(L => cell(mk.key, L, G.overProb(pmf, L), bk[`${mk.prefix}O${L}`], bk[`${mk.prefix}U${L}`]));
        // Лінія — найімовірніша з кф від 1.49; якщо такої немає — найближча до неї (для довідки).
        const best = cands.filter(c => c.ok).sort((a, b) => b.p - a.p)[0]
          || cands.sort((a, b) => b.odds - a.odds)[0]
          || { key: mk.key, line: null, odds: null, p: null, ok: false };
        cards.push(add(best, null, { sides: q, mean: r4(mean) }));
      }
      if (cards.length) {
        const crit = {};
        for (const sd of sides) {
          const l = last2(ev[sd].id);
          if (l) crit[sd] = l.map(g => ({ ts: g.ts, vs: g.oppName, y: g.y, y1: g.y1, c: g.c, c1: g.c1 }));
        }
        rows.push({ type: 'card', ev: base, crit, bets: cards });
      }
    }

    // ---------- поточні серії ----------
    const lists = { dry: [], under: [], low: [] };
    for (const [id, o] of ours) {
      const nx = nextOf.get(id);
      const next = nx ? {
        id: nx.ev.id, ts: nx.ev.ts, slug: nx.slug, home: nx.ev.home.id === id, state: nx.ev.state,
        vs: teamOf(nx.ev.home.id === id ? nx.ev.away : nx.ev.home), line: nx.ev.state === 'pre' && !!bookOf(nx.slug, nx.ev),
      } : null;
      const info = { team: o.team, slug: o.slug, next };
      const nd = runOf(id, isDry), nu = runOf(id, isUnder);
      if (nd >= CFG.DRY_MIN) lists.dry.push({ ...info, n: nd, lastGoal: lastGoal(id) });
      if (nu >= CFG.UNDER_MIN) lists.under.push({ ...info, n: nu });
      const flags = CARD.filter(mk => lowIn(id, mk)).map(mk => mk.key);
      if (flags.length) lists.low.push({ ...info, flags, last: last2(id).map(g => ({ ts: g.ts, vs: g.oppName, y: g.y, y1: g.y1, c: g.c, c1: g.c1 })) });
    }

    return { at: Math.round(now), rows, bets, evaluated, keep, ...lists };
  }

  // ---------- розрахунок ставки ----------
  // Значення, з яким порівнюється лінія: голи команди (сухі), голи матчу (тотали), жовті / кутові обох команд.
  function valueOf(key, side, ev) {
    const H = ev.home, A = ev.away;
    const sum = (a, c) => (a == null || c == null ? null : a + c);
    if (key[0] === 'd') return side === 'home' ? H.score : A.score;
    if (key.startsWith('t25')) return sum(H.score, A.score);
    if (key === 'y') return sum(H.y, A.y);
    if (key === 'y1') return sum(H.y1, A.y1);
    if (key === 'c') return sum(H.c, A.c);
    if (key === 'c1') return sum(H.c1, A.c1);
    return null;
  }

  // { res: 'win' | 'loss' | 'void' | null, v } — null: результату ще немає або немає даних; 'cancel' — матч скасовано.
  // Усі ставки — «більше», тож коли під час матчу лінію вже перевищено, ставка виграла достроково (early),
  // не чекаючи кінця матчу. Лише в основний час: у додатковий рахунок уже не 90-хвилинний.
  function settle(b, ev) {
    if (!ev) return null;
    if (VOID.test(ev.status || '')) return { res: 'cancel' };
    if (ev.state === 'in') {
      if (ev.period > 2 && !/^y/.test(b.key)) return null;
      const v = valueOf(b.key, b.side, ev);
      if (v == null) return null;
      const note = `достроково${ev.clock ? `, ${ev.clock}` : ''}`;
      if (v > b.line) return { res: 'win', v, early: true, note };
      // ЖК 1-го тайму: у 2-му таймі результат уже остаточний (картки з хвилиною з протоколу).
      if (b.key === 'y1' && ev.period >= 2) return { res: v === b.line ? 'void' : 'loss', v, early: true, note };
      return null;
    }
    if (!G.isResult(ev)) return null;
    if (EXTRA.test(ev.status || '') && !/^y/.test(b.key)) return { res: 'void', v: null, note: 'додатковий час' };   // рахунок 90 хв невідомий
    let v = valueOf(b.key, b.side, ev);
    if (b.key === 'c' && v === 0) v = null;   // 0 кутових у сумі — даних немає
    if (v == null) return null;
    return { res: v > b.line ? 'win' : v === b.line ? 'void' : 'loss', v };
  }

  // Стан матчу, що йде (для моніторингу): рахунок, хвилина, кутові й картки обох команд.
  const sideLive = t => ({ id: t.id, name: t.name, score: t.score, c: t.c ?? null, y: t.y ?? null, y1: t.y1 ?? null, c1: t.c1 ?? null });
  const liveOf = ev => ({ id: ev.id, state: ev.state, status: ev.status, clock: ev.clock || '', period: ev.period || 0, home: sideLive(ev.home), away: sideLive(ev.away) });

  // Рекомендації на матчі, що вже почались: беремо з попереднього знімка (лінії VBET на них уже немає) і
  // лишаємо, поки матч не закінчився, з поточним станом. Після кінця матчу ставка — у статистиці.
  function liveRows(prev, seasons, now = Date.now() / 1000, fresh = new Map()) {
    const evById = new Map();
    for (const s of seasons) for (const e of s.events) evById.set(e.id, e);
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
    const add = (id, slug, ts, c1) => {
      if (ts > now + 60 || now - ts > 4 * 3600) return;
      const x = out.get(id) || { id, slug, ts, c1: false };
      x.c1 = x.c1 || c1;
      out.set(id, x);
    };
    for (const b of bets) if (!b.res) add(b.ev, b.slug, b.ts, b.key === 'c1');
    for (const r of rows || []) add(r.ev.id, r.ev.slug, r.ev.ts, r.bets.some(c => c.key === 'c1' && c.ok));
    return [...out.values()];
  }

  // Матчі, для яких потрібні кутові 1-го тайму (коментар ESPN — окремий запит на кожен матч): 2 останні зіграні
  // матчі обох команд кожного майбутнього матчу в межах 3 днів у турнірах з коментарем, і матчі ставок extraIds,
  // які ще треба розрахувати. Лише матчі, що закінчились щонайменше 4 год тому: коментар уже повний.
  function halfCornerNeeds(seasons, now = Date.now() / 1000, extraIds = []) {
    const fin = new Map(), byId = new Map();
    for (const s of seasons) for (const e of s.events) {
      byId.set(e.id, { slug: s.comp.slug, ev: e });
      if (!G.isResult(e) || e.ts > now - 4 * 3600) continue;
      for (const t of [e.home, e.away]) { if (!fin.has(t.id)) fin.set(t.id, []); fin.get(t.id).push({ slug: s.comp.slug, ev: e }); }
    }
    for (const l of fin.values()) l.sort((a, b) => a.ev.ts - b.ev.ts);
    const out = new Map();
    for (const s of seasons) {
      if (!FP.C1_COMPS.has(s.comp.slug)) continue;
      for (const e of s.events) {
        if (e.state !== 'pre' || e.ts <= now || e.ts > now + CFG.HORIZON) continue;
        for (const t of [e.home, e.away]) for (const x of (fin.get(t.id) || []).slice(-2)) if (FP.C1_COMPS.has(x.slug)) out.set(x.ev.id, x);
      }
    }
    for (const id of extraIds) {
      const x = byId.get(id);
      if (x && G.isResult(x.ev) && x.ev.ts <= now - 4 * 3600) out.set(id, x);
    }
    return [...out.values()];
  }

  const profit = b => (b.res === 'win' ? CFG.STAKE * (b.odds - 1) : b.res === 'loss' ? -CFG.STAKE : 0);

  // ---------- серверний журнал ----------
  // Ставки записуються до початку матчу й оновлюються (кф, ймовірність) до самого старту. Після матчу —
  // розрахунок. Якщо до старту матч перестав підходити (кф упав нижче 1.49, серія змінилась) — запис видаляється.
  function updateJournal(journal, res, seasons, now = Date.now() / 1000, fresh = new Map()) {
    const evById = new Map();
    for (const s of seasons) for (const e of s.events) evById.set(e.id, e);
    for (const [id, e] of fresh) evById.set(id, e);   // свіжі дані матчів, що йдуть
    const live = new Map(res.bets.map(b => [b.id, b]));
    const evaluated = new Set(res.evaluated), keep = new Set(res.keep);
    for (const b of res.bets) {
      if (b.ts < CFG.STATS_FROM || b.ts <= now) continue;
      const old = journal.bets[b.id];
      if (old && old.ts <= now) continue;
      journal.bets[b.id] = { ...b, first: old ? old.first : Math.round(now), at: Math.round(now), res: null };
    }
    for (const [id, b] of Object.entries(journal.bets)) {
      if (b.res) continue;
      const ev = evById.get(b.ev);
      if (b.ts > now) {
        if (ev && VOID.test(ev.status || '')) delete journal.bets[id];
        else if (!live.has(id) && evaluated.has(b.ev) && !keep.has(id)) delete journal.bets[id];
        else if (ev && ev.ts !== b.ts && ev.ts > now) b.ts = ev.ts;
        continue;
      }
      const s = settle(b, ev);
      if (s && s.res === 'cancel') { delete journal.bets[id]; continue; }
      if (s && s.res) Object.assign(b, { res: s.res, v: s.v, settled: Math.round(now) }, s.note ? { note: s.note } : {}, s.early ? { early: true } : {});
      else if (now - b.ts > 3 * 86400) Object.assign(b, { res: 'void', v: null, note: 'немає даних' });
      if (b.res) { b.profit = Math.round(profit(b) * 100) / 100; delete b.live; }
      else if (ev && ev.state === 'in') b.live = { clock: ev.clock || '', v: valueOf(b.key, b.side, ev) };
    }
    return journal;
  }

  // ---------- паралельні статистики ----------
  // Ставки одного ринку за часом початку. Ставка йде в першу статистику, де попередній матч почався щонайменше
  // за 2 год до неї (уже закінчився); якщо такої немає — відкривається нова. Тож матчі, що перетинаються в часі,
  // ніколи не потрапляють в одну статистику. Кожна статистика — окремий банк 10 000 грн, ставка 50 грн.
  function streams(list) {
    const sorted = list.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const out = [];
    for (const b of sorted) {
      let s = out.find(x => x.free <= b.ts);
      if (!s) { s = { no: out.length + 1, bets: [], free: 0 }; out.push(s); }
      s.bets.push(b);
      s.free = b.ts + CFG.GAP;
    }
    for (const s of out) {
      const done = s.bets.filter(b => b.res);
      s.profit = done.reduce((t, b) => t + (b.profit ?? profit(b)), 0);
      s.balance = CFG.BANK + s.profit;
      s.w = done.filter(b => b.res === 'win').length;
      s.l = done.filter(b => b.res === 'loss').length;
      s.v = done.filter(b => b.res === 'void').length;
      s.pending = s.bets.length - done.length;
    }
    return out;
  }

  return { analyze, settle, valueOf, liveOf, liveRows, liveNeeds, profit, updateJournal, streams, halfCornerNeeds, MARKETS, MARKET };
})();
