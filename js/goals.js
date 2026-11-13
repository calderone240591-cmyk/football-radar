// Модель голів.
// 1. Рейтинги атаки й оборони кожної команди за всіма її матчами в усіх турнірах (≈ 150 днів) з урахуванням
//    сили суперників; свіжі матчі важать більше. Турніри пов'язані між собою єврокубками, кубками й
//    матчами збірних, тож рейтинги порівнювані.
// 2. Очікувані голи → Пуассон з поправкою Діксона–Коулза.
// 3. Якщо є кф VBET на результат і тотал, очікувані голи підганяються під суміш 70% ринок + 30% модель:
//    ринок враховує склади й новини, яких модель не бачить.
FP.goals = (() => {
  const PRIOR_GAMES = 4;
  const HALF_LIFE_DAYS = 90;
  const RHO = -0.08;
  const MAX_GOALS = 10;
  const MARKET_WEIGHT = 0.7;
  // Калібрування за бектестом: модель недооцінювала голи господарів і гостей.
  const TUNE = { home: 1.06, away: 1.12 };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isResult = e => e.state === 'post' && e.completed && e.home.score != null && e.away.score != null;

  // ---------- рейтинги ----------
  function fit(events, asOf) {
    const now = asOf || Date.now() / 1000;
    const matches = events.filter(isResult).map(e => ({
      h: e.home.id, a: e.away.id, hg: e.home.score, ag: e.away.score,
      w: Math.pow(0.5, Math.max(0, now - e.ts) / 86400 / HALF_LIFE_DAYS),
    }));
    let sh = 0, sa = 0, sw = 0;
    for (const m of matches) { sh += m.w * m.hg; sa += m.w * m.ag; sw += m.w; }
    const avgH = (sh + 1.45 * 15) / (sw + 15);
    const avgA = (sa + 1.15 * 15) / (sw + 15);
    const avgG = (avgH + avgA) / 2;

    const ids = new Set();
    for (const m of matches) { ids.add(m.h); ids.add(m.a); }
    const att = new Map([...ids].map(id => [id, 1]));
    const def = new Map([...ids].map(id => [id, 1]));
    const kk = PRIOR_GAMES * avgG;
    const mean = m => { let s = 0, n = 0; for (const v of m.values()) { s += v; n++; } return n ? s / n : 1; };

    for (let it = 0; it < 25; it++) {
      const acc = new Map([...ids].map(id => [id, { gf: 0, ef: 0, ga: 0, ea: 0 }]));
      for (const m of matches) {
        const H = acc.get(m.h), A = acc.get(m.a);
        H.gf += m.w * m.hg; H.ef += m.w * avgH * def.get(m.a);
        H.ga += m.w * m.ag; H.ea += m.w * avgA * att.get(m.a);
        A.gf += m.w * m.ag; A.ef += m.w * avgA * def.get(m.h);
        A.ga += m.w * m.hg; A.ea += m.w * avgH * att.get(m.h);
      }
      for (const id of ids) {
        const x = acc.get(id);
        att.set(id, (x.gf + kk) / (x.ef + kk));
        def.set(id, (x.ga + kk) / (x.ea + kk));
      }
      const ma = mean(att), md = mean(def);
      for (const id of ids) { att.set(id, att.get(id) / ma); def.set(id, def.get(id) / md); }
    }
    return { avgH, avgA, att, def, ids };
  }

  // Форма за останні 5 матчів відносно середнього рівня команди: до ±6% до голів.
  function forms(events) {
    const out = new Map();
    for (const e of events.filter(isResult)) {
      for (const [me, op] of [[e.home, e.away], [e.away, e.home]]) {
        if (!out.has(me.id)) out.set(me.id, { pts: 0, p: 0, form: [] });
        const t = out.get(me.id);
        const pts = me.score > op.score ? 3 : me.score === op.score ? 1 : 0;
        t.pts += pts; t.p++; t.form.push(pts);
        if (t.form.length > 5) t.form.shift();
      }
    }
    const factor = new Map();
    for (const [id, t] of out) {
      const ppg5 = t.form.reduce((s, x) => s + x, 0) / t.form.length;
      factor.set(id, 1 + clamp((ppg5 - t.pts / t.p) * 0.05, -0.06, 0.06));
    }
    return factor;
  }

  // Одна модель на всі турніри. events — за часом.
  function build(events, asOf) {
    const f = fit(events, asOf);
    const form = forms(events);
    const teams = new Map();
    for (const id of f.ids) teams.set(id, { id, att: f.att.get(id), def: f.def.get(id), form: form.get(id) || 1 });
    return { avgH: f.avgH, avgA: f.avgA, teams };
  }

  // ---------- розподіли ----------
  function poissonPmf(lambda, max = MAX_GOALS) {
    const out = [Math.exp(-lambda)];
    for (let k = 1; k <= max; k++) out.push(out[k - 1] * lambda / k);
    return out;
  }

  // Ймовірність «більше line» (лінії .5 — без повернень).
  function overProb(pmf, line) {
    let win = 0, sum = 0;
    pmf.forEach((v, k) => { sum += v; if (k > line) win += v; });
    return win + Math.max(0, 1 - sum);   // хвіст за межею таблиці
  }

  function tau(h, a, lh, la) {
    if (h === 0 && a === 0) return 1 - lh * la * RHO;
    if (h === 0 && a === 1) return 1 + lh * RHO;
    if (h === 1 && a === 0) return 1 + la * RHO;
    if (h === 1 && a === 1) return 1 - RHO;
    return 1;
  }

  function grid(lh, la) {
    const ph = poissonPmf(lh), pa = poissonPmf(la);
    const g = [];
    let total = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      g.push([]);
      for (let a = 0; a <= MAX_GOALS; a++) { const v = Math.max(0, ph[h] * pa[a] * tau(h, a, lh, la)); g[h].push(v); total += v; }
    }
    for (const row of g) for (let a = 0; a < row.length; a++) row[a] /= total;
    return g;
  }

  function core(g, line) {
    let p1 = 0, px = 0, p2 = 0, over = 0;
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) {
      const v = g[h][a];
      if (h > a) p1 += v; else if (h === a) px += v; else p2 += v;
      if (line && h + a > line) over += v;
    }
    return { p1, px, p2, over };
  }

  // Очікувані голи, за яких ймовірності 1X2 і тоталу збігаються з цільовими.
  function fitLambdas(target, line, lh0, la0) {
    const err = (lh, la) => {
      const c = core(grid(lh, la), line);
      let e = (c.p1 - target.p1) ** 2 + (c.px - target.px) ** 2 + (c.p2 - target.p2) ** 2;
      if (line && target.over != null) e += (c.over - target.over) ** 2;
      return e;
    };
    let best = { lh: lh0, la: la0, e: err(lh0, la0) };
    for (const step of [0.1, 0.03, 0.01]) {
      const span = step === 0.1 ? 1.5 : step * 5;
      const cl = best.lh, ca = best.la;
      for (let lh = Math.max(0.1, cl - span); lh <= cl + span; lh += step) {
        for (let la = Math.max(0.1, ca - span); la <= ca + span; la += step) {
          const e = err(lh, la);
          if (e < best.e) best = { lh, la, e };
        }
      }
    }
    return best;
  }

  // Ринкові ймовірності без маржі з кф VBET (book).
  function marketProbs(book) {
    if (!book || !book['1'] || !book.X || !book['2']) return null;
    const i1 = 1 / book['1'], ix = 1 / book.X, i2 = 1 / book['2'];
    const s = i1 + ix + i2;
    const out = { p1: i1 / s, px: ix / s, p2: i2 / s };
    for (const line of [2.5, 1.5, 3.5]) {
      const o = book[`O${line}`], u = book[`U${line}`];
      if (o && u) { out.line = line; out.over = (1 / o) / (1 / o + 1 / u); break; }
    }
    return out;
  }

  // Очікувані голи господарів і гостей { lh, la, model: { lh, la }, market } або null.
  // Команда без зіграних матчів в історії — середнього рівня.
  const AVG = { att: 1, def: 1, form: 1 };
  function lambdas(m, ev, book) {
    const H = m.teams.get(ev.home.id) || AVG, A = m.teams.get(ev.away.id) || AVG;
    const mlh = clamp(m.avgH * H.att * A.def * H.form * TUNE.home, 0.15, 4.5);
    const mla = clamp(m.avgA * A.att * H.def * A.form * TUNE.away, 0.15, 4.5);
    const market = marketProbs(book);
    if (!market) return { lh: mlh, la: mla, model: { lh: mlh, la: mla }, market: false };
    const mc = core(grid(mlh, mla), market.line);
    const mix = (x, y) => MARKET_WEIGHT * x + (1 - MARKET_WEIGHT) * y;
    const target = {
      p1: mix(market.p1, mc.p1), px: mix(market.px, mc.px), p2: mix(market.p2, mc.p2),
      over: market.over != null ? mix(market.over, mc.over) : null,
    };
    const { lh, la } = fitLambdas(target, market.line, mlh, mla);
    return { lh, la, model: { lh: mlh, la: mla }, market: true };
  }

  // Ймовірність тоталу голів матчу більше line.
  const totalOver = (lh, la, line) => {
    const g = grid(lh, la);
    let p = 0;
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) if (h + a > line) p += g[h][a];
    return p;
  };

  return { build, lambdas, totalOver, poissonPmf, overProb, isResult, MARKET_WEIGHT };
})();
