/* Στάση — offline shell. Cache-first for the app shell, network-only for
 * everything live (/api, /nearby, /issues, …). Bump SHELL to force clients
 * onto a new version. */
const SHELL = "stop-shell-v2";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];
const LIVE = /\/(api|nearby|geocode|reverse|issues|metro|push|rules|track|stats)\b/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || LIVE.test(url.pathname)) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit ||
      fetch(e.request).then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(e.request, copy));
        }
        return res;
      }))
  );
});

/* Push notifications (bus alerts) still land here when configured. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Στάση", {
    body: d.body || "", tag: d.tag || "stop", data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data && e.notification.data.url || "./"));
});
