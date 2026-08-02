# OASUCKS — live OASA arrivals

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. Installs on Android like a native app.

**New in v20.** The top bar is down to three buttons — reports ❗, alerts 🔔, and a ☰
menu holding everything else: [look up a line](#find-a-line) and preview its route,
a [live map](#live-buses) of the buses running around you, the EL/EN switch (moved out
of the header), and About. Reporting a bus now requires you to be within **100 m** of
it.

**Community reports.** The line-stats button is gone; in its place sits a
red exclamation mark. Tap it and a problem map of Athens opens — only the buses and
metro stations that currently carry a flag, red for a ticket inspector, yellow for
anything else. Under the map, **Report an issue** lets you flag the bus you are
actually riding (the app works out which one that is) or a metro station you are
standing at. See [Reports](#reports-red-exclamation-mark) for the exact rules.

## Files

| File | What it is |
|---|---|
| `public/index.html` | The whole app (UI + logic). No build step, no framework. |
| `worker.js` | Cloudflare Worker — serves the app, proxies the OASA API, stores reports. |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icon-*.png` | PWA install + offline shell. |

## The one thing you must understand

The OASA API (`http://telematics.oasa.gr/api/`) is **HTTP-only and sends no CORS
headers**. A browser on an HTTPS page therefore *cannot call it directly* — it fails
on mixed-content + CORS. So every web client needs a small proxy in front of it.

The app auto-detects its backend at startup:

- **Default:** the Worker serves `public/index.html` itself, so the app and its proxy
  share one URL — the same-origin backend is detected and everything just works.
- **Split hosting:** if you host the static files elsewhere, set `CONFIG.proxyBase` in
  `public/index.html` to your Worker URL.
- **No backend at all** (e.g. opened as a local file): it falls back to public CORS
  proxies — fine for a quick look, but rate-limited and flaky, and the extra features
  (reports, alerts, stats) need the Worker. Don't ship on that.

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
2. Auto-refreshes every 30s (the thin progress bar up top is the countdown), pulling
   fresh arrivals *and* the current report flags together.

Field names in the API are inconsistent (mixed casing), so the parsing is defensive —
if line-mapping fails it degrades to the route code and still shows the countdown.

## The ☰ menu

Everything that isn't "what's coming to my stop" lives behind the hamburger, so the
header stays down to the two things you tap in a hurry (reports and alerts).

### Find a line

Type a line number or name — `22` finds **022** before **220**, because matching is
ranked exact → prefix → substring → description text. Pick a line, pick a direction,
and you get the same route preview as long-pressing a line in the arrivals list: the
route drawn over Athens streets, every stop on it, and the buses currently running it.
The only difference is that without a boarding stop the *whole* route is highlighted
instead of just the stretch ahead of you, and the strip lists all its stops.

The line catalogue comes from the Worker's `/lines` (cached a day); directions come
from `getRoutesForLine`.

### Live buses

A map of the buses actually moving, each pin labelled with its line. "Every bus in
Athens at once" would be one API call per route — hundreds, far past a Worker's
subrequest budget — so `/live?lat=&lng=` resolves the lines that serve the area around
the map centre (≤10 stop lookups, ≤28 routes) and returns every vehicle on them,
cached 15 s. Pan the map and tap **↻** to load another area. Tune the ceilings in
`LIVE` in `worker.js`.

## Reports (red exclamation mark)

The ❗ button in the header opens the reports view. The map is a **problem map**: it
shows *only* what is currently flagged — the flagged buses (following their live
positions, so a reported bus keeps moving on the map) and the flagged metro stations,
**red** for a ticket inspector and **yellow** for anything else. Nothing that is fine
is drawn. The full list of active reports sits underneath, newest first, above a
**Report an issue** button.

You can only report what you are actually next to — two categories, no free text:

| Category | Who can report it | What can be reported |
|---|---|---|
| **On a bus** | only the vehicle you're riding (see below) | breakdown · overcrowded · ticket inspector |
| **At a metro station** | stations within **600 m** of you | ticket inspector |

The issue menu changes with the category, so a metro station only ever offers
*ticket inspector*.

### Which bus am I on?

You can't pick a line off a list any more — the app has to identify the vehicle you're
sitting in, which is hard downtown where six buses share one jam. It runs two passes:

1. **Proximity.** Every live vehicle on the lines serving the stops around you, kept
   only if it's within **100 m** of your GPS fix, ranked nearest-first. That's tight
   enough that a bus you're merely watching go past usually won't qualify. Because both
   your fix and the bus's telematics ping are noisy estimates, the acceptance radius
   stretches by the phone's own reported GPS error (capped at +100 m) — otherwise the
   bus you are literally sitting in gets rejected on a bad fix. The scan itself is a
   single request: the Worker's `/scan?lat=&lng=` endpoint does the whole fan-out at
   the edge (the phone used to make ~14 separate calls) and caches the result 10 s per
   ~110 m cell, so riders scanning on the same bus share one answer.
2. **Co-movement.** A second position sample ~6 s later. If you're on board, your GPS
   and the bus move the same way — similar heading, similar distance covered — and the
   gap between you stays small. Those get marked **"moving with you"** and jump to the
   top of the list. If nobody moved (bus stuck at a light, no GPS change), the pass
   stays quiet and plain proximity order holds. This pass re-fetches only the routes
   of the surviving candidates (1–3 calls, cache-bypassed so the positions are
   genuinely fresh), not the full set.

You always confirm with a tap — the app ranks, it never picks for you. If no bus is
within range it says so and refuses the report rather than guessing.

Flags then show up on the reports map and inline in the list view: a flagged bus gets
red **"Ticket inspector X minutes ago"** (or a yellow issue line) under its direction,
matched to that exact vehicle, so the other bus on the same line stays clean.

The rules:

| Flag | Expires after |
|---|---|
| Red (inspector) on a bus | **15 min** — inspectors ride a few stops and hop off |
| Red (inspector) on a metro station | **2 h** |
| Yellow (breakdown / overcrowded) | **60 min** |

Re-reporting the same thing renews the timer. Nobody can cancel someone else's report:
a flag disappears only when it expires or when **the reporter who filed it** withdraws
it (the app keeps an anonymous device token in `localStorage`; the server never exposes
it, so withdrawals can't be forged).

**History for statistics:** active flags live in KV and vanish when they expire, but
every filed report is *also* appended to D1's `report_log` table (timestamp, kind,
type, target, line — no user data). `GET /reports/toplist?days=30&type=inspector`
returns the most-reported buses/lines/stations, ready for a future public stats page.

Reports live in the same KV namespace as the alert rules (`ALERTS`), in a single key —
no extra setup (`GET/POST /reports`, `POST /reports/delete`). The Worker enforces the
same rules as the UI: only `bus` and `metro` categories, and only the types each one
allows. Without a KV binding the app still runs; reporting just returns "not
configured". Metro stations (lines M1/M2/M3) are a static list served by the Worker at
`/metro`; their coordinates are close approximations you can tweak in `worker.js`.

## Tuning

In `public/index.html` → `CONFIG`: `refreshMs` (refresh interval), `listStops` (how
many stops in the list), `maxRows` (arrivals per stop) — the search radius has its own
slider in the map view. Reporting reach lives in `ONBOARD`: `busRadius` (100 m),
`metroRadius` (600 m), `refineMs` (how long the co-movement pass waits) and `minMove`
(how far you must travel for that pass to have an opinion); the per-category issue
menus are `TYPES_BY_KIND`. In `worker.js`: `ACT_TTL` cache times, `ALLOWED_ACTS` if you
add more endpoints, `REPORT_TYPES` (the same menus, enforced server-side), and the
report lifetimes `RED_TTL` / `RED_METRO_TTL` / `YELLOW_TTL`.

## Note

Unofficial community data. Times are OASA's own estimates and can be wrong; treat as a
guide, not a guarantee.
