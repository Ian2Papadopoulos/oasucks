# Στάση — live OASA arrivals

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. Installs on Android like a native app.

**New in v18 — community reports.** The line-stats button is gone; in its place sits a
red exclamation mark. Tap it and a map of Athens opens showing every bus, stop and metro
station currently flagged by users — red for a ticket inspector, yellow for any other
issue (breakdown, incident, delay…). Under the map, **Report an issue** lets you flag
the bus you're riding, a nearby stop, or a metro station. See
[Reports](#reports-red-exclamation-mark) below for the exact rules.

## Files

| File | What it is |
|---|---|
| `public/index.html` | The whole app (UI + logic). No build step, no framework. |
| `worker.js` | Cloudflare Worker — serves the app, proxies the OASA API, stores reports. |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icon.svg` | PWA install + offline shell. |

## The one thing you must understand

The OASA API (`http://telematics.oasa.gr/api/`) is **HTTP-only and sends no CORS
headers**. A browser on an HTTPS page therefore *cannot call it directly* — it fails
on mixed-content + CORS. So every web client needs a small proxy in front of it.

- **Default:** the Worker serves `public/index.html` itself, so the app and its proxy
  share one URL — `CONFIG.proxyBase` stays `""` (same origin) and everything just works.
- **Split hosting:** if you host the static files elsewhere, set `CONFIG.proxyBase` in
  `public/index.html` to your Worker URL. Every request is HTTPS, CORS-clean, and
  cached ~12s at the edge either way.

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

The Worker serves everything in `public/` at the same URL (see `[assets]` in
`wrangler.toml`), so that one deploy **is** the app — no separate static host needed.
Only if you host the frontend elsewhere, edit `public/index.html`:
```js
const CONFIG = { proxyBase: "https://oasa-proxy.<you>.workers.dev", ... };
```
Serve over HTTPS — that's required for geolocation and service-worker install.

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

1. The app calls the Worker's batch endpoint `/nearby?lat=&lng=` once; the Worker fans
   out to `getClosestStops`, `webRoutesForStop` and `getStopArrivals` at the edge and
   returns stops + line names + live arrivals in a single response, so a row reads
   **608 · to Voula · 4 min** instead of a raw route code.
2. Auto-refreshes every 30s (the thin amber bar up top is the countdown), pulling fresh
   arrivals *and* the current report flags together.

Field names in the API are inconsistent (mixed casing), so the parsing is defensive —
if line-mapping fails it degrades to the route code and still shows the countdown.

## Reports (red exclamation mark)

The ❗ button in the header opens the reports view: a map of Athens with every currently
flagged bus, stop and metro station — **red** for a ticket inspector, **yellow** for
everything else — plus a **Report an issue** button underneath.

Filing a report is three taps, no free-text comments in this version:

1. **Where:** *On a bus* / *At a stop* / *Metro station*. Your location narrows the
   candidates — buses currently driving near you (picked from live positions of the
   lines serving your nearby stops), the stops around you sorted by distance, or the
   nearest metro stations.
2. **What:** a dropdown — *Ticket inspector* (red), or *vehicle broke down*,
   *incident/disturbance*, *severe delay*, *other* (all yellow).
3. **Send.**

Flags then show up everywhere: on the reports map, and inline in the list view — a
flagged bus gets red **"Ticket inspector X minutes ago"** (or a yellow issue line)
under its direction, and a flagged stop gets the same under its name.

The rules:

| Flag | Expires after |
|---|---|
| Red (inspector) on a bus or stop | **15 min** — inspectors ride a few stops and hop off |
| Red (inspector) on a metro station | **2 h** |
| Yellow (any other issue), any target | **60 min** |

Re-reporting the same thing renews the timer. Nobody can cancel someone else's report:
a flag disappears only when it expires or when **the reporter who filed it** withdraws
it (the app keeps an anonymous device token in `localStorage`; the server never exposes
it, so withdrawals can't be forged).

Reports live in the same KV namespace as the alert rules (`ALERTS`), in a single key —
no extra setup. Without a KV binding the app still runs; reporting just returns
"not configured". Metro stations (lines M1/M2/M3) are a static list served by the
Worker at `/metro/stations`; their coordinates are close approximations you can tweak
freely in `worker.js`.

## Tuning

In `public/index.html` → `CONFIG`: `refreshMs` (refresh interval), `maxStops` (how many
stops), `maxRows` (arrivals per stop), `busPickRadius` (how far a bus can be and still
be flagged). In `worker.js`: `ACT_TTL` cache times, `ALLOWED_ACTS` if you add more
endpoints, and the report lifetimes `RED_TTL` / `RED_METRO_TTL` / `YELLOW_TTL`.

## Note

Unofficial community data. Times are OASA's own estimates and can be wrong; treat as a
guide, not a guarantee.
