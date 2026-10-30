# Tunable parameters

Every arbitrary number in the app, in one place, with where it lives and what
breaks if you change it. Values here are the **v111 defaults** — if you edit the
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
| `TTL.bus.crowded` | **3 600 s** (1 h) | A crowded vehicle stays crowded for its run. |
| `TTL.bus.noac` | **3 600 s** (1 h) | Lasts the trip. |
| `TTL.bus.security` | **1 800 s** (30 min) | |
| `TTL.bus.staff` | **1 800 s** (30 min) | Staff ride a few stops and get off. |
| `TTL.metro.lift` | **7 200 s** (2 h) | A broken lift is a facility fault, not a passing event. |
| `TTL.metro.escalator` | **7 200 s** (2 h) | Same reasoning as the lift. |
| `TTL.metro.nowheel` | **10 800 s** (3 h) | The longest of the lot: a station with no step-free route is a fact about the building, not about this morning. |
| `TTL.metro.crowded` | **1 800 s** (30 min) | A platform clears in minutes; a bus does not. |
| `TTL.metro.security` | **7 200 s** (2 h) | |
| `TTL.metro.staff` | **7 200 s** (2 h) | A station is worked for hours, unlike a bus. |
| `DEFAULT_TTL` | **3 600 s** | Fallback for a type not in the table — including the retired `fare` and `inspector`, so rows already in KV age out instead of living forever. |
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

Two **target kinds** — where you are. `bus` covers every surface vehicle, bus and
trolley alike; `metro` covers stations.

| Target kind | Types |
|---|---|
| `bus` | `breakdown`, `crowded`, `noac`, `security`, `staff` |
| `metro` | `lift`, `escalator`, `nowheel`, `crowded`, `security`, `staff` |

Labels live in the `ti_*` i18n keys (`ti_escalator`, `ti_nowheel`, …) in both
languages.

**There are no categories.** Since v44 every flag is one colour — `--flag`, a
single token in the stylesheet — and carries its meaning in the word printed on
it rather than in a palette the reader has to decode first. Shape still
distinguishes a vehicle (square) from a station (diamond); severity is not
encoded anywhere, and neither is anything else.

Entries stay factual and staff-agnostic: they record that a situation exists on a
line or at a station, never anything about a person. If you add a type, keep it in
that register — and add it to `REPORT_TYPES` (`worker.js`), `TYPES_BY_KIND`
(`index.html`), `TTL`, and the `ti_*` labels in **both** languages. `test/reports.mjs`
fails if any of those four fall out of step.

Retired types are rejected by the server but still carry a label in the client, so
a record filed before the deploy renders as words rather than as its own key for
the hour or two until it expires: `inspector` (dropped in v32) and `fare` (dropped
in v44) both read as *OASA staff*.

---

## 3. The stop list and map

`public/index.html` → `CONFIG`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `listStops` | **10** | Hard cap on **rows shown**. Every visible row is guaranteed to have its arrivals loaded. | Display only — cost follows `listPool`. |
| `listPool` | **11** | Stops the server loads arrivals for. Wider than the cap on purpose: the extra one is the candidate promoted when a nearer stop has nothing coming. | **The main cost dial** — one OASA arrivals call per pooled stop per refresh. |
| `imminentMin` | **15 min** | An arrival within this many minutes makes a stop "live" and floats it above dead ones. | Raise it and almost everything counts as live, so the sort stops doing anything. |
| `maxMarkers` | **120** | Stops drawn on the map. Markers are nearly free — no per-stop request. | Raise freely; the map is not what costs money. |
| `maxRows` | **6** | Arrival rows shown per stop. | Display only. |
| `refreshMs` | **45 000 ms** | Foreground refresh interval for the middle tier. **A deadline, not a timer** — see `TICK_MS`. | Doubling it halves your request rate. |
| `hotMin` / `hotMs` | **6 min** / **25 000 ms** | When the nearest bus on screen is within `hotMin`, ask this often instead. | This is the tier that decides whether the app is right when it matters. Below ~20 s you are paying for precision nobody can act on. |
| `calmMin` / `calmMs` | **15 min** / **90 000 ms** | When nothing on screen is within `calmMin`, ask this often instead. | The saving that pays for the tier above. Nothing on such a board can change in a way a rider cares about inside 90 s. |
| `trustS` | **150 s** | How old the board may get before the freshness chip turns red. Matches `ALERT_STALE_S` in the Worker: past this, subtracting the clock from a fetched minute has stopped being a fair guess. | |
| `manualGapMs` | **5 000 ms** | Minimum gap between two taps on the freshness chip. | A tap-to-refresh with no floor is a request storm with a finger on it. |
| `TICK_MS` | **250 ms** | How often the app asks whether the refresh deadline has passed. Not a refresh rate and not a cost: it compares two numbers. It exists because a bare `setInterval(load, 30000)` gets throttled on a phone and has no memory of being late, so a deferred tick costs a whole extra period. Under a 3x timer throttle the old shape refreshed every 90 s instead of 30; this one stays within a tick of the deadline. | Raising it makes the refresh that much less punctual. Do not replace it with a long interval. |
| `idleMs` | **75 000 ms** | Refresh interval once idle. Wins over all three tiers above: a screen nobody has touched for four minutes is not a screen anybody is timing a bus on. |  |
| `idleAfter` | **240 000 ms** (4 min) | No interaction → switch to the idle interval. |  |
| `sleepAfter` | **900 000 ms** (15 min) | No interaction → stop refreshing entirely. |  |
| `walkSpeed` | **80 m/min** | Used for the "🚶 ~4′" walking estimate. |  |
| `detour` | **1.35** | Straight-line distance × this ≈ real walking distance. |  |
| `FAV_MAX` | **6** | Maximum pinned favourite stops (`FAV_KEY = "favStops"`), pinned from the long-press menu. | Favourites count *within* `listStops`, and always lead the list whether or not a bus is coming. |

`worker.js` → `ALERT_MAX_STOPS`: **10**. Distinct stops the alert cron fetches in one
minute, tightest lead first (a 3-minute alert has one chance; a 15-minute one has twelve).

The number is the subrequest budget, not a preference. A Worker invocation gets **50
subrequests** on the free plan, and Workers KV counts toward them as well as `fetch`. A
cron minute spends roughly:

| | subrequests |
|---|---|
| fixed | ~5 — two rules reads, the heartbeat batch, the usage batch |
| per stop | 2 — arrivals, plus the line lookup when a route code misses |
| per firing | ~7 — one KV get per lead, the subscription, the push, the meta batch, one KV put per lead |

Ten stops with two alerts firing is `5 + 20 + 14 = 39`. Twenty stops with three firings is
`66` — over the cap, and **going over throws**, which before v74 was a silent total
failure. Raise this with the plan, not before.

`worker.js` → the alert fetch, three steps:

| Parameter | Default | What it means |
|---|---|---|
| `ALERT_ARRIVALS_TTL` | **45 s** | The alert path shares the rider path's edge entry instead of bypassing it (`0`). At a stop somebody is watching, the alert costs OASA nothing. |
| `ALERT_FETCH.timeoutMs` | **9 000 ms** | Longer than a rider's 8 s: the cron has a whole minute and nobody watching, and its failure costs the bus. |
| `ALERT_FETCH.tries` | **2** | With a 300 ms pause. Since v110 a second try is only made when the first **failed fast** (a dropped connection) — never after a timeout, which is the same request into the same slow upstream, and never after the runtime's own "too many subrequests". |
| `ALERT_STOP_SUBREQUESTS` | **4** | What one stop can cost the way the runtime counts: arrivals and their stamp (or the stale read), the line lookup, one push. A stop is only started if the run's meter has this much left; otherwise it is recorded as `NOT REACHED — … subrequests`. |
| `SWEEP_SUBREQUESTS` | **44** | The meter for a sweep in an invocation of its own (`/alerts/run`, the cron), shared with the tracking that follows it. Below 50 to leave room for fast-fail retries. |
| `PIGGYBACK_SUBREQUESTS` | **40** | The meter for a sweep riding on a rider's light request (see `LIGHT_PATH`): the host's own few calls fit beside it. |
| `ALERT_STALE_S` | **150 s** | How old a stamped copy may be before the fallback refuses it. Minutes are aged by the elapsed time; the correction assumes the bus kept moving as predicted, and that assumption decays. |
| `ALERT_DEADLINE_MS` | **25 000 ms** | Stop *starting* new stop fetches past this point in a run, so one unreachable stop cannot eat the minute. |

The alert path is exempt from the upstream circuit breaker
(`ALERT_FETCH = { ignoreCircuit: true }`) — one call per stop per minute is not the load
the breaker exists to shed, and being refused by it loses the bus.

### The first ten seconds

`public/index.html`

| Parameter | Default | What it means |
|---|---|---|
| `POS_FRESH_MS` | **12 h** | How old a remembered fix may be and still be worth booting from. Was 15 minutes, which meant every morning opened on Syntagma. A remembered position is replaced the instant a real fix lands, so a long window costs nothing and a short one costs the wrong neighbourhood. |
| `GPS_FIRST_WAIT_MS` | **2 500 ms** | With nothing remembered, how long the board waits for the radio before showing a guess. Long enough for a warm fix, short enough that nobody thinks the app has hung — and it saves the doomed first request. |
| `fillVisibleArrivals` retry | **2 500 ms** | One quick second attempt at any stop whose arrivals failed, rather than waiting out a whole refresh interval. Once only; past that it is not a blip. |

`npm run sim:boot` replays this window in a real browser. `GPS_DELAY_MS` and
`LASTPOS_AGE_MIN` set the conditions.

### The upstream status bar

`public/index.html` → `SYS_SNOOZE_MS`: **15 min**. How long dismissing the status strip
keeps that particular reason quiet. Dismissal is per reason (`down` / `busy` / `stale`),
never global — a different fault still gets to speak, and the same one speaks again after
the snooze because "still broken" is news again by then. A successful sweep clears it
outright.

`worker.js` → `upstreamState()` turns the circuit breaker's last recorded failure into one
of those three words. `HTTP 429` and `HTTP 5xx` mean OASA answered and refused, so `busy`;
anything else while the circuit is open means it did not answer at all, so `down`. It is
attached to every `/nearby` response, not just the 503 path.

`worker.js` → `SELF_POKE_COOLDOWN_MS`: **30 min**. After the cron's self-call fails (this
zone answers `HTTP 522` — a Worker reaching its own hostname is not guaranteed to work),
it stops trying for this long and runs the alerts in-process instead. Finding out costs a
subrequest and eight seconds of a minute that has alerts to send.

### Why the board no longer freezes between sweeps

A refresh is `refreshMs` (45 s), or `idleMs` (75 s) if you have not touched the screen,
and arrivals are shared through a **50-second edge cache**. Those stack: a rider could be
looking at a number that was true 95 seconds ago, and it did not move in between — a bus
shown as "4 min" sat there saying four until the next fetch landed, by which time it had
gone. Two changes, neither of which costs a request:

- **The Worker takes its own cache age out of the minutes** before sending them
  (`getJSONAged` reads the response's `Age` header; `ageArrivals` subtracts it and drops
  anything the correction puts in the past). So `generated` is honest again.
- **The client counts down from `generated`.** `etaOf(a)` is `a.min` minus the elapsed
  minutes, `stillDue(a)` drops a bus more than a minute past due, and the 250 ms tick
  repaints only when the displayed minute actually changes — once a minute, not four
  times a second.

The alert path shares both: a three-minute lead has no room for a fifty-second-old
"3 minutes".

`public/index.html` → `WIN_BACK` / `WIN_AHEAD`: **5** and **30** minutes. The window a
new alert opens on, measured from the clock — `now − 5 → now + 30`. It used to be a
hard-coded 08:30–08:50, which is somebody else's commute; you set an alert because of the
bus you are waiting for now. Editing an existing alert keeps its own times.

**Hide stops with no arrivals** (☰ → Settings, which ☰ opens directly, `localStorage.hideEmpty`, off by
default): drops stops with nothing due within `imminentMin` from the list rather
than demoting them. Favourites are exempt.

**Row order:** favourites first, then stops with an arrival within `imminentMin`
by distance, then the rest by distance. A near shelter with nothing coming for
half an hour yields to one 300 m further with a bus in four minutes; if the cap
is full it drops off the list entirely (it stays on the map).

The **search radius** is not a constant — it's the slider in the map view
(200–1000 m, `<input id="radius">`), **`CONFIG.radiusDefault`, 250 m since v107**, and it is **not remembered between launches**. Widening
it adds map markers, not list rows, so it does not change the number of arrival
calls — `listPool` caps those at 11 whatever the slider says.

What it *does* change is stop discovery. `samplePts` queries one point at 400 m
or below, five up to 650 m, and nine above — so the old 600 m default cost
**five** `getClosestStops` calls per sweep where 300 m costs **one**. Those are
cached for hours, so this was never the expensive half; it is simply five times
less of it, and a shorter board is the better one to read. A rider who wants the wider net still has the slider,
for that trip. It used to be saved and restored, which is how one afternoon
spent hunting a stop across the neighbourhood left the app at 950 m every
morning afterwards — a board full of stops nobody was going to walk to, built
with five discovery calls a sweep. It is a this-trip setting, not a
preference, so nothing writes it any more and an old stored value is deleted
on launch rather than ignored.

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
| `LIVE.radius` | **900 m** | Radius for the live bus map (the orange dot). |
| `LIVE.stopProbe` | **10** | Stops probed for that map. |
| `LIVE.maxRoutes` | **28** | Routes fetched for that map. |
| `LIVE.cache` | **15 s** | Edge cache for it. |
| `nearby` `limit` | **14** | Stops the server loads arrivals for. Client sends `CONFIG.listPool`. |
| `nearby` `markers` | **60** (client sends 120) | Stops returned for the map. |
| `OASA_CACHE` | **12 s** | Default edge cache for live OASA calls. |
| `GEO_CACHE` | **86 400 s** (1 day) | Geocoding cache. |
| `TIMEOUT_MS` | **8 000 ms** | Upstream request timeout. Not retried after it fires (v110): it used to be two 8 s waits. |
| `STOPLINES_TTL` | **14 days** | How long "this stop serves N lines" is remembered, so dead stops stay hidden. Only **dead** stops are shared through KV since v110; live ones are kept in the isolate, because their route list is in the edge cache for a day anyway. |
| `STOPLINES_SAVE_MS` | **5 min** | Least time between two writes of the dead-stop index from one isolate, and it is only written when the dead list changed. It used to be rewritten whole on every board — ~4 ms of CPU at 8,000 stops and a KV write each time. |
| `NEARBY_FANOUT` | **38** | OASA calls a board plans for, probes for dead map stops included. Only the probes give way. |
| `NEARBY_CEILING` | **44** | What a board cannot do without — stop lists, the list's lines and arrivals, far favourites — never exceeds this. Favourites past it are trimmed (the app sends at most six, which fit at any radius). With the board's own four cache calls, the most it can ask for is 48 of 50. |
| `ACT_TTL` | see source | Per-endpoint cache: 12 s for live data, 1 day for route/stop geometry. |

**Subrequest budget.** Cloudflare allows 50 per request on the free plan, and **the Cache
API counts against the same 50 as `fetch`** — every `cache.match` and `cache.put` is one.
Anything left running in `waitUntil` spends the same budget as the answer did. A full
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
| `/geocode` (address search) | **40** — generous for someone typing, and the only limit standing between one abusive client and the ORS daily quota |
| `POST /pulse` (the open counter) | **20** — a real client sends one per cold boot |
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

`public/index.html` → `TAP_GUARD`

| Parameter | Default | What it means |
|---|---|---|
| `TAP_GUARD` | **440 ms** | How long a freshly opened map popup ignores clicks, so the tail of the gesture that opened it cannot land on a line chip and draw a route. All that is left of the old double-tap window: pinning is the long-press menu now. |

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
| `onLongPress` | **430 ms** | Hold before the stop menu (or, on an arrival row, the route preview) opens. On a mouse the press still ends in a click, which the helper swallows in the capture phase so the held element's own handler does not fire behind the menu. |

`public/index.html` → `REPMAP`

| Parameter | Default | What it means |
|---|---|---|
| `labelZoom` | **15** | Below this zoom the permanent labels on the live-reports map are hidden — a dozen of them overlap into noise at city scale. The pin and its count badge stay; tap a pin for the popup. |

### Favourites in the sweep

`/nearby` accepts `favs=<code,code,…>`, capped at **8** server-side, and returns a
`favs[]` array holding any of them the sweep did not already cover. Each costs up to
two OASA subrequests, which is charged against the same 44-subrequest budget that
governs stop probing — so a long favourites list eats probe budget rather than
risking the 50-subrequest ceiling.

`FAV_MAX` (6) is what the client will ever pin, so the server cap is slack.

### Following you while you walk

`public/index.html` → `GEO`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `accGate` | **120 m** | A fix reported worse than this is treated as noise, not a position — unless nothing better has ever arrived. | Raise it and a bad fix in a street canyon teleports the list. |
| `moveM` | **25 m** | How far you must move before the app accepts that you moved. | Lower and the list churns while you stand still; higher and it lags behind a walk. |
| `refetchM` | **150 m** | Drift from where the current stop list was fetched before a new one is worth requesting. | **The cost dial.** Moving inside this radius is free: distances and order are recomputed locally. |
| `minFetchMs` | **15 000 ms** | Floor between position-driven refetches, however fast you are moving. | Stops a bus ride from firing a request every few seconds. |
| `maxAgeMs` | **10 000 ms** | Oldest cached fix the watch will accept as "now". | |

The watch runs only while the location is GPS-derived and the app is awake and
visible; choosing a place by hand stops it, and `showSleep` / `visibilitychange`
release it so it is not draining anything in a pocket.

### Freshness stamp and the guide

| Parameter | Default | Where | What it means |
|---|---|---|---|
| freshness tick | **20 000 ms** | `startFreshTicker` | How often the "40s ago" text is repainted. It only rewrites a string, so this is cheap, but there is no point going below the resolution of the text itself. |
| "just now" window | **15 s** | `paintFresh` | Under this, it reads "just now" instead of a number. |
| seconds/minutes switch | **90 s** | `paintFresh` | Above this it counts in minutes. |
| stale threshold | **150 s** | `paintFresh` | The stamp turns red past this: five missed refreshes, so the arrivals on screen are no longer trustworthy. |
| tour delay | **700 ms** | `maybeTour` | Wait after load before the guide opens on a fresh install, so it appears over a painted list rather than an empty screen. |

The guide's six cards live in the `TOUR` array in `public/index.html`; add or remove
entries and the dots follow. Seen-state is `localStorage.tourSeen`, which holds
`TOUR_VER` (**"2"**) rather than a flag — raise it to show a changed carousel once more.
Nothing in the app reopens the tour; the FAQ is the second reading.

---

## 9. Journey planning

`worker.js` → `PLAN`.

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `walkSpeed` | **80 m/min** | Same figure the arrival list walks with. | Keep the two equal or the app contradicts itself. |
| `detour` | **1.35** | Straight line × this = street distance. | |
| `maxWalkM` | **1100 m** | Furthest one walking leg will ever propose. | Raising it finds more routes and proposes longer walks. |
| `accessM` | **750 m** | Radius for candidate boarding / alighting stops. | |
| `maxAccess` | **5** | Candidate stops per end. **Subrequest budget** — one `webRoutesForStop` each. | |
| `maxRoutes` | **20** | Route stop-lists fetched. **Subrequest budget** — one `webGetStops` each. | The main cost dial; also the main quality dial. |
| `transferM` | **300 m** | Stop-to-stop walk that counts as an interchange. | |
| `liveHorizonMin` | **35 min** | Past this no vehicle has been dispatched, so waits fall back to headway and the leg is flagged `scheduled`. | Should match how far ahead OASA's arrivals actually reach. |
| `changePenaltyMin` | **8** | Search weight for the "fewer changes" alternative. Never added to a reported time. | |
| `interchangeMin` | **2 min** | Platform to platform inside one metro station. | |
| `busDwellS` | **20 s** | Per intermediate stop on a bus leg. | |
| `roadFactor` | **1.25** | Straight line between stops × this = road distance. | |
| `walkOnlyMaxMin` | **40 min** | Longest journey offered on foot alone. | |
| `walkKeepSlackMin` | **10 min** | How much slower than riding a walk-only option may be and still keep one of the three slots. Beyond it the option is dropped: a 38-minute walk against a 15-minute ride is padding, and it pushes a real second route off the list. | Raise it and walking crowds the list; lower it and "riding is a bit quicker but I'd rather walk" stops being offered. |
| `maxRefine` | **3** | Live-ETA lookups spent improving the chosen itinerary. **Subrequest budget.** | |
| `maxSchedules` | **3** | Published-timetable fetches per plan, two subrequests each. **Subrequest budget.** | Lower it and more far connections fall back to `estimated`. |
| `maxWalkRoutes` | **4** | Pedestrian routings per plan, one each, and only when `ORS_KEY` is set. **Subrequest budget.** | Lower it and the later walking legs stay estimated. |

### Frequencies and speeds

| Table | What it is |
|---|---|
| `HEADWAY_METRO` | Minutes between trains by day type (`wd`/`sat`/`sun`) over bands of the day. Published STASY service patterns rounded to something defensible, **not a timetable**. |
| `METRO_LINE_FACTOR` | **1.3** for line 1 (ISAP), 1 for lines 2 and 3. ISAP runs longer headways all day. |
| `AIRPORT_HEADWAY_MIN` | **36 min**. Only some line 3 trains continue past Doukissis Plakentias, so crossing onto the branch is charged this rather than the city headway. |
| `HEADWAY_BUS` | The weakest table here: ~300 lines with nothing alike about their frequencies. Used **only** where no live ETA exists. |
| `BUS_SPEED` | km/h including stops, by day type and hour. Traffic dominates any bus estimate, which is why it is a curve and not a constant. |
| `METRO_SPEED_KMH` | 34 urban, 30 ISAP, 62 on the airport branch. |
| `METRO_SERVICE` / `BUS_SERVICE` | Service windows in minutes from midnight. Lines 2 and 3 run to ~02:00 on Friday and Saturday nights. |

The station order per line is `METRO_LINES` in `worker.js`. **Adjacency comes from
those sequences, never from the order of `METRO_STATIONS`**, which is grouped by the
line that "owns" each station — so the interchanges sit in someone else's block.

### The usage counter

`worker.js` → `USAGE_KINDS`, `bumpUsage`, `readUsage`; `public/index.html` → `pulse()`.

There is nothing to tune, which is the point. One D1 row per day per kind holding an
integer, and three kinds: `open`, `open_app` (of those, launched from a home-screen icon)
and `install` (the browser's `appinstalled` event).

**No identifier of any sort is stored** — no IP, no device token, no user agent, no
session, nothing hashed. The counter therefore cannot distinguish people, and is not meant
to: it answers "is anyone using this, and is it growing". `test/usage.mjs` inspects every
statement it issues and fails if anything identifying appears.

Days are **Athens calendar days**, not UTC, so a night bus at 01:00 lands where a person
in Athens would put it.

Read it at `/health?token=` (headline) or `/stats/usage?token=&days=N` (the series, N
clamped to 1–365). Without a D1 binding the beacon is accepted and dropped and the
endpoint returns 501 rather than pretending zero.

### Home and Work

`public/index.html` → `SLOTS`. Two of them, stored under `slot:home` / `slot:work` in
`localStorage` as `{lat, lng, label}`. Nothing about them reaches the server. Set by
picking a place while the picker is armed; cleared by long-press, the same gesture that
unpins a favourite.

### Suggestion deduping

Rows in the journey picker are keyed on **position at 4 decimal places** (~11 m), not on
name: three sources name one corner three different ways, so a name-based key misses the
duplicates that matter. Eleven metres fuses a station with the geocoded point on top of
it and still separates adjacent house numbers.

Rows whose `kind` is `me` or `slot` are exempt — they are anchors you named, not results,
and suppressing a stop because you are standing on it would remove it as a destination.

Stops from the stop index are grouped by **name and walking distance** instead (see
*Searching stops by name* below): one name is usually several stops, and position alone
would list ΣΥΝΤΑΓΜΑ eight times.

### The splash

`public/index.html` → `SPLASH`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `minMs` | **420 ms** | Shortest the mark is ever on screen. | Below this a warm cache makes it strobe. |
| `maxMs` | **2 200 ms** | Longest, whatever the network is doing. | This is the promise that a dead network cannot trap anyone on a logo. |

The header carries the wordmark alone; the graphic mark appears on the splash, on the
last tour card and in the launcher icons, and all three draw the same `.mark` rules —
OASA on a black block, struck by a near-horizontal white rule and a steeper one crossing
it. Everything about those rules is in em, so `.splash .mark` sets a font size and nothing
else. The splash is painted from markup rather than added by script, so it is up in the
first frame instead of after a white flash. The first-run carousel waits for it to clear
before opening.

### Not being blocked by OASA

`worker.js` → `CIRCUIT`, `ACT_TTL`, `STALE_KEEP`; `public/index.html` → `CONFIG`

OASA's telematics API has no key and no documented limits, and it blocks by address
range. Everything your riders ask for reaches it from a handful of Cloudflare addresses,
so it sees one client, not a thousand people. Live arrivals are the only call not cached
for an hour or a day, which makes them the whole of the upstream load.

| Parameter | Was | Now | Why |
|---|---|---|---|
| `CONFIG.refreshMs` | 30 s | **45 s** | Sweeps per rider per minute. A countdown in whole minutes barely moves in fifteen seconds. |
| `CONFIG.listPool` | 14 | **11** | Stops that get an arrivals call per sweep. |
| `ACT_TTL.getStopArrivals` | 12 s | **90 s** | Above the refresh interval on purpose, so two people at the same stop cost one call rather than two. Raised from 50 in v98, and only safe because of v79: the age of a cached answer is subtracted from the minutes before anyone sees them, so a 90-second cache shows the same countdown a 50-second one did. |
| `ALERT_ARRIVALS_TTL` | — | **45 s** | The alert path keeps the shorter cache. It is ten stops a minute for the whole service, so its upstream cost is a rounding error, and a three-minute lead is where staleness actually hurts. |
| `UPSTREAM_BUDGET.perMin` | — | **150** | A hard ceiling on **live** calls to OASA per minute, per isolate. Past it, riders get the corner's last good board instead of the service getting blocked. Reference data (stop lists, route lists — anything cached past `LIVE_TTL_MAX`) is not counted: the edge answers it, and holding it back is what turned a busy minute into a 503 until v110. Nor is a live call this isolate made within its cache lifetime (`edgeHeld`): the edge has it, so it costs OASA nothing. |
| `LIVE_TTL_MAX` | — | **300 s** | Where "live" ends. A call cached this long or less is news and goes through the breaker and the budget; one cached longer is reference data and does not. |
| `OPEN_FUSE_MS` | — | **2 500 ms** | While the breaker is open, a reference-data miss (or a live call the edge should still hold) gets one try this long instead of the usual 8 s, because the origin it would reach is known to be failing. |
| `API_KEEP_S` | — | **7 days** | How long `/api` keeps its last answer for reference data, to serve when OASA fails. Live answers are kept `STALE_KEEP`. |
| `CIRCUIT.openAfter` | — | **6** | Consecutive upstream failures before the Worker stops calling. |
| `CIRCUIT.openMs` | — | **120 s** | How long it stays shut, after which one request is let through to look. |
| `STALE_KEEP` | — | **900 s** | How long a good sweep stays worth showing once the upstream goes quiet. |

Together the first three take one rider with the app open from roughly **28 upstream calls
a minute to about 6**. Tune them back if OASA ever stops minding.

#### The budget, and why a cap matters more than a smaller number

Every number above reduces load *per rider*. None of them changes the shape of the
problem, which is that load is **O(riders) and unbounded** — each new rider at a new
corner adds arrivals calls and nothing in the system says no. That is what got this Worker
blocked: not a bug, just arithmetic nobody had capped.

`UPSTREAM_BUDGET` inverts the failure mode. Past the ceiling, `getJSONAged` returns
nothing and the caller falls back to cache and stale — riders get slightly older numbers
instead of the service getting blocked, which is a trade worth making at any user count.
A cache hit **gives its token back** (`budgetRefund`, driven by the response's `Age`
header), because the budget measures what we ask of OASA, not what we serve.

**Until v110 that promise was not kept.** The budget — and the breaker — refused *every*
OASA call past the ceiling, including stop lists and route lists sitting in the edge
cache, and no caller fell back to anything: a board whose stop lists were refused had
nothing to show and answered 503. Replayed with OASA healthy, that was 6 riders in 20 a
minute, and 26 in 40. Both gates now apply to live calls only (`LIVE_TTL_MAX`), let
through a live answer the edge still holds (`edgeHeld`), and a board whose arrivals were
all held back is served from the corner's last good board. See README → *Why the board
answered 503*.

Two honest limitations:

- **It counts per isolate, not globally.** Workers run in many places at once and there is
  no shared counter without a Durable Object. It is worth having anyway, because the
  traffic that matters concentrates in the colo nearest Athens — one isolate doing most of
  the asking. Read it as a governor, not a guarantee.
- **The alert path is exempt**, by the same reasoning that exempts it from the circuit:
  ten calls a minute cannot be the problem, and shedding them costs a rider the bus.

`/health?token=…` reports `budget` alongside `upstream`, so "are we about to become the
reason OASA stops answering" is a question you can ask *before* the answer is yes.

**`cachedShare` is the number that matters.** The whole upstream-load story rests on the
edge cache actually being hit, and until v98 that was an assumption rather than a
measurement. A low share while riders are active means the cache is not doing its job and
the real upstream load is the raw call count. `hitsCarryingAge` is the share of those hits
that also carried an `Age` header — which is what the countdown correction needs, and what
the budget refund used to depend on entirely. A cache hit is now recognised by `Age`
**or** `CF-Cache-Status`, because neither is guaranteed alone and refunding on `Age` by
itself meant a missing header would charge every cache hit to the budget.

**…and until v99 you could not read it.** The counters live in one isolate's memory, and
Cloudflare starts and discards isolates constantly — a checkup is a rare outside request,
so it nearly always landed on a cold isolate that had served nothing. A working app
therefore reported "no cache figures", which reads exactly like a fault. It was not one:
the measurement was scoped to the wrong thing. Since v99 each isolate appends its own
deltas to a small D1 table every `BUDGET_FLUSH_MS` (5 minutes), and `/health` reports the
rolling 24-hour totals as `budget.last24h` beside the instantaneous per-isolate ones.

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `BUDGET_FLUSH_MS` | **5 min** | How often an isolate writes its cache counters down. | One D1 row per isolate per flush — a few hundred a day against a 100,000 free allowance. Lower it and the figures are fresher and the writes more numerous; raise it and a short-lived isolate can be discarded before it ever flushes, losing its counts. |

The write is an `INSERT`, never a read-modify-write, precisely so two isolates flushing at
the same instant cannot lose each other's counts. Rows are pruned after 7 days by the
nightly maintenance pass; only the last 24 hours is ever read.

The circuit matters more than the numbers. Without it, an upstream that stops answering
turns every rider request into a dozen calls that each wait 8 s and retry — the moment
OASA is least able to cope is the moment it gets hit hardest, and every rider waits 16 s
to be told nothing. A client that backs off when refused is the difference between a rate
limit and a ban. `/health?token=…` reports the circuit under `upstream`.

### Address search

`public/index.html` → `JPQ`, and `worker.js` → the geocoding block.

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `JPQ.minChars` | **3** | Characters before an address request goes out. Stops, favourites and metro stations match locally from the first character and cost nothing. | Lowering it to 2 roughly doubles the requests for very little extra reach. |
| `JPQ.debounceMs` | **260 ms** | Quiet time after the last keystroke before asking. | The single biggest dial on ORS quota consumption. |
| `JPQ.minGapMs` | **700 ms** | Floor between two address requests, on top of the debounce. A request that arrives inside the gap waits it out, and a newer keystroke supersedes it before it is ever sent. | Without it, someone typing steadily at just over `debounceMs` fires one request per keystroke — measured at **7** for a nine-letter street, **5** with it. |
| `JPQ.memo` | **40** | Queries answered this session, kept in memory. Backspacing walks back through them and costs nothing: measured **0** requests to retype four characters just deleted. | |
| `ORS_LAYERS` | `address,venue,street,neighbourhood,borough,locality,localadmin` | Pelias layers kept. Regions and countries are excluded — you cannot walk to "Greece". | |
| `ATTICA` | 23.40–24.10 E, 37.70–38.40 N | Bounding box on results. Same window as `VIEWBOX`, spelled as corners because Pelias wants corners. | |
| focus rounding | **2 dp** (~1 km) | Precision of the position sent as `focus.point`. | It only nudges the ranking, so more precision buys nothing and costs cache hits. |
| `GEO_CACHE` | **86 400 s** (24 h) | Edge-cache lifetime for a geocode answer, ORS and Nominatim alike. | |
| `HOUSE_NO` | `\d{1,3}` + optional range/letter, standalone (a comma after it counts: "40, Χαλάνδρι") | What makes a query "an address" rather than a name, which decides `/geocode/search` over `/geocode/autocomplete`. Also requires three letters somewhere, so a line number is not an address. It is also where the query splits: the street before it, the area after. | Widen it and postcodes start routing to the address parser, which answers worse for them. |
| `STREET_KIND` | Λεωφόρος, Λεωφ., Λ., Οδός, Οδ. (and leoforos, leof., odos) | Street-kind words taken off the front of the street name. The short name is asked first, the full one second. | OpenStreetMap mostly tags numbered buildings without the word: with it, every avenue in a twenty-address sample came back empty. |
| `ADDR_TRIES` | **6** | Structured Nominatim requests per search, across every spelling and both forms of the name, in the typed area first and then anywhere. | Nominatim's policy is one request a second. Fewer loses the full-name or the anywhere retry; more makes a slow miss slower. |
| Nominatim `limit` | **10** | Rows asked for per request. | Below about 8 the right municipality's row can be cut when three suburbs share a street. |
| area words | sound key, words of **3+** letters; **5+** letters lose their last two | How the area typed after a number is checked against a row's address: every word must be there, compared by sound and stem, so "Μαρούσι" finds "Δήμος Αμαρουσίου" and "Χαλάνδρι" finds "Χαλανδρίου". | Drop the stemming and every genitive in an address misses. |

Two geocoders sit behind `/geocode`. **OpenRouteService (Pelias) autocomplete**
when `ORS_KEY` is set — it matches partial tokens, takes a focus point, and
carries house numbers. **Nominatim** when it is not, and whenever ORS misses,
errors or rejects the key. Both are flattened to the same rows, so the app never
learns which answered; only the `source` field says.

**Two Pelias endpoints, not one.** `/autocomplete` is tuned for prefixes and deliberately
skips the full address parser, so it drops house numbers; `/search` runs the parser and
resolves a number onto the right point along the street. `looksAddressed()` decides which,
and narrows `layers` to `address,street` when it is the latter — with a number given, the
neighbourhood rows are noise.

A latin query gets **two** shots at ORS — as typed, then transliterated — rather
than the four spellings Nominatim gets, because every ORS miss is a request off a
daily quota while Nominatim's are free.

The key goes in an `Authorization` header, never the query string, so the request
URL is safe to use as a cache key. Putting it in the query would file the secret
into Cloudflare's cache index for every search anyone ever runs.

### Searching stops by name

`public/index.html` → the stop-index block; `public/_headers`; `tools/build-stop-index.mjs`.

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `STOP_INDEX_URL` | `./stops-index.json?v=<hash>` | Where the app gets every OASA stop by name. The `v` is the file's own hash, written by the build tool. | Do not edit it by hand: `test/search.mjs` fails unless it matches the file. |
| index `Cache-Control` | **604 800 s** (7 days) | How long a browser keeps the file (`_headers`). Safe because the URL changes with the content. | Shorter costs ~100 KB per visit for nothing. |
| `JP_SAME_PLACE_M` | **400 m** | In the A→B picker, stops with the same name, each within this walk of the next, are one row — and no row when the station or a stop on the board already has that name within it. | Larger and same-named stops in neighbouring suburbs fuse; smaller and ΣΥΝΤΑΓΜΑ comes back as two or three rows. |
| picker rows from the index | **4** groups, from the **60** best matches | | |
| search rows from the index | **8** stops | Each listed separately: in the search a stop is its own board of arrivals. | |
| shortest query | **2** sounds | Below that the index is not searched. | One letter matches most of Athens. |

Matching is by **sound key**, the same function in the app (`soundKey`) and the Worker
(where it checks the area of an address): accents and case gone, Greeklish read as Greek,
ι η υ οι ει as one letter, ο ω as one, αι ε as one, doubles single. While typing, the last
letter is also read as each pair it could be starting (`TYPING`), so "Συν" still finds
Σύνταγμα (ντ is one sound). Ranking: the whole name, then the start of a word, then
anywhere; nearer first among equals.

### Estimating a house number nobody mapped — `INTERP`

Last resort on the address path: every geocoder has missed, and what came back is the
street. The worker asks Overpass for that road and the numbered points along it, then
reads the requested number off the line between the two nearest.

| Name | Default | What it does | Raise it / lower it |
|---|---|---|---|
| `radiusM` | **350 m** | How far around the matched point to look for the road and its numbers. | Too small and a long road is cut short of its anchors; too large and the next street's numbers join in. |
| `anchorM` | **60 m** | A numbered point further than this from the road belongs to another road. | Buildings set back from the kerb need the slack; a narrow grid needs less. |
| `maxStreets` | **3** | Distinct roads in one result set that get an Overpass call. | This is the request budget for the whole feature. |
| `maxSpan` | **60** | Widest gap in numbers we will interpolate across, and furthest past the last mapped number we will extrapolate. | Past this it is guessing, not estimating. |
| `timeoutMs` | **3 500 ms**, one try | Fuse on the Overpass call. | Someone is mid-keystroke; the shared helper's 2 × 8 s would be 16 s of nothing. |
| `cache` | **7 days** | Edge-cache lifetime. A street pays for this once a week, everyone else rides the cache. | |

Odd and even are read off their own pavement when either side has two anchors of its own.
The road's several OSM ways are chained end to end first, flipping as needed, since
interpolating along the wrong one puts the number in the next neighbourhood. The row
comes back with `precision: "interpolated"` and the app labels it *approximate*; a row
that cannot be estimated stays a street, and Overpass being down changes nothing on
screen.

---

## What actually costs money

Cloudflare's free tier gives 100 000 requests/day and **1 000 KV writes/day** — the
KV write ceiling is what breaks first, and only reports write to KV. (Until v110 the
dead-stop index was rewritten on every board, which could spend the whole day's allowance
on its own — and once it is spent, every KV write fails until midnight UTC: reports, alert
rules and push subscriptions included.)

### Measured, not estimated

Counted by driving the real app against a stub Worker and tallying every call it
made (`test/`-style Playwright harness; the numbers below are what came back):

| What the rider did | Requests |
|---|---|
| Cold boot | **4** — one `/nearby`, one `/reports`, two `/api` |
| One idle minute watching the board | **2** — `/nearby` at `refreshMs`; flags ride along |
| Typing an 8-letter destination at 90 ms/key | **1** geocode — the debounce absorbs the rest |
| Typing a 9-letter street at 400 ms/key | **5** geocode — the pathological case, right at the debounce boundary |
| Backspacing 4 characters | **2** geocode |
| Retyping those 4 characters | **0** — served from `JPQ.memo` |
| Planning a journey | **1** `/plan`, which spends ≤ 4 ORS routings server-side |

**The Cloudflare bill is the board, and only the board.** Two requests a minute is
the whole steady state. A 20-minute session is ~40 requests plus a boot; 100 000/day
is therefore around **2 400 sessions a day**, or a few hundred daily users at several
sessions each, before the request ceiling is anywhere in sight. The KV write ceiling
(1 000/day) binds first and only counts *filed reports* — 1 000 reports a day from a
community this size is not a near-term problem either.

**The ORS quota is address search, and only address search.** Journey planning costs
at most 4 routings and only for the itinerary that won; typing costs 1–5 per search
before the 24-hour edge cache, and popular Athens prefixes converge onto cache hits
within days. If the quota does bind, raise `JPQ.debounceMs` and `JPQ.minGapMs` before
touching anything else — and note that losing the key degrades rather than breaks:
Nominatim answers, walking times revert to `estimated`, nothing 500s.

### The levers

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
