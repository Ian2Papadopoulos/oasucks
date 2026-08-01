# Στάση — live OASA arrivals

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. Installs on Android like a native app.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app (UI + logic). No build step, no framework. |
| `worker.js` | Cloudflare Worker — your production proxy for the OASA API. |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | PWA install + offline shell. |

## The one thing you must understand

The OASA API (`http://telematics.oasa.gr/api/`) is **HTTP-only and sends no CORS
headers**. A browser on an HTTPS page therefore *cannot call it directly* — it fails
on mixed-content + CORS. So every web client needs a small proxy in front of it.

- **Demo mode (default):** `index.html` falls back to public CORS proxies, so it works
  the moment you open it. Fine for trying it out; those proxies are rate-limited and
  flaky, so don't ship on them.
- **Production:** deploy `worker.js` and set `CONFIG.proxyBase` in `index.html` to your
  Worker URL. Now every request is HTTPS, CORS-clean, and cached ~12s at the edge.

## Deploy in ~5 minutes

**1. The proxy (Cloudflare Worker, free tier):**
```bash
npm i -g wrangler
wrangler login
# create a project, drop in worker.js as the entry, then:
wrangler deploy
```
You'll get a URL like `https://oasa-proxy.<you>.workers.dev`.
(No CLI? Cloudflare dashboard → Workers → Create → paste `worker.js` → Deploy.)

**2. Point the app at it** — edit `index.html`:
```js
const CONFIG = { proxyBase: "https://oasa-proxy.<you>.workers.dev", ... };
```

**3. Host the static files** — any static host works (Cloudflare Pages, Netlify, GitHub
Pages, Vercel). Just serve the folder over HTTPS. That's required for geolocation and
service-worker install.

## Install on Android (PWA)

Open the hosted URL in Chrome → menu → **Add to Home screen**. It launches full-screen,
standalone, with the app icon. No Play Store needed.

## Ship it as a real Play Store app (optional)

Wrap the PWA in a Trusted Web Activity — a thin native shell around your live URL:
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://your-domain/manifest.webmanifest
bubblewrap build      # produces a signed .aab to upload to Play Console
```
You verify domain ownership with a Digital Asset Links file; Bubblewrap prints the exact
JSON to host at `/.well-known/assetlinks.json`.

## How the data flows

1. `getClosestStops&p1={lat}&p2={lng}` → nearby stops (code, name, distance).
2. Per stop, in parallel:
   - `getStopArrivals&p1={stopCode}` → `[{ route_code, btime2 }]` (minutes away).
   - `webRoutesForStop&p1={stopCode}` → maps each `route_code` to its line number +
     destination, so a row reads **608 · to Voula · 4 min** instead of a raw code.
3. Auto-refreshes every 30s (the thin amber bar up top is the countdown).

Field names in the API are inconsistent (mixed casing), so the parsing is defensive —
if line-mapping fails it degrades to the route code and still shows the countdown.

## Tuning

In `index.html` → `CONFIG`: `refreshMs` (refresh interval), `maxStops` (how many stops),
`maxRows` (arrivals per stop). In `worker.js`: `CACHE_SECONDS`, and `ALLOWED_ACTS` if you
add more endpoints.

## Note

Unofficial community data. Times are OASA's own estimates and can be wrong; treat as a
guide, not a guarantee.
