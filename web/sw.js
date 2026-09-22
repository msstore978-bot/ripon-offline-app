/* Service Worker — অ্যাপ ইন্টারনেট ছাড়াই খোলার জন্য। VERSION ও FILES বিল্ডের সময় বসে (build.mjs)। */
const VERSION = '__VERSION__';
const CACHE = 'ripon-' + VERSION;
const FILES = JSON.parse('__FILES__');

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ripon-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // Apps Script-এ POST সরাসরি নেটওয়ার্কে যায়
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {   // অ্যাপের নিজের ফাইল: ক্যাশ আগে
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
        return new Response('অফলাইন', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {   // ফন্ট (যদি বিল্ডে লোকাল না হয়)
    e.respondWith((async () => {
      const cache = await caches.open('fonts-cache');
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});
