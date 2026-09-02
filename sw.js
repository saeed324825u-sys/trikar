/* =========================================================================
   Service Worker — نماز و عادات ٹریکر

   Two jobs:
   1. Offline app-shell caching (cache-first for same-origin files,
      stale-while-revalidate for the Google Fonts request).
   2. Best-effort background prayer reminders via Periodic Background
      Sync. This is Chrome/Android-only, requires the app to be
      installed, and the browser decides how often this actually wakes
      up — so instead of matching an exact minute, every wake-up asks
      "has today's reminder for each enabled prayer already fired?" and
      fires any that are due but haven't. See the Reminders tab in the
      app for the plain-language version of this trade-off.
   ========================================================================= */
const CACHE_VERSION = 'salah-tracker-v1';
const APP_SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Same-origin app shell: cache-first, refresh cache in the background,
    // fall back to the cached shell for navigations when fully offline.
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
        return cached || network;
      })
    );
  } else {
    // Cross-origin (Google Fonts): stale-while-revalidate so fonts still
    // render offline after the first successful load, without ever
    // blocking installation on a third-party request.
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});

/* ---------------------------------------------------------------------
   Minimal read/write access to the same IndexedDB the page uses.
   Only touches STORE_PROFILES (plain metadata) and STORE_REMINDERS
   (plain schedule settings) — the encrypted prayer-log payload in
   STORE_RECORDS is never read here, and the service worker never has
   the decryption key. It cannot see prayer history, only clock times.
   --------------------------------------------------------------------- */
const DB_NAME = 'salah_habit_tracker_db';
const DB_VERSION = 1;
const STORE_PROFILES = 'profiles';
const STORE_RECORDS = 'records';
const STORE_REMINDERS = 'reminder_settings';

function swOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROFILES)) db.createObjectStore(STORE_PROFILES, { keyPath: 'username' });
      if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS, { keyPath: 'username' });
      if (!db.objectStoreNames.contains(STORE_REMINDERS)) db.createObjectStore(STORE_REMINDERS, { keyPath: 'username' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function swGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function swPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

const PRAYER_LABELS = { fajr: 'فجر', dhuhr: 'ظہر', asr: 'عصر', maghrib: 'مغرب', isha: 'عشاء' };

async function checkAndFireDueReminders() {
  try {
    const db = await swOpenDB();
    const [profiles, reminderRows] = await Promise.all([
      swGetAll(db, STORE_PROFILES),
      swGetAll(db, STORE_REMINDERS)
    ]);
    const nameFor = (u) => (profiles.find((p) => p.username === u) || {}).displayName || '';
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    for (const row of reminderRows) {
      let changed = false;
      const label = nameFor(row.username);

      for (const key of Object.keys(row.prayerTimes || {})) {
        const cfg = row.prayerTimes[key];
        if (!cfg.enabled) continue;
        const [h, m] = cfg.time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
        if (now >= target && cfg.lastFired !== todayKey) {
          const body = label ? `${label} — ${PRAYER_LABELS[key]} کا وقت ہو گیا` : `${PRAYER_LABELS[key]} کا وقت ہو گیا`;
          await self.registration.showNotification('نماز یاد دہانی', { body, dir: 'rtl', lang: 'ur' });
          cfg.lastFired = todayKey;
          changed = true;
        }
      }

      const w = row.weekly;
      if (w && w.enabled && now.getDay() === w.day) {
        const [h, m] = w.time.split(':').map(Number);
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
        if (now >= target && w.lastFired !== todayKey) {
          const body = label ? `${label} کے ہفتہ وار جائزے کا وقت ہو گیا` : 'ہفتہ وار جائزے کا وقت ہو گیا';
          await self.registration.showNotification('ہفتہ وار جائزہ', { body, dir: 'rtl', lang: 'ur' });
          w.lastFired = todayKey;
          changed = true;
        }
      }

      if (changed) await swPut(db, STORE_REMINDERS, row);
    }
  } catch (e) {
    /* IndexedDB unavailable, empty, or blocked — nothing to catch up on */
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'prayer-reminder-check') event.waitUntil(checkAndFireDueReminders());
});

// A few Chromium builds fall back to a one-off 'sync' signal; harmless to
// hook it too as an extra best-effort catch-up opportunity.
self.addEventListener('sync', (event) => {
  if (event.tag === 'prayer-reminder-check') event.waitUntil(checkAndFireDueReminders());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
