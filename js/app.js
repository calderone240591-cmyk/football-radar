// Інтерфейс «Футбол Радар». Рекомендації й статистика — із серверного журналу (tools/record.js, оновлюється
// приблизно кожні 10 хв), тож однакові на всіх пристроях. На пристрої — лише live-моніторинг матчів, що йдуть.
(() => {
  const { CFG, engine } = FP;
  const MK = engine.MARKET;
  const STALE = 40 * 60;
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $upd = document.getElementById('upd');
  const state = { journal: null, loading: null, live: new Map(), liveBusy: null };

  // ---------- форматування ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = FP.pad;
  const nowS = () => Date.now() / 1000;
  const pct = p => (p == null ? '—' : Math.round(p * 100) + '%');
  const k2 = x => (x == null ? '—' : Number(x).toFixed(2));
  const timeOf = ts => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dateOf = ts => { const d = new Date(ts * 1000); return `${d.getDate()}.${pad(d.getMonth() + 1)}`; };
  const dayStart = ts => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const dayName = ts => {
    const o = Math.round((dayStart(ts) - dayStart(nowS())) / 86400);
    return o === 0 ? 'сьогодні' : o === 1 ? 'завтра' : `${WD[new Date(ts * 1000).getDay()]} ${dateOf(ts)}`;
  };
  const when = ts => `${dayName(ts)} ${timeOf(ts)}`;
  const ago = ts => {
    const m = Math.round((nowS() - ts) / 60);
    return m < 1 ? 'щойно' : m < 60 ? `${m} хв тому` : m < 48 * 60 ? `${Math.round(m / 60)} год тому` : `${Math.round(m / 1440)} дн тому`;
  };
  const uah = v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('uk-UA')} грн`;
  const money = v => `${Math.round(v).toLocaleString('uk-UA')} грн`;
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  const nMatches = n => `${n} ${plural(n, 'матч', 'матчі', 'матчів')}`;
  const nTeams = n => `${n} ${plural(n, 'команда', 'команди', 'команд')}`;
  const pClass = p => (p == null ? '' : p >= 0.65 ? 'hi' : p >= 0.5 ? 'mid' : 'lo');
  const cls = v => (v > 0 ? 'ok' : v < 0 ? 'bad' : '');
  const roiTxt = r => (r == null ? '—' : `${r >= 0 ? '+' : '−'}${Math.abs(Math.round(r * 100))}%`);
  const seriesTxt = (n, capped) => `${n}${capped ? '+' : ''}`;

  // ---------- дані ----------
  async function fetchJournal() {
    try {
      // ?journal=<адреса> — інший журнал (перевірка на ноутбуці).
      const src = new URLSearchParams(location.search).get('journal') || CFG.JOURNAL;
      const res = await fetch(`${src}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      if (j.version !== CFG.VERSION) throw new Error('version');
      FP.store.put('journal', j);
      return j;
    } catch {
      const j = FP.store.get('journal');
      return j && j.version === CFG.VERSION ? j : null;
    }
  }
  const snapshot = () => (state.journal && state.journal.snapshot) || null;

  function load() {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      await FP.store.ready;
      if (!state.journal) { const j = FP.store.get('journal'); state.journal = j && j.version === CFG.VERSION ? j : null; }
      if (state.journal) render();
      state.journal = (await fetchJournal()) || state.journal;
      render();
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // ---------- live-моніторинг ----------
  // Поки є матчі, що йдуть, раз на хвилину беремо з ESPN рахунок і хвилину. Ставка, що вже зайшла,
  // одразу показується виграною достроково — сервер підтвердить її за кілька хвилин.
  async function pollLive() {
    if (state.liveBusy) return state.liveBusy;
    const s = snapshot();
    const need = engine.liveNeeds(journalBets(), s ? s.rows : []);
    if (!need.length) return false;
    state.liveBusy = FP.api.live(need)
      .then(m => { for (const [id, e] of m) state.live.set(id, e); return true; })
      .catch(() => false)
      .finally(() => { state.liveBusy = null; });
    return state.liveBusy;
  }
  const liveEv = (id, fallback) => state.live.get(id) || fallback || null;
  const isStarted = r => r.ev.ts <= nowS();
  const rowVisible = r => {
    if (!isStarted(r)) return true;
    if (nowS() - r.ev.ts > 4 * 3600) return false;
    const e = liveEv(r.ev.id, r.live);
    return e ? e.state !== 'post' : nowS() - r.ev.ts < 2.5 * 3600;
  };

  // ---------- ставки ----------
  const journalBets = () => (state.journal ? Object.values(state.journal.bets) : []);
  // Ставка без результату, що вже зайшла під час матчу (дані ESPN на пристрої), — виграна достроково.
  function allBets() {
    return journalBets().filter(b => b.ts >= CFG.STATS_FROM).map(b => {
      if (b.res || b.ts > nowS()) return b;
      const e = state.live.get(b.ev);
      const s = e && e.state === 'in' ? engine.settle(b, e) : null;
      return s && s.res === 'win' ? { ...b, res: s.res, v: s.v, sc: s.sc, note: s.note, early: true, prov: true } : b;
    });
  }

  // ---------- оболонка ----------
  function setHeader(title, tab) {
    $title.textContent = title;
    document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
    const s = snapshot();
    $upd.textContent = s ? `оновлено ${ago(s.at)}` : '';
    $upd.className = `upd ${s && nowS() - s.at > STALE ? 'old' : ''}`;
  }
  const banner = () => {
    const s = snapshot();
    if (!s) return '';
    const notes = [];
    if (nowS() - s.at > STALE) notes.push(`Сервер не оновлював дані ${ago(s.at).replace(' тому', '')} — рекомендації можуть бути застарілі.`);
    if (s.vbet && s.vbet.error) notes.push(`VBET був недоступний (${esc(s.vbet.error)}) — кф немає.`);
    if (s.errors) notes.push(`Не завантажено днів ESPN: ${s.errors}.`);
    return notes.length ? `<div class="banner warn">${notes.join(' ')}</div>` : '';
  };
  const noData = () => `<div class="empty">${state.loading ? 'Завантаження…' : 'Сервер ще не порахував рекомендації (перший прохід — до 10–15 хв). Натисніть «Оновити» трохи пізніше.'}</div>`;
  const hint = html => `<p class="hint">${html}</p>`;
  const need = line => `${Math.floor(line) + 1}+`;

  // ---------- клітинки ставок ----------
  // Результат ставки матчу, що йде: із журналу, інакше — з поточних даних (зайшла достроково чи ще ні).
  function liveBet(c, r) {
    const jb = state.journal && state.journal.bets[c.id];
    const e = liveEv(r.ev.id, r.live);
    const v = e && e.state === 'in' ? engine.valueOf(c.key, r.side, e) : null;
    if (jb && jb.res) return { res: jb.res, v: jb.v ?? v, early: jb.early };
    const s = e ? engine.settle({ key: c.key, side: r.side, line: c.line }, e) : null;
    return { res: s && s.res !== 'cancel' ? s.res : null, v, early: !!(s && s.early) };
  }
  const star = c => (c.top ? '<span class="star" title="Топ за ймовірністю">★</span>' : '');
  function cellHtml(c, r) {
    if (isStarted(r)) {
      if (!c.odds) return `<td class="c skip">·</td>`;
      const x = liveBet(c, r);
      if (x.res === 'win') return `<td class="c win"><b>✓ ${x.v ?? ''}</b><small>${x.early ? 'достроково' : 'зайшла'}</small><em>${star(c)}кф ${k2(c.odds)}</em></td>`;
      if (x.res === 'loss') return `<td class="c lost"><b>✗ ${x.v ?? ''}</b><em>кф ${k2(c.odds)}</em></td>`;
      if (x.res === 'void') return `<td class="c"><b>↺</b><small>повернення</small></td>`;
      return `<td class="c ok"><b>${x.v ?? '?'}</b><small>треба ${need(c.line)}</small><em>${star(c)}кф ${k2(c.odds)}</em></td>`;
    }
    if (!c.odds) return `<td class="c none"><span>немає в лінії</span><small class="lo">${pct(c.p)}</small></td>`;
    return `<td class="c ok ${c.top ? 'top' : ''}"><b>${k2(c.odds)}</b><small class="${pClass(c.p)}">${pct(c.p)}</small>${c.top ? '<em><span class="star">★</span> топ</em>' : ''}</td>`;
  }

  const timeCell = r => {
    if (!isStarted(r)) return `<b class="t">${when(r.ev.ts)}</b>`;
    const e = liveEv(r.ev.id, r.live);
    return `<b class="t live">● ${esc(e && e.state === 'in' ? e.clock : 'почався')}</b>`;
  };
  const liveLine = r => {
    if (!isStarted(r)) return '';
    const e = liveEv(r.ev.id, r.live);
    if (!e || e.state !== 'in') return '<small class="livel">чекаю дані матчу…</small>';
    return `<small class="livel">рахунок <b>${e.home.score ?? '?'}:${e.away.score ?? '?'}</b></small>`;
  };
  // Останні матчі команди: голи команди першими, нуль у засусі виділено.
  const recentHtml = (list, hl) => (list || []).map(x => `<span class="sc ${hl(x) ? 'z' : ''}" title="${esc(`${dateOf(x.ts)} ${x.h ? 'вдома' : 'у гостях'} — ${x.vs}`)}">${x.g}:${x.ga}</span>`).join('');

  const betName = (r, c) => (r.type === 'dry' ? `${esc(r.ev[r.side].short)} ${MK.get(c.key).label}` : MK.get(c.key).label);

  // ---------- рядки вкладок ----------
  function dryRowHtml(r) {
    const team = r.ev[r.side], opp = r.ev[r.side === 'home' ? 'away' : 'home'];
    const pair = r.side === 'home' ? `<span class="dry">${esc(team.short)}</span> – ${esc(opp.short)}` : `${esc(opp.short)} – <span class="dry">${esc(team.short)}</span>`;
    return `<tr><td class="m">${timeCell(r)} ${pair} <i class="tag">${seriesTxt(r.n, r.capped)} без гола</i>
      <small>${esc(r.ev.league)} · очік. голів ${esc(team.short)} ${r.lambda}</small>
      ${isStarted(r) ? liveLine(r) : `<small class="rec">${recentHtml(r.recent, x => x.g === 0)}</small>`}</td>
      ${r.bets.map(c => cellHtml(c, r)).join('')}</tr>`;
  }
  function lowRowHtml(r) {
    const t = sd => `<span class="${r.sides.includes(sd) ? 'dry' : ''}">${esc(r.ev[sd].short)}</span>${r.sides.includes(sd) ? ` <i class="tag">${seriesTxt(r.low[sd], r.capped[sd])}</i>` : ''}`;
    const rec = sd => `<small class="rec"><span class="who">${esc(r.ev[sd].short)}</span>${recentHtml(r.recent[sd], x => x.g + x.ga <= 1)}</small>`;
    return `<tr><td class="m">${timeCell(r)} ${t('home')} – ${t('away')}
      <small>${esc(r.ev.league)} · очік. голів у матчі ${r.xg}</small>
      ${isStarted(r) ? liveLine(r) : r.sides.map(rec).join('')}</td>
      ${r.bets.map(c => cellHtml(c, r)).join('')}</tr>`;
  }

  // ---------- топ за ймовірністю (обидві вкладки) ----------
  function topBlock() {
    const s = snapshot();
    const list = (s ? s.rows : []).filter(r => !isStarted(r)).flatMap(r => r.bets.filter(c => c.top).map(c => ({ r, c })))
      .sort((a, b) => b.c.p - a.c.p);
    if (!list.length) return '';
    return `<section class="card top"><h3>★ Топ-${CFG.TOP_N} за ймовірністю</h3><div class="tw"><table class="grid">
      <thead><tr><th>Матч · ставка</th><th>Кф</th><th>Ймов.</th></tr></thead>
      <tbody>${list.map(({ r, c }, i) => `<tr><td class="m"><b class="t">${i + 1}. ${when(r.ev.ts)}</b> ${esc(r.ev.home.short)} – ${esc(r.ev.away.short)}
          <small><b class="pick">${betName(r, c)}</b> · ${r.type === 'dry' ? `${seriesTxt(r.n, r.capped)} без гола` : `серія ТМ 1.5: ${r.n}`} · ${esc(r.ev.league)}</small></td>
          <td><b>${k2(c.odds)}</b></td><td><b class="${pClass(c.p)}">${pct(c.p)}</b></td></tr>`).join('')}</tbody></table></div>
      ${hint('Найімовірніші рекомендації з обох вкладок (лише з кф VBET). Ставки, що були в топі на момент початку матчу, ідуть в окрему статистику «Топ».')}</section>`;
  }

  // Матчі, що вже йдуть, і майбутні — групами за довжиною серії (найдовша першою), у групі — за часом.
  function tabBody(type, head, rowHtml, unit) {
    const s = snapshot();
    const rows = s.rows.filter(r => r.type === type && rowVisible(r));
    const live = rows.filter(isStarted).sort((a, b) => a.ev.ts - b.ev.ts);
    const next = rows.filter(r => !isStarted(r)).sort((a, b) => b.n - a.n || a.ev.ts - b.ev.ts);
    const table = list => `<div class="tw"><table class="grid">${head}<tbody>${list.map(rowHtml).join('')}</tbody></table></div>`;
    const groups = new Map();
    for (const r of next) { if (!groups.has(r.n)) groups.set(r.n, []); groups.get(r.n).push(r); }
    return `${live.length ? `<section class="card livec"><h3><span class="live">●</span> Зараз ідуть · ${live.length}</h3>${table(live)}
        ${hint('У клітинці — скільки є зараз і скільки треба; ✓ «достроково» — ставка вже зайшла під час матчу і пішла в статистику виграною, не чекаючи кінця. Оновлюється щохвилини, поки додаток відкритий.')}</section>` : ''}
      ${topBlock()}
      ${next.length ? [...groups].map(([n, list]) => `<section class="card"><h3 class="grp"><b>${n}</b> ${unit(n)} <span>· ${nMatches(list.length)}</span></h3>${table(list)}</section>`).join('')
        : '<div class="empty">Найближчі 3 дні матчів команд із серією немає.</div>'}`;
  }

  // Усі команди із серією (і без матчу найближчими днями).
  function teamsTable(title, list, valHtml) {
    if (!list.length) return '';
    return `<details class="more card"><summary>${title} · ${list.length}</summary><div class="tw"><table class="grid teams">
      <thead><tr><th>Команда</th><th>Серія</th><th>Наступний матч</th></tr></thead>
      <tbody>${list.map(t => {
        const nx = t.next;
        return `<tr><td class="m"><b>${esc(t.team.name)}</b><small>${esc(t.league)}</small><small>останній: ${t.last.g}:${t.last.ga} з ${esc(t.last.vs)}, ${dateOf(t.last.ts)}</small></td>
          <td>${valHtml(t)}</td>
          <td class="m">${nx ? `${nx.home ? 'вдома' : 'у гостях'} — ${esc(nx.vs)}<small>${dateOf(nx.ts)} ${timeOf(nx.ts)} · ${esc(nx.league)}${nx.state === 'in' ? ' · іде' : nx.line ? ' · є кф VBET' : ''}</small>` : '<small>немає в розкладі</small>'}</td></tr>`;
      }).join('')}</tbody></table></div></details>`;
  }

  // ---------- Засуха ----------
  function renderDry() {
    setHeader('Засуха', 'dry');
    const s = snapshot();
    if (!s) { $view.innerHTML = banner() + noData(); return; }
    const rows = s.rows.filter(r => r.type === 'dry' && !isStarted(r));
    const head = `<thead><tr><th>Матч · команда без гола</th>${engine.MARKETS.filter(m => m.tab === 'dry').map(m => `<th>${m.label}</th>`).join('')}</tr></thead>`;
    $view.innerHTML = `${banner()}
      <p class="summary">Не забивають ${CFG.DRY_MIN}+ матчі поспіль: <b>${nTeams(s.dry.length)}</b> · грають найближчі 3 дні: <b>${rows.length}</b> · з кф VBET: <b>${rows.filter(r => r.bets.some(c => c.odds)).length}</b></p>
      ${tabBody('dry', head, dryRowHtml, n => `${plural(n, 'матч', 'матчі', 'матчів')} без гола`)}
      ${hint(`Виділено команду, що не забиває. ІТБ — індивідуальний тотал цієї команди: <b>ІТБ 0.5</b> — заб'є хоча б 1 гол; <b>ІТБ 1.5</b> — заб'є 2+. У клітинці — кф VBET і ймовірність виграшу (<span class="lg phi">від 65%</span>, <span class="lg pmid">50–64%</span>). Під матчем — рахунки останніх матчів команди (її голи першими). «5+» — серія довша за ${CFG.HISTORY_DAYS} днів історії.`)}
      ${teamsTable('Усі команди без гола 2+ матчі', s.dry, t => `<b class="n">${seriesTxt(t.n, t.capped)}</b><small>${t.lastGoal ? `гол ${dateOf(t.lastGoal)}` : 'без голів'}</small>`)}
      ${legendCard()}`;
  }

  // ---------- Тотали ----------
  function renderLow() {
    setHeader('Тотали', 'low');
    const s = snapshot();
    if (!s) { $view.innerHTML = banner() + noData(); return; }
    const rows = s.rows.filter(r => r.type === 'low' && !isStarted(r));
    const head = `<thead><tr><th>Матч · серія без ТБ 1.5</th>${engine.MARKETS.filter(m => m.tab === 'low').map(m => `<th>${m.label}</th>`).join('')}</tr></thead>`;
    $view.innerHTML = `${banner()}
      <p class="summary">Команд, у матчах яких ${CFG.LOW_MIN}+ рази поспіль не було ТБ 1.5: <b>${s.low.length}</b> · матчів найближчі 3 дні: <b>${rows.length}</b> · з кф VBET: <b>${rows.filter(r => r.bets.some(c => c.odds)).length}</b></p>
      ${tabBody('low', head, lowRowHtml, n => `${plural(n, 'матч', 'матчі', 'матчів')} поспіль ≤ 1 гола`)}
      ${hint(`Виділено команду із серією: у ${CFG.LOW_MIN}+ її останніх матчах поспіль на двох було не більше 1 гола (0:0, 1:0, 0:1 — не зайшов ТБ 1.5). Ставки — загальний тотал матчу: <b>ТБ 1.5</b> — 2+ голи, <b>ТБ 2.5</b> — 3+. Під матчем — рахунки останніх матчів команди із серією.`)}
      ${teamsTable(`Усі команди із серією ${CFG.LOW_MIN}+ матчі без ТБ 1.5`, s.low, t => `<b class="n">${seriesTxt(t.n, t.capped)}</b>`)}
      ${legendCard()}`;
  }

  const legendCard = () => `<details class="more card"><summary>Як це рахується</summary><div class="desc">
    <p><b>Матчі</b> — ESPN, усі турніри (чемпіонати всіх рівнів, кубки, єврокубки, Ліга націй, відбори, товариські збірних, жіночі й молодіжні), без студентських ліг США і клубних товариських. Серія — за всіма матчами команди за ${CFG.HISTORY_DAYS} днів; враховуються команди, у яких в історії щонайменше ${CFG.MIN_GAMES} матчі (інакше ESPN бачить лише їхні кубкові матчі). Рекомендація — на наступний матч команди найближчих 3 днів.</p>
    <p><b>Кф</b> — VBET (уся лінія vbet.ua), будь-які. <b>Ймовірність</b> — модель голів (рейтинги атаки й оборони кожної команди за всіма матчами з урахуванням суперників, Пуассон з поправкою Діксона–Коулза), підігнана під кф VBET на результат і тотал; якщо VBET дає обидві сторони лінії — 70% ринок без маржі + 30% модель.</p>
    <p><b>Достроково.</b> Усі ставки — «більше», тож щойно лінію перевищено в основний час (другий гол на ТБ 1.5), ставка йде в статистику виграною з позначкою «достроково». Додатковий час не рахується.</p></div></details>`;

  // ---------- Статистика ----------
  const STATS = [
    { key: 'dry', title: 'Засуха', what: `ІТБ 0.5 і ІТБ 1.5 команди, що не забиває ${CFG.DRY_MIN}+ матчі`, test: b => b.tab === 'dry' },
    { key: 'low', title: 'Тотали', what: `ТБ 1.5 і ТБ 2.5 у матчі команди без ТБ 1.5 ${CFG.LOW_MIN}+ матчі`, test: b => b.tab === 'low' },
    { key: 'top', title: '★ Топ', what: `ставки з топ-${CFG.TOP_N} за ймовірністю на момент початку матчу (обидві вкладки)`, test: b => !!b.top },
  ];
  const RES_ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '<i class="vd">↺</i>' };
  const pOf = b => b.profit ?? engine.profit(b);
  const ordered = list => list.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  function summaryOf(list) {
    const done = ordered(list.filter(b => b.res)), dec = done.filter(b => b.res !== 'void');
    const w = done.filter(b => b.res === 'win').length, l = done.filter(b => b.res === 'loss').length, v = done.length - w - l;
    let cum = 0, peak = 0, dd = 0, lose = 0, maxLose = 0;
    for (const b of done) {
      cum += pOf(b); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
      if (b.res === 'loss') { lose++; maxLose = Math.max(maxLose, lose); } else if (b.res === 'win') lose = 0;
    }
    return {
      n: done.length, w, l, v, profit: cum, balance: CFG.BANK + cum, dd, maxLose, pending: list.length - done.length,
      early: done.filter(b => b.early).length,
      hit: w + l ? w / (w + l) : null,
      exp: dec.length ? dec.reduce((s, b) => s + b.p, 0) / dec.length : null,
      odds: dec.length ? dec.reduce((s, b) => s + b.odds, 0) / dec.length : null,
      roi: done.length ? cum / (done.length * CFG.STAKE) : null,
    };
  }

  function renderStats() {
    setHeader('Статистика', 'stats');
    const bets = allBets();
    const card = st => {
      const list = bets.filter(st.test), s = summaryOf(list);
      return `<a class="card stat" href="#/stats/${st.key}">
        <div class="st-h"><h3>${st.title}</h3><span class="bal ${cls(s.profit)}">${money(s.balance)}</span></div>
        <p class="what">${esc(st.what)}</p>
        <div class="st-row">
          <div><b>${s.n}</b><span>зіграно${s.pending ? ` · чекають ${s.pending}` : ''}</span></div>
          <div><b>${s.n ? `${s.w}/${s.l}/${s.v}` : '—'}</b><span>В / П / Пов</span></div>
          <div><b>${s.hit != null ? pct(s.hit) : '—'}</b><span>влучність · очік. ${pct(s.exp)}</span></div>
          <div><b class="${cls(s.profit)}">${s.n ? uah(s.profit) : '—'}</b><span>ROI ${roiTxt(s.roi)}</span></div>
        </div><span class="more-link">докладно ›</span></a>`;
    };
    $view.innerHTML = `${banner()}
      <p class="summary">Облік з ${dateOf(CFG.STATS_FROM)} · кожна статистика — депозит <b>${money(CFG.BANK)}</b>, ставка <b>${CFG.STAKE} грн</b> на кожну рекомендацію, кф VBET — останній перед початком матчу</p>
      ${STATS.map(card).join('')}
      ${hint('Ставка йде в статистику до початку матчу; кф і ймовірність оновлюються до старту (перший кф теж зберігається). Влучність — виграші / (виграші + програші); очікувана — середня ймовірність цих ставок до матчу. ROI — прибуток / (ставок × ' + CFG.STAKE + ' грн).')}`;
  }

  // Розбивка: рядки { label, list }.
  function breakdown(title, groups) {
    const rows = groups.filter(g => g.list.length);
    if (!rows.length) return '';
    return `<section class="card"><h3>${title}</h3><div class="tw"><table class="grid stats">
      <thead><tr><th></th><th>Ставок</th><th>В/П/Пов</th><th>Влучн.</th><th>Прибуток</th></tr></thead>
      <tbody>${rows.map(g => {
        const s = summaryOf(g.list);
        return `<tr><td class="m"><b>${esc(g.label)}</b></td><td>${s.n}${s.pending ? `<small>+${s.pending}</small>` : ''}</td><td>${s.n ? `${s.w}/${s.l}/${s.v}` : '—'}</td>
          <td>${s.hit != null ? `<b>${pct(s.hit)}</b><small>оч. ${pct(s.exp)}</small>` : '—'}</td>
          <td class="${cls(s.profit)}">${s.n ? `${uah(s.profit)}<small>ROI ${roiTxt(s.roi)}</small>` : '—'}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;
  }
  const bucket = (list, val, edges, fmt) => edges.slice(0, -1).map((lo, i) => ({ label: fmt(lo, edges[i + 1]), list: list.filter(b => { const v = val(b); return v != null && v >= lo && v < edges[i + 1]; }) }));

  function balanceChart(list) {
    const done = ordered(list.filter(b => b.res));
    if (done.length < 2) return '';
    let cum = 0;
    const pts = [CFG.BANK, ...done.map(b => CFG.BANK + (cum += pOf(b)))];
    const W = 300, H = 100, lo = Math.min(CFG.BANK, ...pts), hi = Math.max(CFG.BANK, ...pts), span = hi - lo || 1;
    const x = i => (i / (pts.length - 1)) * W, y = v => H - ((v - lo) / span) * H;
    const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Баланс">
      <line x1="0" x2="${W}" y1="${y(CFG.BANK).toFixed(1)}" y2="${y(CFG.BANK).toFixed(1)}" class="zero"/><path d="${path}" class="${cum >= 0 ? 'up' : 'down'}"/></svg>
      <div class="chart-axis"><span>${dateOf(done[0].ts)}</span><span>баланс ${money(CFG.BANK + cum)} · мін ${money(Math.min(...pts))}</span><span>${dateOf(done[done.length - 1].ts)}</span></div></div>`;
  }

  // ---------- CSV для аналізу (Excel: роздільник «;», десяткова кома) ----------
  function csv(list, name) {
    const num = x => (x == null ? '' : String(x).replace('.', ','));
    const RES = { win: 'виграш', loss: 'програш', void: 'повернення' };
    const head = ['Дата', 'Час', 'Турнір', 'Господарі', 'Гості', 'Команда із серією', 'Серія', 'Серія господарів (ТМ1.5)', 'Серія гостей (ТМ1.5)', 'Ринок', 'Лінія', 'Кф', 'Кф перший', 'Ймовірність', 'Ймовірність перша', 'Очік. голів', 'Топ', 'Результат', 'Прибуток', 'Значення', 'Рахунок при розрахунку', 'Рахунок фінальний', 'Достроково', 'Примітка'];
    const rows = ordered(list).map(b => [
      dateOf(b.ts) + '.' + new Date(b.ts * 1000).getFullYear(), timeOf(b.ts), b.league, b.home, b.away,
      b.tab === 'dry' ? b.team : (b.sides || []).map(sd => (sd === 'home' ? b.home : b.away)).join(' + '),
      b.n, b.low ? b.low.home : '', b.low ? b.low.away : '', MK.get(b.key).label, num(b.line), num(b.odds), num(b.odds0), num(b.p), num(b.p0), num(b.xg),
      b.top ? 'так' : '', b.res ? RES[b.res] : 'очікує', b.res ? num(Math.round(pOf(b) * 100) / 100) : '', b.v ?? '', b.sc || '', b.ft || '', b.early ? 'так' : '', b.note || '',
    ]);
    const text = '﻿' + [head, ...rows].map(r => r.map(x => { const s = String(x ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `football-radar-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function renderStat(key) {
    const st = STATS.find(x => x.key === key);
    if (!st) { location.hash = '#/stats'; return; }
    setHeader(`Статистика · ${st.title.replace('★ ', '')}`, 'stats');
    const list = allBets().filter(st.test);
    const s = summaryOf(list);
    const now = nowS();
    const goingOn = list.filter(b => !b.res && b.ts <= now).sort((a, b) => a.ts - b.ts);
    const waiting = list.filter(b => !b.res && b.ts > now).sort((a, b) => a.ts - b.ts);
    const done = list.filter(b => b.res).sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));

    const match = b => {
      const hl = sd => (b.tab === 'dry' ? b.side === sd : (b.sides || []).includes(sd));
      const t = (sd, name) => (hl(sd) ? `<span class="dry">${esc(name)}</span>` : esc(name));
      return `${t('home', b.home)} – ${t('away', b.away)}`;
    };
    const series = b => (b.tab === 'dry' ? `${seriesTxt(b.n, b.capped)} без гола` : `серія ТМ1.5 ${b.low ? `${b.low.home}·${b.low.away}` : b.n}`);
    const liveTxt = b => {
      const e = state.live.get(b.ev);
      const inPlay = e && e.state === 'in';
      const clock = inPlay ? e.clock : b.live && b.live.clock;
      const v = inPlay ? engine.valueOf(b.key, b.side, e) : b.live ? b.live.v : null;
      const sc = inPlay ? `${e.home.score}:${e.away.score}` : b.live && b.live.sc;
      return `<small class="livel">${clock ? `● ${esc(clock)}` : 'іде / розрахунок'}${sc ? ` · ${esc(sc)}` : ''}${v != null ? ` · треба ${need(b.line)}` : ''}</small>`;
    };
    const resCell = b => {
      if (!b.res) return b.ts > now ? '<td><small>очікує</small></td>' : `<td>${liveTxt(b)}</td>`;
      const score = b.sc ? `рахунок ${esc(b.sc)}` : '';
      const fin = b.ft && b.ft !== b.sc ? ` · фінал ${esc(b.ft)}` : '';
      return `<td class="${b.res === 'win' ? 'ok' : b.res === 'loss' ? 'bad' : ''} res">${RES_ICON[b.res]} ${b.res === 'void' ? '0 грн' : uah(pOf(b))}
        <small>${score}${fin}</small>${b.early ? `<small class="early">${esc(b.note || 'достроково')}${b.prov ? ' · чекає підтвердження' : ''}</small>` : b.note ? `<small>${esc(b.note)}</small>` : ''}</td>`;
    };
    const betRow = b => `<tr><td class="m"><b class="t">${dateOf(b.ts)} ${timeOf(b.ts)}</b> ${match(b)}
        <small>${esc(b.league)} · ${series(b)}</small></td>
      <td><b>${b.top ? '<span class="star">★</span> ' : ''}${MK.get(b.key).label}</b><small>кф ${k2(b.odds)}${b.odds0 && b.odds0 !== b.odds ? ` (був ${k2(b.odds0)})` : ''} · ${pct(b.p)}</small></td>
      ${resCell(b)}</tr>`;
    const betTable = (title, l) => (l.length ? `<section class="card"><h3>${title} · ${l.length}</h3><div class="tw"><table class="grid bets">
        <thead><tr><th>Матч</th><th>Ставка</th><th>Результат</th></tr></thead><tbody>${l.map(betRow).join('')}</tbody></table></div></section>` : '');

    const markets = engine.MARKETS.filter(m => list.some(b => b.key === m.key));
    const nEdges = key === 'low' ? [3, 4, 5, 6, 99] : [2, 3, 4, 5, 6, 99];
    const nVal = b => (b.tab === 'dry' ? b.n : b.n);
    const leagues = new Map();
    for (const b of list) { if (!leagues.has(b.league)) leagues.set(b.league, []); leagues.get(b.league).push(b); }
    const topLeagues = [...leagues].filter(([, l]) => l.some(b => b.res)).sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([label, l]) => ({ label, list: l }));

    $view.innerHTML = `<p class="back"><a href="#/stats">← Усі статистики</a> <button class="btn" id="csv">⬇ CSV для аналізу</button></p>
      <p class="summary">${esc(st.what)}</p>
      <div class="kpis six">
        <div><b class="${cls(s.profit)}">${money(s.balance)}</b><span>баланс з ${money(CFG.BANK)}</span></div>
        <div><b class="${cls(s.profit)}">${s.n ? uah(s.profit) : '—'}</b><span>прибуток · ROI ${roiTxt(s.roi)}</span></div>
        <div><b>${s.n}</b><span>${s.w}/${s.l}/${s.v} · чекають ${s.pending}</span></div>
        <div><b>${s.hit != null ? pct(s.hit) : '—'}</b><span>влучність · очік. ${pct(s.exp)}</span></div>
        <div><b>${k2(s.odds)}</b><span>сер. кф · достроково ${s.early}</span></div>
        <div><b class="${s.dd ? 'bad' : ''}">${s.dd ? `−${money(s.dd)}` : '—'}</b><span>макс. просідання · програшів поспіль ${s.maxLose}</span></div>
      </div>
      ${balanceChart(list)}
      ${betTable('<span class="live">●</span> Ідуть зараз', goingOn)}
      ${breakdown('За ринком', markets.map(m => ({ label: m.label, list: list.filter(b => b.key === m.key) })))}
      ${breakdown(key === 'low' ? 'За серією (матчів поспіль ≤ 1 гола)' : key === 'dry' ? 'За серією (матчів без гола)' : 'За вкладкою', key === 'top'
        ? [{ label: 'Засуха', list: list.filter(b => b.tab === 'dry') }, { label: 'Тотали', list: list.filter(b => b.tab === 'low') }]
        : bucket(list, nVal, nEdges, (lo, hi) => (hi > 50 ? `${lo}+` : String(lo))))}
      ${breakdown('За ймовірністю', bucket(list, b => b.p, [0, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01], (lo, hi) => (lo === 0 ? `до ${hi * 100}%` : hi > 1 ? `${lo * 100}%+` : `${Math.round(lo * 100)}–${Math.round(hi * 100) - 1}%`)))}
      ${breakdown('За кф', bucket(list, b => b.odds, [1, 1.3, 1.5, 1.8, 2.2, 3, 99], (lo, hi) => (lo === 1 ? `до ${k2(hi)}` : hi > 50 ? `${k2(lo)}+` : `${k2(lo)}–${k2(hi - 0.01)}`)))}
      ${key === 'dry' ? breakdown('Команда без гола грає', [{ label: 'вдома', list: list.filter(b => b.side === 'home') }, { label: 'у гостях', list: list.filter(b => b.side === 'away') }]) : ''}
      ${breakdown('Як зайшли виграші', [{ label: 'достроково', list: list.filter(b => b.res === 'win' && b.early) }, { label: 'після матчу', list: list.filter(b => b.res === 'win' && !b.early) }])}
      ${breakdown('За турніром (до 15)', topLeagues)}
      ${betTable('Очікують', waiting)}
      ${betTable('Зіграні', done)}
      ${list.length ? hint('Рахунок — на момент розрахунку (для дострокових — у момент, коли ставка зайшла), фінал — після кінця матчу. «був» — перший кф, коли ставку записано. CSV відкривається в Excel чи Google Таблицях: усі поля для аналізу.') : hint('Ставок ще немає: сервер записує їх до початку матчів.')}`;
    const btn = document.getElementById('csv');
    if (btn) btn.addEventListener('click', () => csv(list, key));
  }

  // ---------- навігація ----------
  // Перемальовування зберігає відкриті блоки й прокрутку, щоб щохвилинне оновлення їх не скидало.
  let lastHash = null;
  function render() {
    const h = location.hash.slice(1) || '/';
    const open = h === lastHash ? [...$view.querySelectorAll('details')].map(d => d.open) : [];
    lastHash = h;
    route(h);
    $view.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
  }
  function route(h) {
    if (h.startsWith('/stats/')) return renderStat(h.slice(7));
    if (h.startsWith('/stats')) return renderStats();
    if (h.startsWith('/low')) return renderLow();
    return renderDry();
  }

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  document.getElementById('refresh').addEventListener('click', async () => {
    $upd.textContent = 'оновлення…';
    await load();
    await pollLive();
    render();
  });
  // Автооновлення журналу, поки додаток відкритий.
  setInterval(() => { if (!document.hidden) load(); }, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load().then(live); });
  const live = async () => { if (await pollLive()) render(); };
  setInterval(() => { if (!document.hidden) live(); }, 60 * 1000);

  load().then(live);
  render();
})();
