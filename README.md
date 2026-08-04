# OASUCKS — live OASA arrivals & community reports

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. One Cloudflare Worker serves the whole
app and proxies the API. Installs on Android and iOS like a native app. **Current
version: v28.**

**The top bar** is three buttons — reports ❗, alerts 🔔, and a ☰ menu holding
everything else: [look up a line](#find-a-line) and preview its route, a
[live map](#live-buses) of the buses running around you, the EL/EN switch, and About.

**Community reports.** The old line-stats button is now the red exclamation mark. Tap
it and a problem map of Athens opens — only the buses and metro stations that currently
carry a flag, red for a ticket inspector, yellow for anything else. Under the map,
**Report an issue** lets you flag the bus you are actually riding (the app works out
which one) or a metro station within 600 m. A report the app could not match to your
vehicle still goes up — faint, short-lived, and needing a second rider to agree.
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
| `public/legal.html` | Terms + privacy, as served in the app (☰ → Terms & privacy). |
| `LICENSE`, `PRIVACY.md`, `TERMS.md` | MIT licence and the documents the hosted service runs under — see [Legal](#legal). |

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

**Favourites:** long-press a stop's header in the list to pin it — it gets a ★ and
sorts to the top, and stays there across refreshes. A pinned stop that's out of range
is still shown (its arrivals are fetched separately), which is the point: your home
stop while you're at work. On the **map** a pinned stop swaps its black dot for a
yellow ★ — including favourites outside the current radius, so they're findable there
too. Long-press again to unpin; up to 6, kept in `localStorage`.

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

### Search — lines *and* stops

One field, two kinds of answer. Type a line number or name — `22` finds **022** before **220**, because matching is
ranked exact → prefix → substring → description text. Pick a line, pick a direction,
and you get the same route preview as long-pressing a line in the arrivals list: the
route drawn over Athens streets, every stop on it, and the buses currently running it.
The only difference is that without a boarding stop the *whole* route is highlighted
instead of just the stretch ahead of you, and the strip lists all its stops.

The line catalogue comes from the Worker's `/lines` (cached a day); directions come
from `getRoutesForLine`.

The same query also returns **stops**. OASA has no stop-name search, so `/stops/search`
geocodes the query (Nominatim — the path the address search already uses) and returns
the stops around that place, ranked so a stop actually *named* like the query beats one
that's merely nearby; stops already loaded around you match instantly with no request at
all. Picking one opens a **card in the centre of the screen** with its live arrivals in
the same style as the list — long-press the stop's name there to pin it, and long-press
an arrival row for the route preview.

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

You can't pick a line off a list — the app has to identify the vehicle you're sitting
in, which is hard downtown where six buses share one jam.

**The problem, in numbers.** An OASA position fix is 30–60 s old by the time you see
it, and our own cache adds up to 10 s more. A bus doing 8 m/s therefore reports itself
**250–450 m behind** where it actually is. The error is proportional to speed, so it
collapses to zero the moment the bus stops — which is why, before v28, the app "only
found my bus when we pulled into a stop". Meanwhile `navigator.geolocation` returns
`speed: null` on most single fixes (Android's fused provider only fills it from raw
GNSS doppler; iOS returns -1), so the slack that was meant to cover the staleness was
usually zero.

**What it does now** — four passes, ~15 s, updating the list as it goes:

0. **Track yourself first.** `watchPosition` collects several fixes over ~8 s and fits
   a least-squares velocity to them. Never one fix's `speed` field: displacement always
   exists, `speed` often doesn't. If accuracy stays worse than 150 m the app says the
   signal is too weak instead of scanning and blaming the feed.
1. **Shortlist wide.** Every live vehicle the server returns — it trims at 1.5 km, and
   nothing tighter is applied. Candidates are ranked by *plausibility*, not distance:
   sideways offset from your path costs full price, lag **along** your own path is
   nearly free, because that is exactly what a stale fix looks like from a seat. A bus
   400 m behind you on your street now outranks one 60 m away on a parallel one.
2. **Co-movement decides.** Two more samples ~5.5 s apart. A stale feed shifts a bus's
   *position* but not the *direction* it is travelling, and direction — unlike speed —
   needs no knowledge of when the feed's fixes were taken. So heading agreement is the
   primary test; pace is checked only when OASA timestamps both ends. The remaining gap
   splits into **along-track** (the bus "behind itself" — staleness) and **cross-track**
   (sideways — a *different street*); a big cross-track offset disqualifies a bus however
   well its speed matches. Along-track also gives the fix's age, so the bus is
   dead-reckoned forward to where it actually is.
3. **The 100 m rule, as a verdict.** Standing still, only a vehicle genuinely within
   ~100 m (+ your GPS accuracy) counts as "yours" — so watching a bus drive past still
   isn't reportable. **This radius is deliberately not widened by speed**: speed widens
   the shortlist, never the verdict. On a moving bus, co-movement is the only route to
   a confirmed report.

You always confirm with a tap — the app ranks, it never picks for you.

### Confirmed and unconfirmed reports

Identifying the vehicle you're inside is an inference over a stale feed, so it is
sometimes simply wrong. A gate that says *no* to an honest rider is a worse failure
than one that says *maybe*, so since v28 location does not decide **whether** you can
file — it decides **what your report is worth**.

| | Confirmed | Unconfirmed |
|---|---|---|
| How | co-moving with you, within 100 m, or at a metro station | you picked from the list, the matcher couldn't agree |
| Marker | solid | **hollow, dashed** |
| Arrivals list | red/yellow line under the direction | **nothing** |
| Lifetime | 15 min / 1 h / 2 h as below | **5 minutes** |

An unconfirmed report is **promoted the moment a second, independent reporter agrees** —
either by filing the same flag or by tapping *"Yes, still there"* on it. So one person
acting alone can never manufacture a solid red flag (which is the property the strict
gate was really protecting), and it costs an abuser a second device instead of costing
an honest rider their report.

**Corroboration.** Every report anyone else filed carries *"Yes, still there"* /
*"Not there"*. One vote per person, never on your own. **Two distinct "not there" votes
delete a report outright** — the self-service version of the manual purge below.

**Reputation.** Reports carry the same anonymous device token used for withdrawal, and
the Worker keeps three counters against it (filed / corroborated / contradicted, pruned
after 60 days). A reporter whose flags keep getting contradicted stops being
auto-confirmed; one whose record is much worse still gets a `200` on every report but
only they can see the result. Neither trigger fires on a single unlucky report.

At most **2 active reports per person** at a time.

Flags then show up on the reports map and inline in the list view: a flagged bus gets
red **"Ticket inspector X minutes ago"** (or a yellow issue line) under its direction,
matched to that exact vehicle, so the other bus on the same line stays clean.

The rules:

| Flag | Expires after |
|---|---|
| Red (inspector) on a bus | **15 min** — inspectors ride a few stops and hop off |
| Red (inspector) on a metro station | **2 h** |
| Yellow (breakdown / overcrowded) | **60 min** |

Re-reporting the same thing renews the timer. **Nobody can cancel someone else's report
outright** — a flag disappears when it expires, when **the reporter who filed it**
withdraws it (the app keeps an anonymous device token in `localStorage`; the server
never exposes it, so withdrawals can't be forged), or when two independent riders vote
"not there".

**History for statistics:** active flags live in KV and vanish when they expire, but
every filed report is *also* appended to D1's `report_log` table (timestamp, kind,
type, target, line — **no coordinates and no reporter id**).
`GET /reports/toplist?days=30&type=inspector` returns the most-reported
buses/lines/stations, ready for a future public stats page. Rows are deleted after
**90 days** by the same cron that prunes tracking events.

Reports live in the same KV namespace as the alert rules (`ALERTS`), in a single key —
no extra setup (`GET/POST /reports`, `POST /reports/delete`, `POST /reports/vote`). The Worker enforces the
same rules as the UI: only `bus` and `metro` categories, and only the types each one
allows. Without a KV binding the app still runs; reporting just returns "not
configured". Metro stations (lines M1/M2/M3) are a static list served by the Worker at
`/metro`; their coordinates are close approximations you can tweak in `worker.js`.

## Checking usage without the dashboard

```powershell
curl "https://<your-url>/health?token=YOUR_ADMIN_TOKEN"
```

Reports which bindings are live, how many reports are active, how many were filed in
the last 24 h / 7 d, tracked routes, and — the number that actually matters —
`kvWritesLast24h` against the free plan's 1,000/day, since every report is one KV write
and that's the ceiling that gives way first. Without the token it's a bare
`{ok, version, time}` liveness ping, safe to point an uptime monitor at.

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

- **Report integrity is layered.** A lone reporter can file at most 2 active flags, and
  none of them can become a *confirmed* red flag without a second, independent device
  agreeing. Two "not there" votes delete a flag. Persistent bad reporters lose
  auto-confirmation, then get shadow-limited.

What an attacker *could* still do: file plausible-looking **unconfirmed** flags (bounded
by the rate limit and the 2-report cap, each expiring in 5 minutes), or — from a
different Cloudflare account/IP set — spread load past the per-isolate limiter. Neither
exposes data; the residual risk is report *spam*, which a Turnstile challenge on
`POST /reports` would further reduce if you ever need it.

## Legal

Publishing this to more than a few friends brings obligations that the code alone
doesn't discharge. What ships in this repo:

| File | What it is |
|---|---|
| `LICENSE` | MIT, for **the code only** — it does not license OASA's data, and it does not protect you as the *operator* of a running service |
| `PRIVACY.md` | GDPR Art. 13 notice: what's processed, legal basis, retention, recipients, rights |
| `TERMS.md` | No-warranty, liability limits, acceptable use, the fare rule, DSA notice-and-action |
| `public/legal.html` | The in-app rendering of both, linked from ☰ → *Terms & privacy* and from About |

**Before you publish, you must:**

1. **Replace `CONTACT@EXAMPLE.COM`** in `PRIVACY.md`, `TERMS.md` and
   `public/legal.html` with an address you actually monitor. It is your GDPR contact
   and your DSA notice-and-action channel; a policy pointing at nothing is worse than
   no policy.
2. Keep the **"unofficial · not affiliated with OASA / ΟΣΥ / ΣΤΑΣΥ"** banner visible —
   it is the first thing on the About screen, and it should be in your launch post too.
3. **Don't add a free-text field, comments or photo upload to reports.** The fixed menu
   is doing most of the defamation-risk work in this project.

The design already minimises exposure: no accounts, no analytics, no cookies banner
(only strictly-necessary `localStorage`), no third-party scripts, no stored location,
and a history log that carries neither coordinates nor reporter ids.

## Tuning

In `public/index.html` → `CONFIG`: `refreshMs` (refresh interval), `listStops` (how
many stops in the list), `maxRows` (arrivals per stop) — the search radius has its own
slider in the map view. **`listStops` is a hard cap and the main cost dial:** the map
draws every stop within the radius as a marker, but the list only ever shows this many
closest stops, and loading their arrivals (one OASA call each) is the expensive part of
a refresh. Raising the radius adds map markers, not list rows — so the number of
arrival calls per refresh stays fixed no matter how far you zoom out. Every visible row
is guaranteed to have its data (`fillVisibleArrivals` tops up anything the batch didn't
cover), so a row can never sit on the loading bars forever. Reporting reach lives in
`ONBOARD`: `busRadius` (100 m),
`metroRadius` (600 m), `refineMs` (how long the co-movement pass waits) and `minMove`
(how far you must travel for that pass to have an opinion); the per-category issue
menus are `TYPES_BY_KIND`. In `worker.js`: `ACT_TTL` cache times, `ALLOWED_ACTS` if you
add more endpoints, `REPORT_TYPES` (the same menus, enforced server-side), and the
report lifetimes `RED_TTL` / `RED_METRO_TTL` / `YELLOW_TTL`.

## Note

Unofficial community data. Times are OASA's own estimates and can be wrong; treat as a
guide, not a guarantee.
