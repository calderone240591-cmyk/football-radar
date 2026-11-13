// Серверний журнал. Запускає GitHub Actions (.github/workflows/journal.yml): той самий код, що й у додатку
// (js/*.js), рахує рекомендації з кф VBET до початку матчів, оновлює їх до старту і розраховує зіграні.
// Журнал — journal.json у гілці journal; додаток на телефоні й у браузері читає його, тож рекомендації
// й статистика однакові всюди і не залежать від того, чи був додаток відкритий перед матчем.
//
// Використання: node tools/record.js <тека гілки journal> [cache.json] [кількість проходів] [пауза, с]
// PUBLISH=1 — після кожного проходу публікувати журнал (git push у гілку journal).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = process.argv[2] || '.';
const CACHE = process.argv[3] || null;
const RUNS = Math.max(1, +process.argv[4] || 1);
const PAUSE = Math.max(0, +process.argv[5] || 0);
const PUBLISH = process.env.PUBLISH === '1';
const FILE = path.join(DIR, 'journal.json');

// ---------- середовище браузера для файлів додатка ----------
global.window = global;
const kv = new Map();
if (CACHE && fs.existsSync(CACHE)) {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8')))) kv.set(k, v); } catch {}
}
global.FP = {
  store: { ready: Promise.resolve(), get: k => kv.get(k), put: (k, v) => kv.set(k, v), del: k => kv.delete(k), keys: () => [...kv.keys()] },
};
for (const f of ['config.js', 'api.js', 'vbet.js', 'goals.js', 'engine.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: f });
}
const { CFG, api, vbet, engine } = FP;

const sleep = s => new Promise(r => setTimeout(r, s * 1000));
const git = cmd => execSync(`git ${cmd}`, { cwd: DIR, stdio: 'pipe' }).toString();

function saveCache() {
  if (!CACHE) return;
  // Лише завершені дні (вони не змінюються) і список турнірів; старші за історію — геть.
  const oldest = new Date(Date.now() - (CFG.HISTORY_DAYS + 2) * 86400 * 1000);
  const min = `${oldest.getUTCFullYear()}${FP.pad(oldest.getUTCMonth() + 1)}${FP.pad(oldest.getUTCDate())}`;
  const keep = {};
  for (const [k, v] of kv) {
    const m = /^d:(\d{8})$/.exec(k);
    if (k === 'lg' || (m && v.final && m[1] >= min)) keep[k] = v;
  }
  fs.writeFileSync(CACHE, JSON.stringify(keep));
}

async function once() {
  const now = Date.now() / 1000;
  let journal = { version: null, bets: {} };
  if (fs.existsSync(FILE)) { try { journal = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {} }
  if (journal.version !== CFG.VERSION || !journal.bets) journal = { version: CFG.VERSION, bets: {} };

  // Останні дні перезавантажуються щоразу — у них і матчі, що йдуть (рахунок для дострокового розрахунку).
  const { events, errors, days } = await api.history(false);
  await vbet.load(true);
  const vb = vbet.status();
  const res = engine.analyze(events, vbet.book, now);
  engine.updateJournal(journal, res, events, now);
  const prevRows = (journal.snapshot && journal.snapshot.rows) || [];
  res.rows = res.rows.concat(engine.liveRows(prevRows, events, now));

  const { bets, evaluated, keep, ...snapshot } = res;
  journal.updatedAt = new Date().toISOString();
  journal.snapshot = { ...snapshot, errors, events: events.length, vbet: { games: vb.games, error: vb.error, matched: evaluated.length } };
  fs.writeFileSync(FILE, JSON.stringify(journal));

  const all = Object.values(journal.bets);
  console.log(`${new Date().toISOString()} ESPN: ${events.length} matches, ${days} days (failed ${errors}) · VBET: ${vb.error || `${vb.games} games, matched ${evaluated.length}`} · rows: ${res.rows.length} · dry teams ${res.dry.length} · low teams ${res.low.length} · bets now: ${bets.length} · journal: ${all.length} (settled ${all.filter(b => b.res).length})`);

  if (PUBLISH) {
    git('add journal.json');
    try { git('diff --cached --quiet'); console.log('no changes'); }
    catch { git('commit --amend -m Journal --quiet'); git('push --force --quiet origin HEAD:journal'); }
  }
  saveCache();
}

(async () => {
  for (let i = 0; i < RUNS; i++) {
    try { await once(); } catch (e) { console.error('run failed:', e && e.stack || e); }
    if (i < RUNS - 1) await sleep(PAUSE);
  }
  process.exit(0);
})();
