// Інтерфейс «Футбол Радар». Рекомендації й статистика — із серверного журналу (tools/record.js, оновлюється
// приблизно кожні 10 хв), тож однакові на всіх пристроях. Якщо журнал давно не оновлювався або недоступний,
// рекомендації рахуються прямо на пристрої тим самим кодом (js/engine.js) з даних ESPN і VBET.
(() => {
  const { CFG, engine } = FP;
  const MK = engine.MARKET;
  const STALE = 40 * 60;
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $upd = document.getElementById('upd');
  const state = { journal: null, local: null, localBusy: null, loading: null, progress: '' };

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
  const dayTitle = ts => {
    const o = Math.round((dayStart(ts) - dayStart(nowS())) / 86400);
    const d = new Date(ts * 1000);
    return `${o === 0 ? 'Сьогодні' : o === 1 ? 'Завтра' : o === 2 ? 'Післязавтра' : WD[d.getDay()]}, ${dateOf(ts)}`;
  };
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
  const league = slug => FP.LEAGUE_BY_SLUG.get(slug) || { short: '', country: '', name: '' };
  const pClass = p => (p == null ? '' : p >= 0.6 ? 'hi' : p >= 0.45 ? 'mid' : 'lo');
  const lineTxt = l => (l == null ? '' : String(l));

  // ---------- дані ----------
  async function fetchJournal() {
    try {
      const res = await fetch(`${CFG.JOURNAL}?t=${Date.now()}`, { cache: 'no-store' });
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

  // Знімок рекомендацій: свіжіший із серверного та порахованого на пристрої.
  const snapshot = () => {
    const s = state.journal && state.journal.snapshot;
    if (state.local && (!s || state.local.at > s.at)) return state.local;
    return s || null;
  };
  const stale = () => { const s = snapshot(); return !s || nowS() - s.at > STALE; };

  async function computeLocal() {
    if (state.localBusy) return state.localBusy;
    state.localBusy = (async () => {
      try {
        const { seasons, errors } = await FP.api.allSeasons(false, (d, n) => { state.progress = `Рахую на пристрої: турніри ${d} з ${n}…`; paintProgress(); });
        state.progress = 'Рахую на пристрої: кф VBET…'; paintProgress();
        await FP.vbet.load(true);
        const res = engine.analyze(seasons, FP.vbet.book);
        const vb = FP.vbet.status();
        state.local = { ...res, errors, vbet: { games: vb.games, error: vb.error }, local: true };
      } catch (e) {
        state.progress = `Не вдалося порахувати: ${e.message}`;
      } finally {
        state.localBusy = null;
        if (state.local) state.progress = '';
      }
    })();
    return state.localBusy;
  }

  function load(force) {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      await FP.store.ready;
      if (!state.journal) state.journal = (FP.store.get('journal') || {}).version === CFG.VERSION ? FP.store.get('journal') : null;
      if (state.journal) render();
      state.journal = (await fetchJournal()) || state.journal;
      render();
      if (stale() || force === 'local') { await computeLocal(); render(); }
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // ---------- ставки й паралельні статистики ----------
  // Усі ставки журналу; у режимі «на пристрої» — ще й нові рекомендації, яких сервер не записав.
  function allBets() {
    const j = state.journal ? Object.values(state.journal.bets) : [];
    const ids = new Set(j.map(b => b.id));
    const extra = state.local ? state.local.bets.filter(b => !ids.has(b.id) && b.ts > nowS() && b.ts >= CFG.STATS_FROM).map(b => ({ ...b, res: null, local: true })) : [];
    return j.concat(extra);
  }
  function byMarket() {
    const out = new Map(engine.MARKETS.map(m => [m.key, []]));
    for (const b of allBets()) if (out.has(b.key) && b.ts >= CFG.STATS_FROM) out.get(b.key).push(b);
    return out;
  }
  function streamIndex() {
    const idx = new Map();
    for (const list of byMarket().values()) for (const s of engine.streams(list)) for (const b of s.bets) idx.set(b.id, s.no);
    return idx;
  }

  // ---------- оболонка ----------
  function setHeader(title, tab) {
    $title.textContent = title;
    document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
    const s = snapshot();
    $upd.textContent = s ? `${s.local ? 'на пристрої' : 'сервер'} · ${ago(s.at)}` : '';
    $upd.className = `upd ${s && nowS() - s.at > STALE ? 'old' : ''}`;
  }
  function paintProgress() {
    const $p = document.getElementById('progress');
    if ($p) $p.textContent = state.progress;
  }
  const banner = () => {
    const s = snapshot();
    if (state.localBusy) return `<div class="banner" id="progress">${esc(state.progress || 'Рахую на пристрої…')}</div>`;
    if (!s) return '';
    const notes = [];
    if (nowS() - s.at > STALE) notes.push(`Рекомендації оновлено ${ago(s.at)}.`);
    if (s.vbet && s.vbet.error) notes.push(`VBET недоступний (${esc(s.vbet.error)}).`);
    if (s.errors) notes.push(`Не завантажено турнірів: ${s.errors}.`);
    return notes.length ? `<div class="banner warn">${notes.join(' ')}</div>` : '';
  };
  const noData = () => `<div class="empty">${state.loading || state.localBusy ? 'Завантаження…' : 'Немає даних. Перевірте інтернет і натисніть «Оновити».'}</div>`;

  // Рядки рекомендацій одного типу на матчі, що ще не почались, по днях.
  const upcomingRows = type => (snapshot() ? snapshot().rows : []).filter(r => r.type === type && r.ev.ts > nowS()).sort((a, b) => a.ev.ts - b.ev.ts || (a.ev.id < b.ev.id ? -1 : 1));
  function byDay(rows) {
    const days = new Map();
    for (const r of rows) { const k = dayStart(r.ev.ts); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
    return [...days.values()];
  }

  // Клітинка ставки: кф VBET, ймовірність, номер статистики.
  function cellHtml(c, idx, top = '') {
    if (!c || c.odds == null) return `<td class="c none">${top}<span>немає<br>в лінії</span></td>`;
    if (!c.ok) return `<td class="c low">${top}<b>${k2(c.odds)}</b><small>${pct(c.p)}</small><em>кф &lt; ${CFG.MIN_ODDS}</em></td>`;
    const st = idx.get(c.id);
    return `<td class="c ok">${top}<b>${k2(c.odds)}</b><small class="${pClass(c.p)}">${pct(c.p)}</small>${st ? `<em>С${st}</em>` : ''}</td>`;
  }
  const tourn = r => `${esc(league(r.ev.slug).short)}`;
  const timeCell = r => `<b class="t">${timeOf(r.ev.ts)}</b>`;
  const hint = html => `<p class="hint">${html}</p>`;
  const legend = () => hint(`Кф — VBET, у рекомендаціях лише від ${CFG.MIN_ODDS}. Під кф — ймовірність виграшу (без урахування повернень): модель + ринок VBET. «С3» — ставка йде в статистику №3: матчі, що перетинаються в часі, рахуються в різних статистиках (кожна — ${money(CFG.BANK)}, ставка ${CFG.STAKE} грн).`);

  // Таблиця по днях з розділенням: є ставка з кф від 1.49 / немає.
  function dayTables(rows, head, rowHtml, hasBet) {
    const good = rows.filter(hasBet), rest = rows.filter(r => !hasBet(r));
    const table = list => `<div class="tw"><table class="grid">${head}<tbody>${list.map(rowHtml).join('')}</tbody></table></div>`;
    return `${good.length ? byDay(good).map(list => `<section class="card"><h3>${dayTitle(list[0].ev.ts)} · ${list.length}</h3>${table(list)}</section>`).join('')
      : '<div class="empty">Найближчі 3 дні немає матчів, що підходять, з кф VBET від 1.49.</div>'}
      ${rest.length ? `<details class="more card"><summary>Підходять, але кф VBET нижчий за ${CFG.MIN_ODDS} або ринку немає · ${rest.length}</summary>${table(rest)}</details>` : ''}`;
  }

  // ---------- Сухі ----------
  function renderDry() {
    setHeader('Сухі матчі', 'dry');
    const s = snapshot();
    if (!s) { $view.innerHTML = banner() + noData(); return; }
    const idx = streamIndex();
    const rows = upcomingRows('dry');
    const head = `<thead><tr><th>Матч</th>${engine.MARKETS.filter(m => m.tab === 'dry').map(m => `<th>${m.label}</th>`).join('')}</tr></thead>`;
    const rowHtml = r => {
      const dry = r.ev[r.side], opp = r.ev[r.side === 'home' ? 'away' : 'home'];
      return `<tr><td class="m">${timeCell(r)} <span class="dry">${esc(dry.short)}</span> <i class="tag">${r.n} без гола</i>
        <small>${r.side === 'home' ? 'вдома' : 'у гостях'} — ${esc(opp.short)} · ${tourn(r)}</small></td>
        ${r.bets.map(c => cellHtml(c, idx)).join('')}</tr>`;
    };
    const teams = s.dry.slice().sort((a, b) => b.n - a.n || (a.next ? a.next.ts : 9e10) - (b.next ? b.next.ts : 9e10));
    $view.innerHTML = `${banner()}
      <p class="summary">Не забивають ${CFG.DRY_MIN}+ матчі поспіль: <b>${teams.length}</b> ${plural(teams.length, 'команда', 'команди', 'команд')} · рекомендацій: <b>${rows.filter(r => r.bets.some(c => c.ok)).length}</b></p>
      ${dayTables(rows, head, rowHtml, r => r.bets.some(c => c.ok))}
      ${legend()}
      ${hint('ІТБ — індивідуальний тотал команди, що не забиває: ІТБ 0.5 — заб\'є хоча б 1; ІТБ 1 — 2+ голи виграш, рівно 1 — повернення; ІТБ 1.5 — 2+; ІТБ 2.5 — 3+.')}
      ${teamsTable('Усі серії без голів', teams, 'Без гола', t => `<b class="n">${t.n}</b><small>${t.lastGoal ? `гол ${dateOf(t.lastGoal)}` : 'без голів'}</small>`)}`;
  }

  // Таблиця поточних серій команд і їхній наступний матч.
  function teamsTable(title, list, col, valHtml) {
    if (!list.length) return '';
    return `<details class="more card"><summary>${title} · ${list.length}</summary><div class="tw"><table class="grid teams">
      <thead><tr><th>Команда</th><th>${col}</th><th>Наступний матч</th></tr></thead>
      <tbody>${list.map(t => {
        const nx = t.next;
        return `<tr><td class="m"><b>${esc(t.team.name)}</b><small>${esc(league(t.slug).country)} · ${esc(league(t.slug).name)}</small></td>
          <td>${valHtml(t)}</td>
          <td class="m">${nx ? `${nx.home ? 'вдома' : 'у гостях'} — ${esc(nx.vs.short)}<small>${dateOf(nx.ts)} ${timeOf(nx.ts)} · ${esc(league(nx.slug).short)}${nx.state === 'in' ? ' · іде' : nx.line ? ' · є в лінії VBET' : ''}</small>` : '<small>немає в розкладі</small>'}</td></tr>`;
      }).join('')}</tbody></table></div></details>`;
  }

  // ---------- Тотали ----------
  function renderTot() {
    setHeader('Тотали', 'tot');
    const s = snapshot();
    if (!s) { $view.innerHTML = banner() + noData(); return; }
    const idx = streamIndex();
    const rows = upcomingRows('tot');
    const head = '<thead><tr><th>Матч</th><th>Без ТБ 2.5 поспіль</th><th>ТБ 2.5</th></tr></thead>';
    const team = (r, sd) => {
      const q = r.sides.includes(sd);
      return `<span class="${q ? 'dry' : ''}">${esc(r.ev[sd].short)}</span>`;
    };
    const rowHtml = r => `<tr><td class="m">${timeCell(r)} ${team(r, 'home')} – ${team(r, 'away')}
        <small>${tourn(r)}${r.sides.length === 2 ? ' · <i class="tag both">обидві</i>' : ''}</small></td>
      <td class="streaks"><span class="${r.sides.includes('home') ? 'q' : ''}">${r.under.home}</span> · <span class="${r.sides.includes('away') ? 'q' : ''}">${r.under.away}</span></td>
      ${cellHtml(r.bets[0], idx)}</tr>`;
    const teams = s.under.slice().sort((a, b) => b.n - a.n || (a.next ? a.next.ts : 9e10) - (b.next ? b.next.ts : 9e10));
    $view.innerHTML = `${banner()}
      <p class="summary">Команд без ТБ 2.5 у ${CFG.UNDER_MIN}+ матчах поспіль: <b>${teams.length}</b> · рекомендацій: <b>${rows.filter(r => r.bets[0].ok).length}</b></p>
      ${dayTables(rows, head, rowHtml, r => r.bets[0].ok)}
      ${legend()}
      ${hint(`Рекомендація — ТБ 2.5 (3+ голи в матчі) для матчу команди, у ${CFG.UNDER_MIN}+ останніх матчах якої поспіль було не більше 2 голів (рахується загальний тотал матчу, не індивідуальний). Виділено команди, що підходять; «обидві» — так у обох, це окрема статистика. Числа — скільки матчів поспіль без ТБ 2.5 у господарів · гостей.`)}
      ${teamsTable('Усі серії без ТБ 2.5', teams, 'Матчів', t => `<b class="n">${t.n}</b>`)}`;
  }

  // ---------- Картки й кутові ----------
  function renderCards() {
    setHeader('Картки й кутові', 'card');
    const s = snapshot();
    if (!s) { $view.innerHTML = banner() + noData(); return; }
    const idx = streamIndex();
    const rows = upcomingRows('card');
    const CARD = engine.MARKETS.filter(m => m.tab === 'card');
    const head = `<thead><tr><th>Матч</th>${CARD.map(m => `<th>${m.label}</th>`).join('')}</tr></thead>`;
    const val = (g, mk) => {
      const v = g[mk.field];
      return `<span class="${v != null && v <= mk.max ? 'q' : ''}">${v == null ? '?' : v}</span>`;
    };
    const critHtml = r => ['home', 'away'].filter(sd => r.crit[sd]).map(sd => {
      const l = r.crit[sd];
      return `<span class="crit">${esc(r.ev[sd].short)}: ${CARD.map(mk => `${mk.key === 'c' ? 'кут' : mk.key === 'y' ? 'ЖК' : '1т'} ${val(l[0], mk)}·${val(l[1], mk)}`).join(' ')}</span>`;
    }).join('');
    const rowHtml = r => {
      const by = new Map(r.bets.map(b => [b.key, b]));
      return `<tr><td class="m">${timeCell(r)} ${esc(r.ev.home.short)} – ${esc(r.ev.away.short)}<small>${tourn(r)}</small>${critHtml(r)}</td>
        ${CARD.map(mk => (by.has(mk.key) ? cellHtml(by.get(mk.key), idx, by.get(mk.key).line != null ? `<span class="ln">ТБ ${lineTxt(by.get(mk.key).line)}</span>` : '') : '<td class="c skip">·</td>')).join('')}</tr>`;
    };
    $view.innerHTML = `${banner()}
      <p class="summary">Команд, що підходять: <b>${s.low.length}</b> · матчів з рекомендацією: <b>${rows.filter(r => r.bets.some(c => c.ok)).length}</b></p>
      ${dayTables(rows, head, rowHtml, r => r.bets.some(c => c.ok))}
      ${legend()}
      ${hint(`Рекомендація — ТБ тоталу матчу, якщо хоча б одна команда в кожному з 2 останніх матчів: <b>ЖК 1-й тайм</b> — не отримала жодної жовтої в 1-му таймі; <b>ЖК матч</b> — отримала не більше ${CFG.Y_MAX} жовтої; <b>кутові</b> — подала не більше ${CFG.C_MAX} кутових. Лінія — найімовірніша з кф VBET від ${CFG.MIN_ODDS}; ціла лінія (ТБ 3, ТБ 9) — рівно стільки = повернення. Під матчем — значення команд у 2 останніх матчах (старший·свіжіший), виділено ті, що підходять. Картки — лише основний час.`)}`;
  }

  // ---------- Статистика ----------
  const RES = { win: 'виграш', loss: 'програш', void: 'повернення' };
  const ICON = { win: '<i class="ok">✓</i>', loss: '<i class="bad">✗</i>', void: '<i class="vd">↺</i>' };
  function summaryOf(list) {
    const done = list.filter(b => b.res), dec = done.filter(b => b.res !== 'void');
    const w = done.filter(b => b.res === 'win').length, l = done.filter(b => b.res === 'loss').length, v = done.length - w - l;
    const profit = done.reduce((s, b) => s + (b.profit ?? engine.profit(b)), 0);
    return {
      n: done.length, w, l, v, profit, pending: list.length - done.length,
      hit: w + l ? w / (w + l) : null,
      exp: dec.length ? dec.reduce((s, b) => s + b.p, 0) / dec.length : null,
      odds: done.length ? done.reduce((s, b) => s + b.odds, 0) / done.length : null,
      roi: done.length ? profit / (done.length * CFG.STAKE) : null,
    };
  }
  const TABS = [['dry', 'Сухі матчі'], ['tot', 'Тотали'], ['card', 'Картки й кутові']];

  function renderStats() {
    setHeader('Статистика', 'stats');
    const groups = byMarket();
    const row = m => {
      const list = groups.get(m.key), s = summaryOf(list), st = engine.streams(list);
      return `<tr data-go="#/stats/${m.key}"><td class="m"><b>${esc(m.label)}</b><small>${st.length} ${plural(st.length, 'статистика', 'статистики', 'статистик')}${s.pending ? ` · очікують ${s.pending}` : ''}</small></td>
        <td>${s.n ? `${s.w}/${s.l}/${s.v}` : '—'}</td>
        <td>${s.hit != null ? `<b>${pct(s.hit)}</b><small>очік. ${pct(s.exp)}</small>` : '—'}</td>
        <td class="${s.profit > 0 ? 'ok' : s.profit < 0 ? 'bad' : ''}">${s.n ? `${uah(s.profit)}<small>ROI ${Math.round(s.roi * 100)}%</small>` : '—'}</td></tr>`;
    };
    const total = summaryOf([...groups.values()].flat());
    $view.innerHTML = `${banner()}
      <p class="summary">Облік з ${dateOf(CFG.STATS_FROM)} · кожна статистика — банк <b>${money(CFG.BANK)}</b>, ставка <b>${CFG.STAKE} грн</b> на матч, кф VBET до початку матчу</p>
      <div class="kpis">
        <div><b>${total.n}</b><span>ставок зіграно<br>очікують ${total.pending}</span></div>
        <div><b>${total.hit != null ? pct(total.hit) : '—'}</b><span>влучність<br>очікувана ${pct(total.exp)}</span></div>
        <div><b class="${total.profit > 0 ? 'ok' : total.profit < 0 ? 'bad' : ''}">${total.n ? uah(total.profit) : '—'}</b><span>разом<br>ROI ${total.roi != null ? Math.round(total.roi * 100) + '%' : '—'}</span></div>
      </div>
      ${TABS.map(([tab, title]) => `<section class="card"><h3>${title}</h3><div class="tw"><table class="grid stats">
        <thead><tr><th>Ринок</th><th>В/П/Пов</th><th>Влучність</th><th>Прибуток</th></tr></thead>
        <tbody>${engine.MARKETS.filter(m => m.tab === tab).map(row).join('')}</tbody></table></div></section>`).join('')}
      ${hint('Натисніть на ринок — паралельні статистики з балансами й усі ставки. Матчі, що починаються ближче ніж за 2 год один від одного, перетинаються в часі й ніколи не потрапляють в одну статистику: ставка йде в першу статистику, де попередній матч уже закінчився, або відкриває нову. В/П/Пов — виграно / програно / повернення.')}`;
  }

  function profitChart(list) {
    const done = list.filter(b => b.res).sort((a, b) => a.ts - b.ts);
    if (done.length < 2) return '';
    let cum = 0;
    const pts = [0, ...done.map(b => (cum += b.profit ?? engine.profit(b)))];
    const W = 300, H = 90, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const x = i => (i / (pts.length - 1)) * W, y = v => H - ((v - lo) / span) * H;
    const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Прибуток наростаючим підсумком">
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/><path d="${path}" class="${cum >= 0 ? 'up' : 'down'}"/></svg>
      <div class="chart-axis"><span>${dateOf(done[0].ts)}</span><span>прибуток усіх статистик: ${uah(cum)}</span><span>${dateOf(done[done.length - 1].ts)}</span></div></div>`;
  }

  function renderStat(key) {
    const m = MK.get(key);
    if (!m) { location.hash = '#/stats'; return; }
    setHeader(m.label, 'stats');
    const list = byMarket().get(key);
    const s = summaryOf(list), st = engine.streams(list);
    const no = new Map();
    for (const x of st) for (const b of x.bets) no.set(b.id, x.no);
    const match = b => {
      const h = esc(b.home), a = esc(b.away);
      return b.side === 'home' ? `<span class="dry">${h}</span> – ${a}` : b.side === 'away' ? `${h} – <span class="dry">${a}</span>` : `${h} – ${a}`;
    };
    const bets = list.slice().sort((a, b) => b.ts - a.ts);
    $view.innerHTML = `<p class="back"><a href="#/stats">← Усі ринки</a></p>
      <div class="kpis">
        <div><b>${s.n}</b><span>зіграно<br>${s.w}/${s.l}/${s.v} · очікують ${s.pending}</span></div>
        <div><b>${s.hit != null ? pct(s.hit) : '—'}</b><span>влучність<br>очікувана ${pct(s.exp)}</span></div>
        <div><b class="${s.profit > 0 ? 'ok' : s.profit < 0 ? 'bad' : ''}">${s.n ? uah(s.profit) : '—'}</b><span>разом · сер. кф ${k2(s.odds)}<br>ROI ${s.roi != null ? Math.round(s.roi * 100) + '%' : '—'}</span></div>
      </div>
      ${profitChart(list)}
      <section class="card"><h3>Статистики · ${st.length}</h3>${st.length ? `<div class="tw"><table class="grid stats">
        <thead><tr><th>№</th><th>Ставок</th><th>В/П/Пов</th><th>Баланс</th></tr></thead>
        <tbody>${st.map(x => `<tr><td><b>С${x.no}</b></td><td>${x.bets.length}${x.pending ? `<small>очікує ${x.pending}</small>` : ''}</td><td>${x.w}/${x.l}/${x.v}</td>
          <td class="${x.profit > 0 ? 'ok' : x.profit < 0 ? 'bad' : ''}"><b>${money(x.balance)}</b><small>${uah(x.profit)}</small></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Ставок ще немає.</p>'}
        <p class="hint">Кожна статистика стартує з ${money(CFG.BANK)}; ставка ${CFG.STAKE} грн на кожен матч. Матчі в одній статистиці не перетинаються в часі.</p></section>
      ${bets.length ? `<section class="card"><h3>Ставки · ${bets.length}</h3><div class="tw"><table class="grid bets">
        <thead><tr><th>Матч</th><th>Ставка</th><th>Результат</th></tr></thead>
        <tbody>${bets.map(b => `<tr><td class="m"><b class="t">${dateOf(b.ts)} ${timeOf(b.ts)}</b> ${match(b)}<small>${esc(league(b.slug).short)} · С${no.get(b.id) || '?'}${b.n ? ` · без гола ${b.n}` : ''}</small></td>
          <td>${m.tab === 'card' ? `ТБ ${lineTxt(b.line)} · ` : ''}<b>${k2(b.odds)}</b><small>${pct(b.p)}</small></td>
          <td class="${b.res === 'win' ? 'ok' : b.res === 'loss' ? 'bad' : ''}">${b.res ? `${ICON[b.res]} ${b.res === 'void' ? '0 грн' : uah(b.profit ?? engine.profit(b))}<small>${b.v != null ? `факт ${b.v}` : esc(b.note || '')}</small>` : `<small>${b.ts > nowS() ? 'очікує' : 'іде / розрахунок'}</small>`}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
  }

  // ---------- навігація ----------
  function render() {
    const h = location.hash.slice(1) || '/';
    if (h.startsWith('/stats/')) return renderStat(h.slice(7));
    if (h.startsWith('/stats')) return renderStats();
    if (h.startsWith('/tot')) return renderTot();
    if (h.startsWith('/card')) return renderCards();
    return renderDry();
  }

  $view.addEventListener('click', e => {
    const tr = e.target.closest('[data-go]');
    if (tr) location.hash = tr.dataset.go;
  });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  document.getElementById('refresh').addEventListener('click', async () => {
    $upd.textContent = 'оновлення…';
    await load(stale() ? 'local' : false);
    render();
  });
  // Автооновлення журналу, поки додаток відкритий.
  setInterval(() => { if (!document.hidden) load(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // Прибирання слідів попередніх додатків на цьому сайті (той самий домен github.io).
  (async () => {
    try { for (const r of await navigator.serviceWorker.getRegistrations()) if (/\/football-predictor\//.test(r.scope)) r.unregister(); } catch {}
    try { for (const k of await caches.keys()) if (/^fp-/.test(k)) caches.delete(k); } catch {}
    try { indexedDB.deleteDatabase('fp-cache'); } catch {}
    try { Object.keys(localStorage).filter(k => /^(fp[_:-]|fpe:|fpc:)/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {}
  })();

  load();
  render();
})();
