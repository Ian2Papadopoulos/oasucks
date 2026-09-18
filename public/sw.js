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
const SHELL = "stop-shell-v44";
/* Not a cache of anything fetched — the one store the page and this worker
   can both reach, holding the subscription id the page was given. The
   activate handler below must never sweep it: losing it means a rotated
   push subscription can no longer be re-registered under the id every
   alert rule is keyed by. */
const IDCACHE = "oasax-sub";
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
      .then(keys => Promise.all(keys
        .filter(k => k !== SHELL && k !== IDCACHE)
        .map(k => caches.delete(k))))
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

/* ---- the subscription the browser replaced while you were not looking --
 *
 * A push subscription is not permanent. Browsers rotate the endpoint on
 * their own schedule, and it also dies to storage pressure or a push
 * service retiring it. When that happens the server keeps sending to an
 * endpoint that answers 404, the row is pruned, and every alert the rider
 * set goes quiet — with the rule still in the list and the bell still
 * showing a number. Nothing on screen changes, so from the outside it
 * looks exactly like "alerts stopped working when I closed the tab".
 *
 * This is the event the platform fires to let us repair it, and it fires
 * whether or not the app is open. Re-registering under the SAME id is the
 * whole point: rules are keyed by the id, not by the endpoint, so the
 * alerts survive the rotation instead of having to be set again. */
async function storedSubId() {
  try {
    const c = await caches.open(IDCACHE);
    const r = await c.match("./sub-id");
    const v = r ? (await r.text()).trim() : "";
    return v || null;
  } catch (_) { return null; }
}
function u8(b64) {
  const s = (b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const api = p => new URL(p, self.registration.scope).toString();

self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    const id = await storedSubId();
    if (!id) return;                       // never subscribed here; nothing to repair
    try {
      /* Some browsers hand us the replacement; the rest expect us to ask
         for one. Both paths end at the same POST. */
      let sub = e.newSubscription || null;
      if (!sub) {
        const kr = await fetch(api("push/key"));
        if (!kr.ok) return;
        const { key } = await kr.json();
        if (!key) return;
        sub = await self.registration.pushManager.subscribe(
          { userVisibleOnly: true, applicationServerKey: u8(key) });
      }
      await fetch(api("push/subscribe"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, subscription: sub.toJSON() }),
      });
    } catch (_) { /* the page repairs it on next launch — see repairPush */ }
  })());
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
