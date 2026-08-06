# Tunable parameters

Every arbitrary number in the app, in one place, with where it lives and what
breaks if you change it. Values here are the **v38 defaults** — if you edit the
source, edit this table too.

Two files hold almost everything: **`public/index.html`** (the app) and
**`worker.js`** (the server). Nothing here needs a rebuild — change the value,
`npx wrangler deploy`, done.

> **Read this first.** Three numbers govern cost, and none of them is a radius:
> `SCAN.maxRoutes`, `SCAN.stopProbe` and `CONFIG.listPool`. Distances only
> decide what gets *shown*; the per-route and per-stop fan-outs decide what gets
> *fetched*. See [What actually costs money](#what-actually-costs-money).

---

## 1. Reporting reach — "am I close enough to flag this?"

`public/index.html` → `ONBOARD`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `metroRadius` | **600 m** | How near a station you must be for it to appear in the picker. Stations don't move, so this check is exact. | Lower = stricter; 600 m already covers a large interchange. |
| `gateM` | **800 m** | How far out a vehicle may be and still be a *candidate*. Must match `SCAN.keepM`. | **Below ~700 m the moving-bus matching breaks** — see note under `SCAN.keepM`. |
| `maxRadius` | **900 m** | Absolute ceiling on any widened radius. | Safety cap; rarely worth touching. |
| `accMax` | **150 m** | Worse GPS accuracy than this and the app says "signal too weak" instead of guessing. | Raise it and you get confident-looking wrong answers. |
| `shortlist` | **10** | How many candidate vehicles the co-movement pass weighs. | Higher = marginally slower, no extra requests. |

### Co-movement matching (how "moving with you" is decided)

| Parameter | Default | What it means |
|---|---|---|
| `trackMs` | **8 000 ms** | How long we watch *your* position before scanning, to fit a velocity. |
| `trackMin` | **3** | Fixes needed before a track is usable. |
| `sampleMs` | **5 500 ms** | Gap between vehicle position samples. |
| `samples` | **3** | Total vehicle samples (1 up front + 2 while refining). Whole flow ≈ 15–20 s. |
| `moveMs` | **2 m/s** | Above this you count as "in traffic" rather than standing. |
| `minMove` | **20 m** | How far a bus must travel before its direction is trustworthy. |
| `cosOK` | **0.75** | Heading agreement required for "moving with you" (≈ within 41°). |
| `paceOK` | **0.5** | Speed ratio still counted as the same vehicle. Only applied when OASA timestamps the fix. |
| `crossMax` | **80 m** | Sideways offset that still counts as "the same street". |
| `staleS` | **40 s** | Assumed age of an OASA fix when widening the shortlist. |
| `maxStaleS` | **75 s** | Most staleness we'll ever believe. **This sets the floor for `gateM`/`keepM`.** |

> **Why the radii can't just be small.** A bus's reported position lags reality by
> `speed × age`. At an urban 8 m/s with a 75 s worst-case age that's **600 m of
> lag** — the bus you are sitting in reports itself 600 m behind you. Gate tighter
> than that and you're back to only finding your bus once it stops at a kerb.

---

## 2. Report lifetimes and abuse limits

`worker.js` → `TTL`, plus the constants under it

| Parameter | Default | What it means |
|---|---|---|
| `TTL.bus.breakdown` | **3 600 s** (1 h) | |
| `TTL.bus.crowded` | **3 600 s** (1 h) | |
| `TTL.bus.noac` | **3 600 s** (1 h) | Lasts the trip. |
| `TTL.bus.fare` | **900 s** (15 min) | Staff ride a few stops and get off. |
| `TTL.bus.security` | **1 800 s** (30 min) | |
| `TTL.bus.staff` | **1 800 s** (30 min) | |
| `TTL.metro.lift` | **7 200 s** (2 h) | A broken lift is a facility fault, not a passing event. |
| `TTL.metro.fare` | **7 200 s** (2 h) | A station is worked for hours, unlike a bus. |
| `TTL.metro.security` | **7 200 s** (2 h) | |
| `TTL.metro.staff` | **7 200 s** (2 h) | |
| `DEFAULT_TTL` | **3 600 s** | Fallback for a type not in the table. |
| `MAX_ACTIVE_PER_REPORTER` | **2** | Live reports one anonymous device may hold at once. |

### Trust model

**Every report is believed.** There is no confirmation tier and no voting. What
signals strength instead is the **head count**: each reporter files their own
record, so the number of records sharing `kind|targetId|type` is the number of
distinct people saying it. The app collapses them into one flag showing that
number (`nReports` in the i18n table).

The remaining controls are blunt and cheap: the cap above, the per-IP rate
limits below, and the fact that every flag expires on its own. A false flag can
be cleared by its author (✕) or by the admin purge — see the README.

### What can be reported

`worker.js` → `REPORT_TYPES` (enforced) and `public/index.html` → `TYPES_BY_KIND` (shown).
**Keep these two in sync** — the server rejects anything the client offers that it doesn't know.

Two **target kinds** (where you are) crossed with two **categories** (what kind of
report it is). `CATEGORY` in both files maps type → category.

| Target kind | Issue types (red) | Operational types (blue) |
|---|---|---|
| `bus` | `breakdown`, `crowded`, `noac` | `fare`, `security`, `staff` |
| `metro` | `lift` | `fare`, `security`, `staff` |

Labels live in the `ti_*` i18n keys (`ti_fare`, `ti_lift`, …) in both languages.
**Colour encodes the category and nothing else** — red for "something is wrong",
blue for "who is present / what is operationally happening". Severity is not
encoded anywhere.

Operational types are deliberately factual and staff-agnostic: they record that an
activity is happening on a line or at a station, never anything about a person. If
you add a type, keep it in that register — and add it to `REPORT_TYPES`,
`TYPES_BY_KIND`, `CATEGORY` (both files), `TTL`, and the `ti_*` labels.

The retired `inspector` type is rejected by the server; the client still maps it to
the *Fare inspection* label so any record filed before v32 renders sensibly for the
couple of hours until it expires.

---

## 3. The stop list and map

`public/index.html` → `CONFIG`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `listStops` | **10** | Hard cap on **rows shown**. Every visible row is guaranteed to have its arrivals loaded. | Display only — cost follows `listPool`. |
| `listPool` | **14** | Stops the server loads arrivals for. Wider than the cap on purpose: the extra four are the candidates promoted when a nearer stop has nothing coming. | **The main cost dial** — one OASA arrivals call per pooled stop per refresh. |
| `imminentMin` | **15 min** | An arrival within this many minutes makes a stop "live" and floats it above dead ones. | Raise it and almost everything counts as live, so the sort stops doing anything. |
| `maxMarkers` | **120** | Stops drawn on the map. Markers are nearly free — no per-stop request. | Raise freely; the map is not what costs money. |
| `maxRows` | **6** | Arrival rows shown per stop. | Display only. |
| `refreshMs` | **30 000 ms** | Foreground refresh interval. **A deadline, not a timer** — see `TICK_MS`. | Doubling it halves your request rate. |
| `TICK_MS` | **250 ms** | How often the app asks whether the refresh deadline has passed. Not a refresh rate and not a cost: it compares two numbers. It exists because a bare `setInterval(load, 30000)` gets throttled on a phone and has no memory of being late, so a deferred tick costs a whole extra period. Under a 3x timer throttle the old shape refreshed every 90 s instead of 30; this one stays within a tick of the deadline. | Raising it makes the refresh that much less punctual. Do not replace it with a long interval. |
| `idleMs` | **45 000 ms** | Refresh interval once idle. |  |
| `idleAfter` | **240 000 ms** (4 min) | No interaction → switch to the idle interval. |  |
| `sleepAfter` | **900 000 ms** (15 min) | No interaction → stop refreshing entirely. |  |
| `walkSpeed` | **80 m/min** | Used for the "🚶 ~4′" walking estimate. |  |
| `detour` | **1.35** | Straight-line distance × this ≈ real walking distance. |  |
| `FAV_MAX` | **6** | Maximum pinned favourite stops (`FAV_KEY = "favStops"`), pinned by double-tap. | Favourites count *within* `listStops`, and always lead the list whether or not a bus is coming. |

**Hide stops with no arrivals** (☰ → Settings, `localStorage.hideEmpty`, off by
default): drops stops with nothing due within `imminentMin` from the list rather
than demoting them. Favourites are exempt.

**Row order:** favourites first, then stops with an arrival within `imminentMin`
by distance, then the rest by distance. A near shelter with nothing coming for
half an hour yields to one 300 m further with a bus in four minutes; if the cap
is full it drops off the list entirely (it stays on the map).

The **search radius** is not a constant — it's the slider in the map view
(200–1000 m, `<input id="radius">`). Widening it adds map markers, not list rows,
so it does not change the number of arrival calls.

---

## 4. Server fan-out and caching

`worker.js`

| Parameter | Default | What it means |
|---|---|---|
| `SCAN.stopRadius` | **600 m** | Radius searched for stops when identifying your bus. |
| `SCAN.stopProbe` | **14** | Stops probed for their route list. **Cost driver.** |
| `SCAN.maxRoutes` | **20** | Routes whose live vehicles are fetched. **Biggest cost driver.** |
| `SCAN.keepM` | **800 m** | Vehicles farther than this are dropped from the response. Trims payload, **not** requests — `getBusLocation` is per route and always returns the whole fleet. Floor is set by `ONBOARD.maxStaleS`. |
| `SCAN.cache` | **10 s** | Edge cache for a scan, on a ~110 m grid, so riders on the same bus share one answer. |
| `LIVE.radius` | **900 m** | Radius for the ☰ → live bus map. |
| `LIVE.stopProbe` | **10** | Stops probed for that map. |
| `LIVE.maxRoutes` | **28** | Routes fetched for that map. |
| `LIVE.cache` | **15 s** | Edge cache for it. |
| `nearby` `limit` | **14** | Stops the server loads arrivals for. Client sends `CONFIG.listPool`. |
| `nearby` `markers` | **60** (client sends 120) | Stops returned for the map. |
| `OASA_CACHE` | **12 s** | Default edge cache for live OASA calls. |
| `GEO_CACHE` | **86 400 s** (1 day) | Geocoding cache. |
| `TIMEOUT_MS` | **8 000 ms** | Upstream request timeout. |
| `STOPLINES_TTL` | **14 days** | How long "this stop serves N lines" is remembered, so dead stops stay hidden. |
| `ACT_TTL` | see source | Per-endpoint cache: 12 s for live data, 1 day for route/stop geometry. |

**Subrequest budget.** Cloudflare allows 50 per request on the free plan. A full
scan is `5 stop-lists + 14 route lookups + 20 vehicle calls = 39`. `/nearby` is
`9 + 10 + 10 + probes ≤ 44`. Raise `maxRoutes` or `stopProbe` much and you will
hit the ceiling.

---

## 5. Rate limits

`worker.js` → the `rateLimit(ip, bucket, limit, windowSec)` calls in the router.
All windows are **60 s**, per IP, per Cloudflare edge location.

| Endpoint | Limit/min |
|---|---|
| `POST /reports` (file a flag) | **8** |
| `POST /reports/delete` | **30** |
| `/scan`, `/live`, `/stops/search`, `/stops/dead` | **30** |
| `/api?nocache=1` | **60** |
| `/push/subscribe`, `/push/test`, `/rules` | **15** |
| `/rules/delete` | **30** |

In-memory and per-isolate, so not globally exact — it blunts one script hammering
one address. For hard guarantees add Cloudflare WAF rate-limiting rules on the zone.

---

## 6. Data retention

| Parameter | File | Default | What it covers |
|---|---|---|---|
| `REPORT_LOG_DAYS` | `worker.js` | **90 days** | D1 `report_log` — the anonymous history (no coordinates, no reporter id). |
| `TRACK.retentionDays` | `worker.js` | **45 days** | D1 `stop_event` — vehicle tracking samples. |
| Active reports | `worker.js` → `TTL` | 15 min – 2 h | Deleted on expiry, coordinates included. |

**These numbers are quoted in `PRIVACY.md`.** Change one, change the other, or
your privacy policy becomes false.

---

## 7. Alerts, tracking and the cron

| Parameter | File | Default | What it means |
|---|---|---|---|
| `crons` | `wrangler.toml` | see file | When the Worker wakes to check alerts. Narrow it with `GET /alerts/windows?token=…`. |
| `TRACK.snapM` | `worker.js` | **150 m** | How close a vehicle must be to count as "at" a stop. |
| `TRACK.maxRoutes` | `worker.js` | **8** | Tracked routes, capped to stay inside free-tier KV writes. |
| `TRACK.minGapS` | `worker.js` | **45 s** | Debounce for re-triggering the same stop event. |
| `TRACK.bunchMin` | `worker.js` | **2 min** | Gap at or below this counts as bunching. |
| `TRACK.gapFactor` | `worker.js` | **2.5×** | Gap at or above this × the median counts as missing service. |

---

## 8. Gestures and UI feel

`public/index.html` → `SWIPE`

| Parameter | Default | What it means |
|---|---|---|
| `minX` | **52 px** | Horizontal travel that commits to a tab change. |
| `hlock` | **12 px** | Sideways travel that locks the gesture as horizontal. |
| `vert` | **1.5** | `dy` must beat `dx` by this much to be treated as a scroll instead. |
| `dead` | **8 px** | Dead zone before any axis decision. |
| `slope` | **0.8** | Max `dy/dx` for a swipe to still count. |
| `maxMs` | **900 ms** | Slower than this isn't a swipe. |
| `edge` | **34 px** | On the map, only a swipe starting this close to the left edge counts; the rest pans the map. |

`public/index.html` → `DTAP` (double-tap = pin a favourite)

| Parameter | Default | What it means |
|---|---|---|
| `ms` | **320 ms** | Longest gap between the two taps. |
| `slop` | **24 px** | How far apart the two taps may land and still count. |

### The route preview and the drawn route

| Parameter | Default | Where | What it means |
|---|---|---|---|
| `CONFIG.onward` | **9** | route preview | How many stops ahead of your boarding stop get numbered markers and a row in the strip underneath. It no longer limits the **highlight**, which always runs to the terminus; raise it and the map gets busier, not longer. |

Only one route is ever drawn on the main map. Its geometry is cached per route
code for the session (`rline.cache`), so re-picking a line you have already looked
at costs nothing.

### Timings not in a constant

| Parameter | Default | What it means |
|---|---|---|
| `.slide-l/.slide-r` | **0.3 s** | Tab transition duration (CSS). Changing it changes only how long the motion takes; how *smooth* it is depends on whether the incoming tab still has work to do, which is what `warmMap` exists to prevent. |
| `onLongPress` | **430 ms** | Hold before a preview opens. Previews only; pinning is double-tap. |

`public/index.html` → `REPMAP`

| Parameter | Default | What it means |
|---|---|---|
| `labelZoom` | **15** | Below this zoom the permanent labels on the live-reports map are hidden — a dozen of them overlap into noise at city scale. The pin and its count badge stay; tap a pin for the popup. |

### Freshness stamp and the guide

| Parameter | Default | Where | What it means |
|---|---|---|---|
| freshness tick | **20 000 ms** | `startFreshTicker` | How often the "40s ago" text is repainted. It only rewrites a string, so this is cheap, but there is no point going below the resolution of the text itself. |
| "just now" window | **15 s** | `paintFresh` | Under this, it reads "just now" instead of a number. |
| seconds/minutes switch | **90 s** | `paintFresh` | Above this it counts in minutes. |
| stale threshold | **150 s** | `paintFresh` | The stamp turns red past this: five missed refreshes, so the arrivals on screen are no longer trustworthy. |
| tour delay | **700 ms** | `maybeTour` | Wait after load before the guide opens on a fresh install, so it appears over a painted list rather than an empty screen. |

The guide's four cards live in the `TOUR` array in `public/index.html`; add or remove
entries and the dots follow. Seen-state is `localStorage.tourSeen`.

---

## What actually costs money

Cloudflare's free tier gives 100 000 requests/day and **1 000 KV writes/day** — the
KV write ceiling is what breaks first, and only reports write to KV.

Per list refresh (every `refreshMs`): **1** request to `/nearby`, which fans out to
about 30 OASA subrequests. Subrequests are free; the one browser request is what
counts. So the levers, in order:

1. **`CONFIG.refreshMs`** — doubling it halves everything.
2. **`CONFIG.listPool`** — one arrivals lookup per pooled stop per refresh.
   (`listStops` only decides how many of those you *see*.)
3. **`SCAN.maxRoutes` / `SCAN.stopProbe`** — only on the report flow, but the
   heaviest single operation in the app.
4. **`SCAN.cache` / `LIVE.cache` / `ACT_TTL`** — edge caching, so riders standing
   together share one answer. Raising these is nearly free accuracy-wise for
   anything but live positions.

Radii (`keepM`, `gateM`, `stopRadius`, the slider) change **what is shown**, not
what is fetched. Tightening them makes the app tidier and the payloads smaller; it
does not reduce your request count.

Check where you actually stand:

```bash
curl "https://<your-url>/health?token=$ADMIN_TOKEN"
```
