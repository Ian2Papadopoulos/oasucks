// SPDX-License-Identifier: AGPL-3.0-or-later
/* Service worker (v6)
 *
 * Caching rule is an ALLOWLIST, not a blacklist. Previously any path that
 * wasn't explicitly named as "live" got cached forever — which silently
 * froze /nearby, /track/list and /stats as new endpoints were added.
 * Now: only real static files are cached. Anything else (any API path,
 * anything with a query string, anything cross-origin) goes to the network
 * every time. New endpoints are safe by default.
 */
const SHELL = "stop-shell-v35";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest",
  "./vendor/leaflet-1.9.4.min.css", "./vendor/leaflet-1.9.4.min.js"];
// self-hosted, version-pinned vendor .js is now cacheable too (the app's
// own code lives inline in index.html, so nothing dynamic matches .js here)
const STATIC_RE = /\.(png|jpe?g|svg|ico|css|js|woff2?|webmanifest)$/i;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  const isHTML = req.mode === "navigate" ||
                 (req.headers.get("accept") || "").includes("text/html");

  // App shell: network-first so a fresh deploy shows immediately,
  // cache only as an offline fallback.
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  // Static files only: same origin, no query string, known asset extension.
  const cacheable = url.origin === self.location.origin &&
                    !url.search &&
                    STATIC_RE.test(url.pathname);
  if (!cacheable) return;   // everything else: straight to the network

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});

/* ------------------------------ push ------------------------------ */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch { d = { title: "OASAx", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "OASAx", {
    body: d.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: d.tag || "bus",
    renotify: true,
    vibrate: [80, 40, 80],
    data: d,
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
