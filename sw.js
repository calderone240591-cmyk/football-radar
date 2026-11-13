// Офлайн-оболонка. Власні файли — спершу мережа (оновлення приходять одразу), без мережі — кеш.
// Дані (ESPN, VBET, журнал) тут не кешуються — ними керують js/api.js і js/app.js.
const VERSION = 'fr-v7';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/config.js', 'js/store.js', 'js/api.js', 'js/vbet.js', 'js/goals.js', 'js/engine.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('fr-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(new Request(req, { cache: 'no-cache' }));
  e.respondWith(fresh
    .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
    .catch(() => caches.match(req, { ignoreSearch: true })));
});
