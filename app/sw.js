// App shell + lesson notes cache. Lesson audio lives in IndexedDB, not here.
const CACHE = 'ltf-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'vendor/fflate.js', 'manifest.webmanifest', 'decks.json',
  'icon-180.png', 'icon-512.png', 'lessons/index.json',
  ...Array.from({ length: 40 }, (_, i) => `lessons/${String(i + 1).padStart(2, '0')}.json`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates show up straight away; fall back to the cache when
// offline or when the network takes longer than 3 seconds.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const net = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const slow = new Promise(r => setTimeout(r, 3000));
    const hit = () => cache.match(e.request, { ignoreSearch: true });
    try {
      return await Promise.race([net, slow.then(async () => (await hit()) || net)]);
    } catch {
      return (await hit()) || Response.error();
    }
  }));
});
