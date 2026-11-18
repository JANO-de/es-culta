// Service worker mínimo: guarda la «carcasa» de la app para abrirla al instante y funcionar como PWA.
// Red primero (para que las actualizaciones lleguen enseguida) y caché como respaldo. Nunca toca /api ni /ws.
const V = "culta-v2";
const SHELL = ["/", "/index.html", "/app.js", "/liars-bar.js", "/liars-bar.css", "/manifest.webmanifest", "/icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/ws" || u.pathname === "/words.txt") return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match("/"))));
});
