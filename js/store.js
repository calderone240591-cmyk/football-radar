// Сховище в IndexedDB (на iPhone localStorage обмежений ≈ 5 МБ, а кеш турнірів — кілька МБ).
// Таблиця kv — кеш даних ESPN і останній журнал. Читання синхронне з пам'яті (усе вантажиться
// при запуску), запис — у фоні. Без IndexedDB дані живуть лише в пам'яті.
FP.store = (() => {
  const DB_NAME = 'fr-cache';
  const data = new Map();
  let db = null;

  const ready = new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    setTimeout(finish, 10000);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = finish;
      req.onsuccess = () => {
        if (done) { req.result.close(); return; }
        db = req.result;
        db.onversionchange = () => { db.close(); db = null; };
        try {
          const cur = db.transaction('kv').objectStore('kv').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return finish();
            data.set(c.key, c.value);
            c.continue();
          };
          cur.onerror = () => { db = null; finish(); };
        } catch { db = null; finish(); }
      };
    } catch { finish(); }
  });

  const get = k => data.get(k);
  function put(k, v) {
    data.set(k, v);
    if (!db) return;
    try { db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch {}
  }
  function del(k) {
    data.delete(k);
    if (!db) return;
    try { db.transaction('kv', 'readwrite').objectStore('kv').delete(k); } catch {}
  }
  const keys = () => [...data.keys()];

  return { ready, get, put, del, keys };
})();
