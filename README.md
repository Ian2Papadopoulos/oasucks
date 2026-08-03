# OASUCKS — live OASA arrivals & community reports

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. One Cloudflare Worker serves the whole
app and proxies the API. Installs on Android and iOS like a native app. **Current
version: v25.**

**The top bar** is three buttons — reports ❗, alerts 🔔, and a ☰ menu holding
everything else: [look up a line](#find-a-line) and preview its route, a
[live map](#live-buses) of the buses running around you, the EL/EN switch, and About.

**Community reports.** The old line-stats button is now the red exclamation mark. Tap
it and a problem map of Athens opens — only the buses and metro stations that currently
carry a flag, red for a ticket inspector, yellow for anything else. Under the map,
**Report an issue** lets you flag the bus you are actually riding (the app works out
which one, and you must be within **100 m** of it) or a metro station within 600 m.
See [Reports](#reports-red-exclamation-mark) for the exact rules.

> The service-stats screen (line reliability, bunching, missing trips) still exists in
> the code and the tracking backend still collects data — the UI was retired in v18 to
> make room for reports. See [TRACKING-SETUP.md](TRACKING-SETUP.md).

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

**Switching views:** the Λίστα / Χάρτης tabs, or **swipe left for the map, right for the
list**. On the map the swipe has to start at the left edge, since Leaflet owns dragging
everywhere else; swipes are ignored while a sheet or full-screen panel is open.

**Stops with no lines** (decommissioned, seasonal) are dropped when discovered: the app
removes the pin, remembers it locally so a refresh can't resurrect it, and tells the
Worker via `POST /stops/dead` — which **re-checks with OASA** before recording it in the
shared list, so no one can hide a healthy stop from everyone else.

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

1. **Reach.** Every live vehicle on the lines serving the stops around you. Standing
   still the gate is the **100 m** rule. *While you're moving it widens* — by exactly how
   far a bus travels during the feed's staleness (speed × ~40 s, capped at 900 m),
   because a moving bus's reported position lags reality by that much. Without this the
   vehicle you are sitting in falls outside 100 m and never appears, while a bus parked
   at the kerb — whose stale fix has caught up with reality — does.
2. **Velocity.** A second sample ~6 s later, and this is where the decision is made. A
   stale feed shifts a bus's *position* but not its *velocity*: if you're on board, your
   velocity and the bus's are the same vector even when the reported positions are 300 m
   apart. So heading and pace agreement identify your bus precisely where distance
   fails. The remaining gap is then split into **along-track** (how far the bus is
   "behind itself" — what staleness looks like) and **cross-track** (sideways — what a
   *different street* looks like); a big cross-track offset disqualifies a bus no matter
   how well its speed matches. The along-track figure also gives the fix's age, so the
   bus can be dead-reckoned forward to where it actually is now.

   If nothing is moving — bus at a light, you on foot — there's no velocity to compare,
   so the app stays quiet and leaves plain proximity ranking alone rather than inventing
   a verdict.

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

## Clearing bad reports (e.g. after testing)

Live flags expire by themselves (red 15 min on a bus, 2 h on metro; yellow 60 min), so a
mistaken flag disappears on its own. What outlives it is the **history log** in D1, which
feeds `/reports/toplist` — test flags left there would skew any future statistics.

To wipe both at once (needs `ADMIN_TOKEN`, see [Security model](#security-model)):

```powershell
# every inspector report, live + history
curl -X POST "https://<your-url>/admin/reports/purge" ^
  -H "X-Admin-Token: YOUR_TOKEN" -H "Content-Type: application/json" ^
  -d "{\"type\":\"inspector\",\"log\":true}"

# just one vehicle/station
… -d "{\"targetId\":\"70142\",\"log\":true}"

# everything, but only history from the last 6 hours
… -d "{\"all\":true,\"log\":true,\"hours\":6}"
```

It replies `{"ok":true,"removedLive":N,"removedLog":N,"remaining":N}`. Omit `log` to
clear only the live flags and keep the history. Users can always withdraw their *own*
reports from the ✕ in the reports list — this admin route is for cleaning up after
someone else, or after testing.

<details><summary>Doing it by hand instead (no admin token)</summary>

```powershell
# live flags live in one KV key
npx wrangler kv key get --binding=ALERTS "reports:index" --remote
npx wrangler kv key put --binding=ALERTS "reports:index" "[]" --remote   # wipe all

# history rows
npx wrangler d1 execute oasa-stats --remote ^
  --command "DELETE FROM report_log WHERE type='inspector' AND ts > unixepoch()-21600"
```
</details>

## Security model

There's no login, no payments, and no personal data at rest — so the blast radius is
small by design. The controls that exist:

- **No stored XSS.** Report fields (`targetName`/`lineId`) are attacker-supplyable, so
  every value rendered into a map tooltip or list row is HTML-escaped (`esc()`). A
  `<img onerror=…>` in a report shows as literal text, it never executes.
- **Reports can't be forged or cancelled by others.** Each carries an anonymous
  device token (`by`), kept in `localStorage` and **never** returned to other clients;
  only the original reporter (or expiry) can withdraw one.
- **Alert rules are private.** `GET /rules` requires your own `sub` token — it can only
  return *your* rules — and `/rules/delete` checks ownership. (Earlier versions leaked
  every user's stops and commute windows; fixed.)
- **Tracking mutations are gated.** `/track/add|remove|sample` require the `ADMIN_TOKEN`
  secret (header `X-Admin-Token` or `?token=`); reads stay public. See TRACKING-SETUP.md.
- **The proxy is allow-listed.** `/api` forwards only ~15 named OASA actions, so it
  can't be used as a general open proxy.
- **Rate limiting.** Per-IP, in-memory limits on the write and fan-out endpoints
  (`/reports`, `/rules`, `/scan`, `/live`, cache-bypassing `/api`) blunt a single-source
  flood and protect the KV write quota. It's per-isolate (not globally exact) — for hard
  guarantees, add Cloudflare WAF rate-limiting rules on the zone.
- **Secrets stay server-side.** Only the VAPID *public* key is ever returned; D1 uses
  parameterized queries (no SQL injection); Leaflet is self-hosted (no third-party CDN
  code path).

What an attacker *could* still do: file plausible-looking fake flags (bounded by the
rate limit, and each expires), or — from a different Cloudflare account/IP set — spread
load past the per-isolate limiter. Neither exposes data; the residual risk is report
*spam/integrity*, which a Turnstile challenge on `POST /reports` would further reduce if
you ever need it.

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
