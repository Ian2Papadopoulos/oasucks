# OASUCKS — live OASA arrivals & community reports

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. One Cloudflare Worker serves the whole
app and proxies the API. Installs on Android and iOS like a native app. **Current
version: v37.**

**The top bar** is three buttons — live reports (the red dot), alerts 🔔, and a ☰ menu
holding [look up a line](#search--lines-and-stops), **Settings** (language, and whether
to hide stops with nothing coming), About, and Terms & privacy.

**Live reports.** The old line-stats button is now the red live dot. Tap it and a live map of
Athens opens — only the buses and metro stations that currently carry a flag, each
labelled with what it is. Reports come in two categories: **issues** (red — breakdown,
overcrowding, no A/C, broken lift) and **operational** (blue — fare inspection,
security presence, customer service staff). Under the map, **New report** lets you
flag the bus you are actually riding (the app works out which one) or a metro station
within 600 m. Every report is trusted; when several people flag the same thing it
becomes one marker carrying the head count.
See [Live reports](#live-reports) for the exact rules.

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
| `LICENSE`, `PRIVACY.md`, `TERMS.md` | AGPL-3.0 and the documents the hosted service runs under — see [Legal](#legal). |
| `PARAMETERS.md` | **Every tunable number in one table** — radii, lifetimes, rate limits, cost dials. |

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
2. Auto-refreshes every 30s, pulling fresh arrivals *and* the current report flags
   together. There is no countdown bar; the location line carries a quiet **"just now"
   / "40s ago"** stamp instead, which turns red once the data is over 150s old.

**Row order:** favourites first, then stops that actually have a bus coming (within
15 minutes) by distance, then the rest by distance. The nearest shelter is useless if
nothing calls there for half an hour, so it yields to one a little further with a bus
in four minutes — and if the 10-row cap is full it drops off the list entirely (it
stays on the map). The server details 14 stops so there are live candidates to promote;
see [PARAMETERS.md](PARAMETERS.md).

**Favourites:** **double-tap** a stop to pin it — its header in the list, its name on
the stop card, or its pin on the map (the label counts too). It gets a ★, sorts to the
top and stays there across refreshes. A pinned stop that's out of range is still shown
(its arrivals are fetched separately), which is the point: your home stop while you're
at work, and it survives the hide-empty filter. On the **map** a pinned stop swaps its
black dot for a yellow ★. Double-tap again to unpin; up to 6, kept in `localStorage`.
**Long-press** is only for previews, and only in the list: hold an arrival row and the
line's route opens over a map. On the map itself nothing is bound to a hold.

**Seeing a line on the map.** Tap a stop's pin and its popup lists every route calling
there, as buttons: the lines it serves, and the arrivals due. Pick one and that route is
drawn over the city, fitted to the whole line, with its destination labelled at the far
end and a marker on the stop you picked it from. A bar along the bottom names what is
drawn; tap the same line again, or ✕, to clear it and return the map to where it was.
A line running both directions through the stop appears twice, each chip spelling out
where it goes, so you pick a direction rather than being given one.

This replaced a carousel: holding a pin used to parade every line serving it past on a
3.2s timer. It answered a question nobody asks — you want the line you are waiting for,
not all of them in turn — and it fetched every route's geometry to do it. Now nothing
is fetched until a line is picked, and the picked route is cached for the rest of the
session.

**The route preview** (long-press an arrival row) opens a map of that line with your
boarding stop as the origin. The stretch behind you stays flat grey; everything from
your stop to the **terminus** carries the same live snake the map draws, and the view
fits that whole stretch. It used to stop nine stops ahead, which made a bus to the far
side of Athens look like a short hop. The next nine stops are still the ones numbered
and listed underneath, since that is the part you actually count down.

**Switching views:** the Λίστα / Χάρτης tabs, or **swipe left for the map, right for the
list**. The slide starts on the same frame as the gesture and the incoming tab renders on
the next one, so the motion is never waiting on work. The first trip to the map is the
expensive one, since Leaflet has to be built, so `warmMap` builds it in idle time while
the list is still on screen, laid out but invisible. On a phone-class CPU that took the
blocked time before anything moved from **145 ms down to 36 ms**, and the periodic forced
resize (once per refresh sweep, thirty seconds apart, for a size that had not changed) is
gone. On the map the swipe has to start at the left edge, since Leaflet owns dragging
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
the same style as the list. Double-tap the stop's name there to pin it; long-press an
arrival row for the route preview.

### Alerts (🔔) — any stop, not just nearby ones

The stop picker in a new alert lists your **favourites** first, then nearby stops, then
**⌕ Search another stop…** — which reaches any stop in Athens through `/stops/search`
(the same geocode-then-rank path as the menu search). Pick one and its routes are
fetched on demand, so the line/direction dropdown fills in for a stop you have never
been near.

That means setting a 08:35 alarm for your office stop no longer requires dragging the
location pin across town first. With no nearby stops loaded at all, the form opens
straight into search rather than dead-ending.

### Settings

Language (ΕΛ / EN), a replay of the guide, and one display preference:

**How it works** reopens the four-card onboarding described below.

**Hide stops with no arrivals** — off by default. On, a stop with nothing due in the
next `imminentMin` (15 min) is left out of the list entirely rather than demoted to the
bottom, however close it is. Favourites are exempt — pinning one is an explicit "always
show me this". The filter demands a *known* arrival, so stops the server hasn't detailed
never sneak in only to drop out a moment later. Kept in `localStorage` under `hideEmpty`.

## First run — the guide

The gestures that matter here are not discoverable, so on a fresh install four floating
cards appear once the stops behind them have painted (700ms after load, so the app is
never explained against an empty screen). They cover live reports, double-tap to
favourite, swiping between list and map, and setting an alert for a stop you are
nowhere near. **Skip** or **Next → Start**; either way it is remembered in
`localStorage.tourSeen` and never shows again on its own. Settings → **How it works**
replays it from card one.

This replaced the permanent hint line under the list, which said one thing forever and
was the first sentence people stopped reading.

### Live buses — retired from the menu

**Hidden since v33** (`#m-live` carries `hidden`), but the code, the `#livebg` panel and
the Worker's `/live` endpoint are all intact — remove the attribute to bring it back.
What it does:

A map of the buses actually moving, each pin labelled with its line. "Every bus in
Athens at once" would be one API call per route — hundreds, far past a Worker's
subrequest budget — so `/live?lat=&lng=` resolves the lines that serve the area around
the map centre (≤10 stop lookups, ≤28 routes) and returns every vehicle on them,
cached 15 s. Pan the map and tap **↻** to load another area. Tune the ceilings in
`LIVE` in `worker.js`.

## Live reports

The live-dot button in the header opens the live-reports view. The map shows *only* what is
currently flagged — the flagged buses (following their live
positions, so a reported bus keeps moving on the map) and the flagged metro stations.
Each pin carries a label above it saying what it is — *Fare inspection*, *No A/C*,
*Security presence* — so the map answers "what and where" without a tap. Colour
carries the **category**: red for issues, blue for operational. Below zoom 15 the labels hide (a dozen of them overlap into
noise at city scale) and the pin's count badge carries the weight; tap a pin and the
popup says the same thing. Nothing that is fine is drawn. The full list of active
reports sits underneath, busiest first, above a **Report an issue** button.

You can only report what you are actually next to — no free text, ever:

| Where you are | Who can report it | Issues (red) | Operational (blue) |
|---|---|---|---|
| **On a bus** | only the vehicle you're riding (see below) | breakdown · overcrowded · no A/C | fare inspection · security presence · customer service staff |
| **At a metro station** | stations within **600 m** of you | elevator not working | fare inspection · security presence · customer service staff |

The menu changes with where you are — a bus never offers *elevator not working* — and
the Worker enforces the same menus server-side, so a hand-made request can't file a
type the UI doesn't show.

**On the operational category.** These entries are factual, staff-agnostic statements
about a *situation*: "fare inspection is happening on this line" is service information
of the same kind as "this bus has no air conditioning". The app has no free-text field,
no photo upload, and no way to describe or identify a person — by design, and it is the
single most important thing to keep that way. See [Legal](#legal).

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

### Every report is trusted — the count is the signal

There is no confirmation tier and no voting. A rider who files a flag is believed,
and it stands until it expires or its author withdraws it.

What replaces corroboration is simply the **head count**. Each reporter files their
own record (that is what keeps withdrawal rights per-person), so the number of
records sharing `kind|targetId|type` *is* the number of distinct people reporting the
same thing. The app collapses them into **one** marker and one list row carrying that
number — otherwise four people flagging the same bus would stack four identical pins.
"3 reports" reads heavier than "1" without anyone having to vote on anything.

The count shows in three places: a badge on the map pin, `×3` in the map label, and a
red chip in the report list (which sorts busiest-first).

Abuse control is now blunt and cheap: at most **2 active reports per device**, per-IP
rate limits, and every flag expiring on its own. A false flag is cleared by its author
(✕) or by the [admin purge](#clearing-bad-reports-eg-after-testing) — there is no
longer a way for other riders to vote one down.

At most **2 active reports per person** at a time.

Flags then show up on the reports map and inline in the list view: a flagged bus gets
**"Fare inspection · 3 reports · 4′ ago"** under its direction — in the category's
colour — matched to that exact vehicle, so the other bus on the same line stays clean.

The rules:

| Flag | Expires after |
|---|---|
| Fare inspection on a bus | **15 min** — staff ride a few stops and get off |
| Security presence / customer service staff on a bus | **30 min** |
| Anything at a metro station | **2 h** — a station is worked for hours, and a broken lift outlasts a trip |
| Breakdown / overcrowded / no A/C (bus) | **60 min** |

All of these live in one table, `TTL` in `worker.js` — see
[PARAMETERS.md](PARAMETERS.md).

Re-reporting the same thing renews your own record's timer without inflating the count.
**Nobody can cancel someone else's report** — a flag disappears when it expires or when
**the reporter who filed it** withdraws it (the app keeps an anonymous device token in
`localStorage`; the server never exposes it, so withdrawals can't be forged).

**History for statistics:** active flags live in KV and vanish when they expire, but
every filed report is *also* appended to D1's `report_log` table (timestamp, kind,
type, target, line — **no coordinates and no reporter id**).
`GET /reports/toplist?days=30&type=fare` returns the most-reported
buses/lines/stations, ready for a future public stats page. Rows are deleted after
**90 days** by the same cron that prunes tracking events.

Reports live in the same KV namespace as the alert rules (`ALERTS`), in a single key —
no extra setup (`GET/POST /reports`, `POST /reports/delete`). The Worker enforces the
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
# every fare-inspection report, live + history
curl -X POST "https://<your-url>/admin/reports/purge" ^
  -H "X-Admin-Token: YOUR_TOKEN" -H "Content-Type: application/json" ^
  -d "{\"type\":\"fare\",\"log\":true}"

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
  --command "DELETE FROM report_log WHERE type='fare' AND ts > unixepoch()-21600"
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

- **Report volume is capped, not judged.** Since v31 every report is trusted, so the
  controls are blunt: at most 2 active flags per device, 8 filings/min per IP, and
  every flag expires on its own.

What an attacker *could* still do: file plausible-looking flags (bounded by the rate
limit and the 2-report cap, each expiring on its own), or — from a different Cloudflare
account/IP set — spread load past the per-isolate limiter. Neither exposes data; the
residual risk is report *spam*, and with corroboration removed the remedies are the
author's ✕, the admin purge, and — if it ever becomes a real problem — a Turnstile
challenge on `POST /reports`.

## Legal

Publishing this to more than a few friends brings obligations that the code alone
doesn't discharge. What ships in this repo:

| File | What it is |
|---|---|
| `LICENSE` | AGPL-3.0, for **the code only** — it does not license OASA's data, and it does not protect you as the *operator* of a running service |
| `PRIVACY.md` | GDPR Art. 13 notice: what's processed, legal basis, retention, recipients, rights |
| `TERMS.md` | No-warranty, liability limits, acceptable use, the fare rule, DSA notice-and-action |
| `public/legal.html` | The in-app rendering of both, linked from ☰ → *Terms & privacy* and from About |

**The AGPL, and what it means for a hosted app.** The code is under
[AGPL-3.0-or-later](LICENSE). The clause that matters here is **§13**: with a normal
GPL, an obligation to hand over source is triggered by *distributing* the program, and
nobody distributes a web app — users only talk to it over the network. §13 closes that
gap. Anyone who runs a **modified** copy of this and lets other people use it over a
network has to offer those users the source of *their* version. Running it unmodified,
or hacking on a private copy nobody else uses, triggers nothing.

In practice that means the app has to carry a route to its own source. It does that by
**written offer**: ☰ → About and the footer of `legal.html` both say the source is free
on request and give the contact address. That is an offer, not a link, so it only holds
up if it is honoured — **send the source to anyone who asks, promptly and at no charge**.
If you would rather not field those mails, publish the repository and turn both lines
into links to it; that discharges §13 without anyone having to write to you. Either way,
if you fork and deploy, point them at *your* build: someone else's source does not
discharge §13 for yours.

The rest of what the licence asks for is already in place: `LICENSE` verbatim, SPDX
headers on `worker.js`, `public/index.html` and `public/sw.js`, and `license` in
`package.json`.

The choice is deliberate. The permissive licence this started under would have let
anyone take the work, close it, and ship it as their own; a transit app built by the
people who ride the network should stay open to them.

**Before you publish:**

1. The contact address is **oasax@proton.me** (in `PRIVACY.md`, `TERMS.md` and
   `public/legal.html`) — it is the GDPR contact and the DSA notice-and-action
   channel, so the inbox needs to be monitored.
2. Keep the **"unofficial · not affiliated with OASA / ΟΣΥ / ΣΤΑΣΥ"** banner visible —
   it is the first thing on the About screen, and it should be in your launch post too.
3. **Don't add a free-text field, comments or photo upload to reports.** The fixed menu
   is doing most of the defamation-risk work in this project.

The design already minimises exposure: no accounts, no analytics, no cookies banner
(only strictly-necessary `localStorage`), no third-party scripts, no stored location,
and a history log that carries neither coordinates nor reporter ids.

## Tuning

**Every arbitrary number in the project is listed in [PARAMETERS.md](PARAMETERS.md)** —
reporting radii, report lifetimes, rate limits, retention, gesture thresholds, and which
three parameters actually drive cost. Start there.

The short version: `CONFIG` in `public/index.html` holds the client dials
(`refreshMs`, `listStops`, `maxRows`), `ONBOARD` holds the reporting reach, `SCAN` and
`LIVE` in `worker.js` hold the server fan-out, and `TTL` holds how long each kind of
flag lives. The per-category issue menus are `TYPES_BY_KIND` (client) and
`REPORT_TYPES` (server, enforced) — keep those two in sync.

## Note

Unofficial community data. Times are OASA's own estimates and can be wrong; treat as a
guide, not a guarantee.
