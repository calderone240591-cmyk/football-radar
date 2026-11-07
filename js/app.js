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
  const state = { journal: null, local: null, localBusy: null, loading: null, progress: '', live: new Map(), liveBusy: null };

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

  // Перевага ставки: ймовірність × кф − 1. ≥ 0 — за моделлю ставка не в мінусі (★, золотий).
  // У кожному матчі варіант з найбільшою перевагою — найкращий (зелена рамка).
  const edgeOf = c => (c && c.ok && c.p != null ? c.p * c.odds - 1 : null);
  let best = new Set();
  function markBest(rows) {
    best = new Set();
    for (const r of rows) {
      const ok = r.bets.filter(c => c.ok);
      if (ok.length) best.add(ok.reduce((a, b) => (edgeOf(b) > edgeOf(a) ? b : a)).id);
    }
  }
  const betName = (r, c) => (r.type === 'card' ? `${MK.get(c.key).label} ТБ ${lineTxt(c.line)}` : r.type === 'tot' ? 'ТБ 2.5' : `${esc(r.ev[r.side].short)} ${MK.get(c.key).label}`);

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

  // Знімок рекомендацій: свіжіший із серверного та порахованого на пристрої. Пораховане на пристрої
  // без лінії VBET (не відповів) не замінює серверний знімок — у ньому не було б жодної рекомендації.
  const snapshot = () => {
    const s = state.journal && state.journal.snapshot;
    const l = state.local;
    if (l && (!s || (l.at > s.at && !(l.vbet && l.vbet.error)))) return l;
    return s || null;
  };
  const stale = () => { const s = snapshot(); return !s || nowS() - s.at > STALE; };

  async function computeLocal() {
    if (state.localBusy) return state.localBusy;
    state.localBusy = (async () => {
      try {
        const { seasons, errors } = await FP.api.allSeasons(false, (d, n) => { state.progress = `Рахую на пристрої: турніри ${d} з ${n}…`; paintProgress(); });
        const pendingC1 = state.journal ? Object.values(state.journal.bets).filter(b => b.key === 'c1' && !b.res).map(b => b.ev) : [];
        await FP.api.addHalfCorners(engine.halfCornerNeeds(seasons, nowS(), pendingC1), (d, n) => { state.progress = `Рахую на пристрої: кутові 1-го тайму ${d} з ${n}…`; paintProgress(); });
        state.progress = 'Рахую на пристрої: кф VBET…'; paintProgress();
        await FP.vbet.load(true);
        const res = engine.analyze(seasons, FP.vbet.book);
        const prev = state.journal && state.journal.snapshot ? state.journal.snapshot.rows : [];
        res.rows = res.rows.concat(engine.liveRows(prev, seasons, nowS(), state.live));   // матчі, що вже йдуть
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
      if (stale() || force === 'local' || /[?&]local\b/.test(location.search)) { await computeLocal(); render(); }
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  // ---------- live-моніторинг ----------
  // Поки є матчі, що йдуть (рекомендація чи ставка без результату), раз на хвилину беремо з ESPN рахунок,
  // хвилину, кутові й картки. Ставка, що вже зайшла, одразу показується виграною — сервер підтвердить її
  // за кілька хвилин.
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
  // Поточний стан матчу: свіжий з ESPN на пристрої, інакше — із серверного знімка.
  const liveEv = (id, fallback) => {
    const e = state.live.get(id);
    if (!e) return fallback || null;
    if (fallback && e.home.c1 == null && fallback.home.c1 != null) return { ...e, home: { ...e.home, c1: fallback.home.c1 }, away: { ...e.away, c1: fallback.away.c1 } };
    return e;
  };
  const isStarted = r => r.ev.ts <= nowS();
  // Рядок рекомендації показується, поки матч не почався, або поки він іде.
  const rowVisible = r => {
    if (!isStarted(r)) return true;
    if (nowS() - r.ev.ts > 4 * 3600) return false;
    const e = liveEv(r.ev.id, r.live);
    return e ? e.state !== 'post' : nowS() - r.ev.ts < 2.5 * 3600;
  };

  // ---------- ставки й паралельні статистики ----------
  const journalBets = () => (state.journal ? Object.values(state.journal.bets) : []);
  // Усі ставки журналу; у режимі «на пристрої» — ще й нові рекомендації, яких сервер не записав.
  // Ставка без результату, що вже зайшла під час матчу (дані ESPN на пристрої), — виграна достроково.
  function allBets() {
    const j = journalBets().map(b => {
      if (b.res || b.ts > nowS()) return b;
      const e = state.live.get(b.ev);
      const s = e && e.state === 'in' ? engine.settle(b, e) : null;
      return s && s.res ? { ...b, res: s.res, v: s.v, note: s.note, early: true, prov: true } : b;
    });
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

  // Рядки рекомендацій одного типу: матчі, що йдуть, і ті, що ще не почались — за часом (сьогодні першим).
  const upcomingRows = type => (snapshot() ? snapshot().rows : []).filter(r => r.type === type && rowVisible(r)).sort((a, b) => a.ev.ts - b.ev.ts || (a.ev.id < b.ev.id ? -1 : 1));
  function byDay(rows) {
    const days = new Map();
    for (const r of rows) { const k = dayStart(r.ev.ts); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
    return [...days.values()];
  }

  // Результат ставки матчу, що йде: із журналу сервера, інакше — з поточних даних (зайшла достроково чи ще ні).
  function liveBet(c, r) {
    const jb = state.journal && state.journal.bets[c.id];
    const e = liveEv(r.ev.id, r.live);
    const v = e ? engine.valueOf(c.key, r.side, e) : null;
    if (jb && jb.res) return { res: jb.res, v: jb.v ?? v };
    const s = e ? engine.settle({ key: c.key, side: r.side, line: c.line }, e) : null;
    return { res: s && s.res !== 'cancel' ? s.res : null, v };
  }
  // Скільки треба для виграшу: ТБ 2.5 → 3+, ІТБ 1 → 2+.
  const need = line => `${Math.floor(line) + 1}+`;

  // Клітинка ставки: кф VBET, ймовірність, номер статистики; у матчі, що йде, — поточне значення і чи зайшла.
  function cellHtml(c, idx, top = '', r = null) {
    if (r && isStarted(r)) {
      if (!c || !c.ok) return `<td class="c skip">${top}·</td>`;
      const st = idx.get(c.id), x = liveBet(c, r);
      if (x.res === 'win') return `<td class="c win">${top}<b>✓</b><small>зайшла · ${x.v ?? ''}</small><em>кф ${k2(c.odds)}${st ? ` · С${st}` : ''}</em></td>`;
      if (x.res === 'loss') return `<td class="c lost">${top}<b>✗</b><small>${x.v ?? ''}</small><em>кф ${k2(c.odds)}</em></td>`;
      if (x.res === 'void') return `<td class="c">${top}<b>↺</b><small>повернення</small></td>`;
      return `<td class="c ok">${top}<b>${x.v ?? '?'}</b><small>треба ${need(c.line)}</small><em>кф ${k2(c.odds)}${st ? ` · С${st}` : ''}</em></td>`;
    }
    if (!c || c.odds == null) return `<td class="c none">${top}<span>немає<br>в лінії</span></td>`;
    if (!c.ok) return `<td class="c low">${top}<b>${k2(c.odds)}</b><small>${pct(c.p)}</small><em>кф &lt; ${CFG.MIN_ODDS}</em></td>`;
    const st = idx.get(c.id), e = edgeOf(c);
    return `<td class="c ok ${e >= 0 ? 'gold' : ''} ${best.has(c.id) ? 'best' : ''}">${top}<b>${k2(c.odds)}</b><small class="${pClass(c.p)}">${pct(c.p)}</small><em>${e >= 0 ? '<span class="star">★</span> ' : ''}${st ? `С${st}` : ''}</em></td>`;
  }

  // Топ-8 ставок вкладки за перевагою.
  function topPicks(rows, idx) {
    // 8 найкращих за перевагою, показані за часом матчу.
    const list = rows.flatMap(r => r.bets.filter(c => c.ok).map(c => ({ r, c }))).sort((a, b) => edgeOf(b.c) - edgeOf(a.c)).slice(0, 8)
      .sort((a, b) => a.r.ev.ts - b.r.ev.ts || edgeOf(b.c) - edgeOf(a.c));
    if (!list.length) return '';
    return `<section class="card top"><h3>★ Найкращі варіанти</h3><div class="tw"><table class="grid">
      <thead><tr><th>Матч · ставка</th><th>Кф</th><th>Перевага</th></tr></thead>
      <tbody>${list.map(({ r, c }) => {
        const e = edgeOf(c), st = idx.get(c.id);
        return `<tr class="${e >= 0 ? 'gold' : ''}"><td class="m"><b class="t">${dateOf(r.ev.ts)} ${timeOf(r.ev.ts)}</b> ${esc(r.ev.home.short)} – ${esc(r.ev.away.short)}
          <small><b class="pick">${betName(r, c)}</b> · ${tourn(r)}${st ? ` · С${st}` : ''}</small></td>
          <td><b>${k2(c.odds)}</b><small class="${pClass(c.p)}">${pct(c.p)}</small></td>
          <td class="${e >= 0 ? 'ok' : ''}">${e >= 0 ? '★ ' : ''}${e >= 0 ? '+' : '−'}${Math.abs(Math.round(e * 100))}%</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="hint">Перевага = ймовірність × кф − 1. ★ і золотий — перевага від 0%: за моделлю ставка не в мінусі. Від'ємна — букмекер закладає більше, ніж дає модель.</p></section>`;
  }
  const tourn = r => `${esc(league(r.ev.slug).short)}`;
  const timeCell = r => {
    if (!isStarted(r)) return `<b class="t">${timeOf(r.ev.ts)}</b>`;
    const e = liveEv(r.ev.id, r.live);
    return `<b class="t live">● ${esc(e && e.state === 'in' ? e.clock : 'почався')}</b>`;
  };
  // Рядок стану матчу, що йде: рахунок, кутові, жовті (1-й тайм у дужках).
  const liveLine = r => {
    if (!isStarted(r)) return '';
    const e = liveEv(r.ev.id, r.live);
    if (!e || e.state !== 'in') return '<small class="livel">чекаю дані матчу…</small>';
    const H = e.home, A = e.away, pair = (a, b) => (a == null || b == null ? '?' : `${a}:${b}`);
    return `<small class="livel"><b>${pair(H.score, A.score)}</b> · кут ${pair(H.c, A.c)}${H.c1 != null ? ` (1т ${pair(H.c1, A.c1)})` : ''} · ЖК ${pair(H.y, A.y)}</small>`;
  };
  const hint = html => `<p class="hint">${html}</p>`;
  const legend = () => hint(`Кф — VBET, у рекомендаціях лише від ${CFG.MIN_ODDS}. Під кф — ймовірність виграшу (без урахування повернень): модель + ринок VBET. <span class="lg best">рамка</span> — найкращий варіант у матчі, <span class="lg gold">★ золотий</span> — перевага від 0% (ймовірність × кф ≥ 1). «С3» — ставка йде в статистику №3: матчі, що перетинаються в часі, рахуються в різних статистиках (кожна — ${money(CFG.BANK)}, ставка ${CFG.STAKE} грн).`);

  // Таблиця по днях з розділенням: є ставка з кф від 1.49 / немає.
  function dayTables(rows, head, rowHtml, hasBet) {
    const live = rows.filter(r => isStarted(r) && hasBet(r));
    rows = rows.filter(r => !isStarted(r));
    markBest(rows);
    const good = rows.filter(hasBet), rest = rows.filter(r => !hasBet(r));
    const table = list => `<div class="tw"><table class="grid">${head}<tbody>${list.map(rowHtml).join('')}</tbody></table></div>`;
    return `${live.length ? `<section class="card livec"><h3><span class="live">●</span> Зараз ідуть · ${live.length}</h3>${table(live)}
        <p class="hint">Під матчем — рахунок, кутові (у дужках 1-й тайм) і жовті. У клітинці — скільки є зараз і скільки треба для виграшу; ✓ — ставка вже зайшла і пішла в статистику, не чекаючи кінця матчу. Оновлюється щохвилини, поки додаток відкритий.</p></section>` : ''}
      ${topPicks(good, streamIndex())}${good.length ? byDay(good).map(list => `<section class="card"><h3>${dayTitle(list[0].ev.ts)} · ${list.length}</h3>${table(list)}</section>`).join('')
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
        <small>${r.side === 'home' ? 'вдома' : 'у гостях'} — ${esc(opp.short)} · ${tourn(r)}</small>${liveLine(r)}</td>
        ${r.bets.map(c => cellHtml(c, idx, '', r)).join('')}</tr>`;
    };
    const teams = s.dry.slice().sort(byNext);
    $view.innerHTML = `${banner()}
      <p class="summary">Не забивають ${CFG.DRY_MIN}+ матчі поспіль: <b>${teams.length}</b> ${plural(teams.length, 'команда', 'команди', 'команд')} · рекомендацій: <b>${rows.filter(r => r.bets.some(c => c.ok)).length}</b></p>
      ${dayTables(rows, head, rowHtml, r => r.bets.some(c => c.ok))}
      ${legend()}
      ${hint('ІТБ — індивідуальний тотал команди, що не забиває: ІТБ 0.5 — заб\'є хоча б 1; ІТБ 1 — 2+ голи виграш, рівно 1 — повернення; ІТБ 1.5 — 2+; ІТБ 2.5 — 3+.')}
      ${teamsTable('Усі серії без голів', teams, 'Без гола', t => `<b class="n">${t.n}</b><small>${t.lastGoal ? `гол ${dateOf(t.lastGoal)}` : 'без голів'}</small>`)}`;
  }

  // Команди — за часом наступного матчу (найближчий першим), без матчу в розкладі — у кінці; далі довша серія.
  const byNext = (a, b) => (a.next ? a.next.ts : 9e10) - (b.next ? b.next.ts : 9e10) || b.n - a.n;

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
        <small>${tourn(r)}${r.sides.length === 2 ? ' · <i class="tag both">обидві</i>' : ''}</small>${liveLine(r)}</td>
      <td class="streaks"><span class="${r.sides.includes('home') ? 'q' : ''}">${r.under.home}</span> · <span class="${r.sides.includes('away') ? 'q' : ''}">${r.under.away}</span></td>
      ${cellHtml(r.bets[0], idx, '', r)}</tr>`;
    const teams = s.under.slice().sort(byNext);
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
    const SHORT = { y1: 'ЖК 1т', y: 'ЖК', c1: 'Кут 1т', c: 'Кут' };
    const head = `<thead><tr><th>Матч</th>${CARD.map(m => `<th title="${m.label}">${SHORT[m.key]}</th>`).join('')}</tr></thead>`;
    const val = (g, mk) => {
      const v = g[mk.field];
      return `<span class="${v != null && v <= mk.max ? 'q' : ''}">${v == null ? '?' : v}</span>`;
    };
    const critHtml = r => ['home', 'away'].filter(sd => r.crit[sd]).map(sd => {
      const l = r.crit[sd];
      const mks = CARD.filter(mk => mk.key !== 'c1' || FP.C1_COMPS.has(r.ev.slug));
      return `<span class="crit">${esc(r.ev[sd].short)}: ${mks.map(mk => `${SHORT[mk.key]} ${val(l[0], mk)}·${val(l[1], mk)}`).join(' · ')}</span>`;
    }).join('');
    const rowHtml = r => {
      const by = new Map(r.bets.map(b => [b.key, b]));
      return `<tr><td class="m">${timeCell(r)} ${esc(r.ev.home.short)} – ${esc(r.ev.away.short)}<small>${tourn(r)}</small>${isStarted(r) ? liveLine(r) : critHtml(r)}</td>
        ${CARD.map(mk => (by.has(mk.key) ? cellHtml(by.get(mk.key), idx, by.get(mk.key).line != null ? `<span class="ln">ТБ ${lineTxt(by.get(mk.key).line)}</span>` : '', r) : '<td class="c skip">·</td>')).join('')}</tr>`;
    };
    $view.innerHTML = `${banner()}
      <p class="summary">Команд, що підходять: <b>${s.low.length}</b> · матчів з рекомендацією: <b>${rows.filter(r => r.bets.some(c => c.ok)).length}</b></p>
      ${dayTables(rows, head, rowHtml, r => r.bets.some(c => c.ok))}
      ${legend()}
      ${hint(`Рекомендація — ТБ тоталу матчу, якщо хоча б одна команда в кожному з 2 останніх матчів: <b>ЖК 1-й тайм</b> — не отримала жодної жовтої в 1-му таймі; <b>ЖК матч</b> — отримала не більше ${CFG.Y_MAX} жовтої; <b>кутові 1-й тайм</b> — подала не більше ${CFG.C1_MAX} кутового в 1-му таймі (лише турніри, де ESPN веде текстовий коментар: АПЛ, Чемпіоншип, Ла Ліга, Серія A, Бундесліга, Ліга 1, Ередивізі, Португалія, Бразилія, Аргентина, Мексика, MLS, єврокубки); <b>кутові</b> — подала не більше ${CFG.C_MAX} кутових. Лінія — найімовірніша з кф VBET від ${CFG.MIN_ODDS}; ціла лінія (ТБ 3, ТБ 9) — рівно стільки = повернення. Під матчем — значення команд у 2 останніх матчах (старший·свіжіший), виділено ті, що підходять; «?» — даних немає. Колонки: ЖК 1т — жовті 1-го тайму, ЖК — жовті за матч, Кут 1т — кутові 1-го тайму, Кут — кутові за матч. Картки — лише основний час.`)}`;
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

  // Опис кожного ринку: коротко (у списку) і докладно (на сторінці ринку).
  const SERIES = 'Серія рахується за всіма матчами команди в 25 чемпіонатах і єврокубках (ЛЧ, ЛЄ, ЛК), з кінцем минулого сезону чемпіонату. Рекомендація — лише на її наступний матч у межах 3 днів.';
  const LAST2 = 'Беруться 2 останні зіграні матчі команди в будь-якому з 25 чемпіонатів чи єврокубків.';
  const ITB = (line, win) => ({
    short: `команда не забиває ${CFG.DRY_MIN}+ матчі → її ІТБ ${line}`,
    cond: `Команда не забила жодного гола в ${CFG.DRY_MIN} або більше матчах поспіль. ${SERIES}`,
    bet: `Індивідуальний тотал більше ${line} саме цієї команди (голи суперника не рахуються). ${win}`,
    settle: 'За голами команди в основний час (рахунок ESPN). Якщо матч дійшов до додаткового часу — повернення: рахунок 90 хв невідомий.',
  });
  const DESC = {
    d05: ITB(0.5, 'Виграш — команда заб\'є хоча б 1 гол.'),
    d1: ITB(1, 'Азійська лінія: 2+ голи — виграш, рівно 1 — повернення ставки, 0 — програш.'),
    d15: ITB(1.5, 'Виграш — команда заб\'є 2 і більше.'),
    d25: ITB(2.5, 'Виграш — команда заб\'є 3 і більше.'),
    t25o: {
      short: `лише одна команда без ТБ 2.5 у ${CFG.UNDER_MIN}+ матчах → ТБ 2.5`,
      cond: `Лише ОДНА з двох команд матчу має серію з ${CFG.UNDER_MIN} або більше матчів поспіль, у кожному з яких було не більше 2 голів на двох (загальний тотал матчу ≤ 2, тобто не зайшов ТБ 2.5; голи самої команди окремо не рахуються). У суперника такої серії немає. ${SERIES}`,
      bet: 'ТБ 2.5 — загальний тотал матчу: виграш, якщо обидві команди разом заб\'ють 3 і більше голи.',
      settle: 'За рахунком основного часу (ESPN). Додатковий час — повернення.',
    },
    t25b: {
      short: `обидві команди без ТБ 2.5 у ${CFG.UNDER_MIN}+ матчах → ТБ 2.5`,
      cond: `ОБИДВІ команди матчу мають серію з ${CFG.UNDER_MIN} або більше матчів поспіль, у кожному з яких було не більше 2 голів на двох (загальний тотал матчу ≤ 2). ${SERIES}`,
      bet: 'ТБ 2.5 — загальний тотал матчу: виграш, якщо обидві команди разом заб\'ють 3 і більше голи.',
      settle: 'За рахунком основного часу (ESPN). Додатковий час — повернення.',
    },
    y1: {
      short: 'команда без жовтих у 1-му таймі 2 матчі → ТБ ЖК 1-го тайму',
      cond: `Хоча б одна команда в кожному з 2 останніх матчів не отримала жодної жовтої картки в 1-му таймі. ${LAST2}`,
      bet: `ТБ жовтих карток 1-го тайму матчу (обидві команди разом). Лінія — найімовірніша з тих, де кф VBET від ${CFG.MIN_ODDS} (0.5, 1, 1.5…); на цілій лінії рівно стільки карток — повернення.`,
      settle: 'Жовті картки з хвилиною з протоколу матчу ESPN: 1-й тайм — до 45\' включно з доданим часом (45\'+2\').',
    },
    y: {
      short: `команда ≤ ${CFG.Y_MAX} жовтої 2 матчі → ТБ ЖК матчу`,
      cond: `Хоча б одна команда в кожному з 2 останніх матчів отримала не більше ${CFG.Y_MAX} жовтої картки. ${LAST2}`,
      bet: `ТБ жовтих карток матчу (обидві команди разом). Лінія — найімовірніша з кф VBET від ${CFG.MIN_ODDS}; на цілій лінії рівно стільки карток — повернення.`,
      settle: 'Жовті картки з протоколу матчу ESPN за основний час (до 90\'+), картки в додатковий час не рахуються.',
    },
    c1: {
      short: `команда ≤ ${CFG.C1_MAX} кутового в 1-му таймі 2 матчі → ТБ кутових 1-го тайму`,
      cond: `Хоча б одна команда в кожному з 2 останніх матчів подала не більше ${CFG.C1_MAX} кутового в 1-му таймі. ${LAST2} Лише турніри, де ESPN веде текстовий коментар матчу: АПЛ, Чемпіоншип, Ла Ліга, Серія A, Бундесліга, Ліга 1, Ередивізі, Португалія, Бразилія, Аргентина, Мексика, MLS, ЛЧ, ЛЄ, ЛК.`,
      bet: `ТБ кутових 1-го тайму матчу (обидві команди разом). Лінія — найімовірніша з кф VBET від ${CFG.MIN_ODDS}.`,
      settle: 'Кутові з текстового коментаря матчу ESPN (кожен кутовий — з командою й таймом). Рахується, лише коли в коментарі всі кутові матчу; інакше через 3 дні — повернення.',
    },
    c: {
      short: `команда ≤ ${CFG.C_MAX} кутових 2 матчі → ТБ кутових матчу`,
      cond: `Хоча б одна команда в кожному з 2 останніх матчів подала не більше ${CFG.C_MAX} кутових. ${LAST2}`,
      bet: `ТБ кутових матчу (обидві команди разом). Лінія — найімовірніша з кф VBET від ${CFG.MIN_ODDS}; на цілій лінії рівно стільки — повернення.`,
      settle: 'Кутові зі статистики матчу ESPN. Турніри, де ESPN не веде кутові (Австрія), не враховуються.',
    },
  };
  const PROB = {
    dry: 'Ймовірність: очікувані голи команди з моделі (рейтинги атаки й оборони за сезоном з урахуванням суперників і форми), підігнані під кф VBET на результат і тотал; далі розподіл Пуассона. Якщо VBET дає обидві сторони лінії ІТБ — 70% ринок (без маржі) + 30% модель.',
    tot: 'Ймовірність: очікувані голи обох команд з моделі, підігнані під кф VBET на результат і тотал (70% ринок + 30% модель), розподіл рахунків Пуассона з поправкою Діксона–Коулза.',
    card: 'Ймовірність: середні сезону обох команд (скільки отримують / подають і скільки дають суперникам), від\'ємний біноміальний розподіл; якщо VBET дає обидві сторони лінії — 70% ринок (без маржі) + 30% модель.',
  };
  const descCard = m => {
    const d = DESC[m.key];
    return `<section class="card desc"><h3>Що це за ставка</h3>
      <p><b>Умова.</b> ${d.cond}</p><p><b>Ставка.</b> ${d.bet}</p><p><b>Розрахунок.</b> ${d.settle}</p>
      <p><b>Кф.</b> Лише VBET (лінія vbet.ua), лише від ${CFG.MIN_ODDS}. Сервер записує ставку до початку матчу й оновлює кф до старту — у статистику йде останній кф перед матчем.</p>
      <p><b>Ймовірність.</b> ${PROB[m.tab]}</p>
      <p><b>Гроші.</b> ${CFG.STAKE} грн на кожен матч; виграш — +${CFG.STAKE} × (кф − 1), програш — −${CFG.STAKE}, повернення — 0.</p></section>`;
  };
  const sourcesCard = () => `<details class="more card"><summary>Звідки дані і як рахується</summary><div class="desc">
    <p><b>Матчі, рахунки, кутові, жовті картки</b> — ESPN (розклад і протоколи матчів 25 чемпіонатів і ЛЧ, ЛЄ, ЛК). Кутові 1-го тайму — з текстового коментаря ESPN.</p>
    <p><b>Кф</b> — лише VBET (vbet.ua), у рекомендації — лише від ${CFG.MIN_ODDS}. Сервер (GitHub, приблизно кожні 10 хв, працює без вашого ноутбука й телефона) записує кожну рекомендацію до початку матчу і після матчу розраховує її.</p>
    <p><b>Паралельні статистики.</b> Ставки одного ринку йдуть за часом початку матчів. Матчі, що починаються ближче ніж за 2 год один від одного, перетинаються в часі, тож не потрапляють в одну статистику: ставка йде в першу статистику, де попередній матч уже закінчився, або відкриває нову (С1, С2…). Кожна статистика — окремий банк ${money(CFG.BANK)}, ставка ${CFG.STAKE} грн.</p>
    <p><b>Влучність</b> — виграші / (виграші + програші), повернення не рахуються. <b>Очікувана</b> — середня ймовірність цих ставок до матчу: якщо фактична вища, модель недооцінює ринок. <b>ROI</b> — прибуток / (кількість ставок × ${CFG.STAKE} грн).</p></div></details>`;

  function renderStats() {
    setHeader('Статистика', 'stats');
    const groups = byMarket();
    const row = m => {
      const list = groups.get(m.key), s = summaryOf(list), st = engine.streams(list);
      return `<tr data-go="#/stats/${m.key}"><td class="m"><b>${esc(m.label)}</b><small class="what">${esc(DESC[m.key].short)}</small><small>${st.length} ${plural(st.length, 'статистика', 'статистики', 'статистик')}${s.pending ? ` · очікують ${s.pending}` : ''} · докладно ›</small></td>
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
      ${hint('Натисніть на ринок — опис ставки, паралельні статистики з балансами й усі ставки. В/П/Пов — виграно / програно / повернення.')}
      ${sourcesCard()}`;
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
    // Ідуть зараз і очікують — за часом (найближчий першим), зіграні — найсвіжіші першими.
    const now = nowS();
    const goingOn = list.filter(b => !b.res && b.ts <= now).sort((a, b) => a.ts - b.ts);
    const waiting = list.filter(b => !b.res && b.ts > now).sort((a, b) => a.ts - b.ts);
    const done = list.filter(b => b.res).sort((a, b) => b.ts - a.ts);
    const liveTxt = b => {
      const e = state.live.get(b.ev);
      const clock = e && e.state === 'in' ? e.clock : b.live && b.live.clock;
      const v = e && e.state === 'in' ? engine.valueOf(b.key, b.side, e) : b.live ? b.live.v : null;
      return `<small class="livel">${clock ? `● ${esc(clock)}` : 'іде / розрахунок'}${v != null ? ` · зараз ${v}, треба ${need(b.line)}` : ''}</small>`;
    };
    const betRow = b => `<tr><td class="m"><b class="t">${dateOf(b.ts)} ${timeOf(b.ts)}</b> ${match(b)}<small>${esc(league(b.slug).short)} · С${no.get(b.id) || '?'}${b.n ? ` · без гола ${b.n}` : ''}</small></td>
          <td>${m.tab === 'card' ? `ТБ ${lineTxt(b.line)} · ` : ''}<b>${k2(b.odds)}</b><small>${pct(b.p)}</small></td>
          <td class="${b.res === 'win' ? 'ok' : b.res === 'loss' ? 'bad' : ''}">${b.res ? `${ICON[b.res]} ${b.res === 'void' ? '0 грн' : uah(b.profit ?? engine.profit(b))}<small>${b.v != null ? `факт ${b.v}` : ''}${b.v != null && b.note ? ' · ' : ''}${esc(b.note || '')}</small>` : b.ts > now ? '<small>очікує</small>' : liveTxt(b)}</td></tr>`;
    const betTable = (title, l) => (l.length ? `<section class="card"><h3>${title} · ${l.length}</h3><div class="tw"><table class="grid bets">
        <thead><tr><th>Матч</th><th>Ставка</th><th>Результат</th></tr></thead><tbody>${l.map(betRow).join('')}</tbody></table></div></section>` : '');
    $view.innerHTML = `<p class="back"><a href="#/stats">← Усі ринки</a></p>
      <div class="kpis">
        <div><b>${s.n}</b><span>зіграно<br>${s.w}/${s.l}/${s.v} · очікують ${s.pending}</span></div>
        <div><b>${s.hit != null ? pct(s.hit) : '—'}</b><span>влучність<br>очікувана ${pct(s.exp)}</span></div>
        <div><b class="${s.profit > 0 ? 'ok' : s.profit < 0 ? 'bad' : ''}">${s.n ? uah(s.profit) : '—'}</b><span>разом · сер. кф ${k2(s.odds)}<br>ROI ${s.roi != null ? Math.round(s.roi * 100) + '%' : '—'}</span></div>
      </div>
      ${descCard(m)}
      ${profitChart(list)}
      <section class="card"><h3>Статистики · ${st.length}</h3>${st.length ? `<div class="tw"><table class="grid stats">
        <thead><tr><th>№</th><th>Ставок</th><th>В/П/Пов</th><th>Баланс</th></tr></thead>
        <tbody>${st.map(x => `<tr><td><b>С${x.no}</b></td><td>${x.bets.length}${x.pending ? `<small>очікує ${x.pending}</small>` : ''}</td><td>${x.w}/${x.l}/${x.v}</td>
          <td class="${x.profit > 0 ? 'ok' : x.profit < 0 ? 'bad' : ''}"><b>${money(x.balance)}</b><small>${uah(x.profit)}</small></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Ставок ще немає.</p>'}
        <p class="hint">Кожна статистика стартує з ${money(CFG.BANK)}; ставка ${CFG.STAKE} грн на кожен матч. Матчі в одній статистиці не перетинаються в часі.</p></section>
      ${betTable('<span class="live">●</span> Ідуть зараз', goingOn)}
      ${betTable('Очікують', waiting)}
      ${betTable('Зіграні', done)}
      ${list.length ? hint('Ставка, що зайшла під час матчу (наприклад, третій гол на ТБ 2.5), одразу йде в статистику як виграна — «достроково» з хвилиною.') : ''}`;
  }

  // ---------- навігація ----------
  // Перемальовування зберігає відкриті блоки «докладно», щоб щохвилинне оновлення не згортало їх.
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
    await pollLive();
    render();
  });
  // Автооновлення журналу, поки додаток відкритий.
  setInterval(() => { if (!document.hidden) load(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load().then(live); });
  // Live-моніторинг матчів, що йдуть: щохвилини, поки додаток відкритий.
  const live = async () => { if (await pollLive()) render(); };
  setInterval(() => { if (!document.hidden) live(); }, 60 * 1000);

  // Прибирання слідів попередніх додатків на цьому сайті (той самий домен github.io).
  (async () => {
    try { for (const r of await navigator.serviceWorker.getRegistrations()) if (/\/football-predictor\//.test(r.scope)) r.unregister(); } catch {}
    try { for (const k of await caches.keys()) if (/^fp-/.test(k)) caches.delete(k); } catch {}
    try { indexedDB.deleteDatabase('fp-cache'); } catch {}
    try { Object.keys(localStorage).filter(k => /^(fp[_:-]|fpe:|fpc:)/.test(k)).forEach(k => localStorage.removeItem(k)); } catch {}
  })();

  load().then(live);
  render();
})();
