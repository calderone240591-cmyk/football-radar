window.FP = window.FP || {};

// 25 чемпіонатів + 3 єврокубки. slug — ідентифікатор турніру в ESPN.
// q — орієнтовна сила ліги відносно найсильнішої (АПЛ = 1.00): потрібна моделі голів у єврокубках.
FP.LEAGUES = [
  { slug: 'uefa.champions',   name: 'Ліга чемпіонів',   short: 'ЛЧ', country: 'УЄФА', cup: true },
  { slug: 'uefa.europa',      name: 'Ліга Європи',      short: 'ЛЄ', country: 'УЄФА', cup: true },
  { slug: 'uefa.europa.conf', name: 'Ліга конференцій', short: 'ЛК', country: 'УЄФА', cup: true },
  { slug: 'eng.1', name: 'Прем\'єр-ліга',      short: 'АПЛ',          country: 'Англія',     q: 1.00 },
  { slug: 'esp.1', name: 'Ла Ліга',            short: 'Ла Ліга',      country: 'Іспанія',    q: 0.97 },
  { slug: 'ita.1', name: 'Серія A',            short: 'Серія A',      country: 'Італія',     q: 0.95 },
  { slug: 'ger.1', name: 'Бундесліга',         short: 'Бундесліга',   country: 'Німеччина',  q: 0.94 },
  { slug: 'fra.1', name: 'Ліга 1',             short: 'Ліга 1',       country: 'Франція',    q: 0.90 },
  { slug: 'ned.1', name: 'Ередивізі',          short: 'Ередивізі',    country: 'Нідерланди', q: 0.85 },
  { slug: 'por.1', name: 'Прімейра Ліга',      short: 'Португалія',   country: 'Португалія', q: 0.86 },
  { slug: 'bel.1', name: 'Про Ліга',           short: 'Бельгія',      country: 'Бельгія',    q: 0.80 },
  { slug: 'tur.1', name: 'Суперліга',          short: 'Туреччина',    country: 'Туреччина',  q: 0.80 },
  { slug: 'eng.2', name: 'Чемпіоншип',         short: 'Чемпіоншип',   country: 'Англія',     q: 0.76 },
  { slug: 'sco.1', name: 'Прем\'єршип',        short: 'Шотландія',    country: 'Шотландія',  q: 0.73 },
  { slug: 'aut.1', name: 'Бундесліга',         short: 'Австрія',      country: 'Австрія',    q: 0.75 },
  { slug: 'gre.1', name: 'Суперліга',          short: 'Греція',       country: 'Греція',     q: 0.74 },
  { slug: 'den.1', name: 'Суперліга',          short: 'Данія',        country: 'Данія',      q: 0.73 },
  { slug: 'bra.1', name: 'Серія A',            short: 'Бразилія',     country: 'Бразилія',   q: 0.86 },
  { slug: 'ger.2', name: '2. Бундесліга',      short: '2. Бундесл.',  country: 'Німеччина',  q: 0.74 },
  { slug: 'esp.2', name: 'Сегунда',            short: 'Сегунда',      country: 'Іспанія',    q: 0.72 },
  { slug: 'ita.2', name: 'Серія B',            short: 'Серія B',      country: 'Італія',     q: 0.70 },
  { slug: 'fra.2', name: 'Ліга 2',             short: 'Ліга 2',       country: 'Франція',    q: 0.70 },
  { slug: 'nor.1', name: 'Елітесеріен',        short: 'Норвегія',     country: 'Норвегія',   q: 0.70 },
  { slug: 'swe.1', name: 'Аллсвенскан',        short: 'Швеція',       country: 'Швеція',     q: 0.69 },
  { slug: 'usa.1', name: 'MLS',                short: 'MLS',          country: 'США',        q: 0.74 },
  { slug: 'arg.1', name: 'Ліга Професьйональ', short: 'Аргентина',    country: 'Аргентина',  q: 0.78 },
  { slug: 'mex.1', name: 'Ліга MX',            short: 'Мексика',      country: 'Мексика',    q: 0.74 },
  { slug: 'ksa.1', name: 'Про Ліга',           short: 'Сауд. Аравія', country: 'Саудівська Аравія', q: 0.72 },
];
FP.LEAGUE_BY_SLUG = new Map(FP.LEAGUES.map(l => [l.slug, l]));
FP.CUP_Q = 0.86;      // середній рівень учасника єврокубків
FP.UNKNOWN_Q = 0.68;  // команда з чемпіонату поза списком

// Параметри рекомендацій і статистики. Зміна VERSION обнуляє серверний журнал.
FP.CFG = {
  VERSION: '2026-11-07',
  STATS_FROM: Date.parse('2026-11-07T00:00:00+02:00') / 1000,
  MIN_ODDS: 1.49,        // у рекомендаціях лише кф VBET від 1.49
  STAKE: 50,             // ставка на кожен матч, грн
  BANK: 10000,           // стартовий баланс кожної статистики, грн
  GAP: 120 * 60,         // матчі, що починаються ближче ніж за 2 год один від одного, перетинаються в часі
  HORIZON: 72 * 3600,    // рекомендації — на матчі найближчих 3 днів
  DRY_MIN: 2,            // сухі: команда не забиває 2 матчі поспіль і більше
  UNDER_MIN: 2,          // тотали: у матчах команди 2 рази поспіль і більше не було ТБ 2.5
  Y_MAX: 1,              // ЖК матчу: команда отримала не більше 1 жовтої в кожному з 2 останніх матчів
  Y1_MAX: 0,             // ЖК 1-го тайму: жодної жовтої в 1-му таймі в кожному з 2 останніх матчів
  C_MAX: 3,              // кутові: команда подала не більше 3 кутових у кожному з 2 останніх матчів
  JOURNAL: 'https://raw.githubusercontent.com/calderone240591-cmyk/football-radar/journal/journal.json',
};

FP.pad = n => String(n).padStart(2, '0');
FP.localDate = offset => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${FP.pad(d.getMonth() + 1)}-${FP.pad(d.getDate())}`;
};
