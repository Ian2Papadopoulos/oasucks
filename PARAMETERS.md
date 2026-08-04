# Tunable parameters

Every arbitrary number in the app, in one place, with where it lives and what
breaks if you change it. Values here are the **v30 defaults** — if you edit the
source, edit this table too.

Two files hold almost everything: **`public/index.html`** (the app) and
**`worker.js`** (the server). Nothing here needs a rebuild — change the value,
`npx wrangler deploy`, done.

> **Read this first.** Three numbers govern cost, and none of them is a radius:
> `SCAN.maxRoutes`, `SCAN.stopProbe` and `CONFIG.listStops`. Distances only
> decide what gets *shown*; the per-route and per-stop fan-outs decide what gets
> *fetched*. See [What actually costs money](#what-actually-costs-money).

---

## 1. Reporting reach — "am I close enough to flag this?"

`public/index.html` → `ONBOARD`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `busRadius` | **100 m** | Standing still, a bus this close counts as "yours". The product rule. | Raising it lets people flag buses they're only watching go past. |
| `metroRadius` | **600 m** | How near a station you must be to flag it. Stations don't move, so this check is exact. | Lower = stricter; 600 m already covers a large interchange. |
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
| `TTL.unconfirmed` | **300 s** (5 min) | Life of a report the app couldn't match to your vehicle. |
| `TTL.bus.inspector` | **900 s** (15 min) | Inspectors ride a few stops and get off. |
| `TTL.bus.breakdown` | **3 600 s** (1 h) | |
| `TTL.bus.crowded` | **3 600 s** (1 h) | |
| `TTL.bus.noac` | **3 600 s** (1 h) | Lasts the trip. |
| `TTL.metro.inspector` | **7 200 s** (2 h) | Inspectors work a station for hours, unlike a bus. |
| `TTL.metro.lift` | **7 200 s** (2 h) | A broken lift is a facility fault, not a passing event. |
| `DEFAULT_TTL` | **3 600 s** | Fallback for a type not in the table. |
| `MAX_ACTIVE_PER_REPORTER` | **2** | Live reports one anonymous device may hold at once. |
| `VOTES_TO_KILL` | **2** | Distinct "not there" votes that delete a flag for everyone. |
| `REP_TTL_DAYS` | **60** | How long a reporter's reputation counters are kept after last use. |

### Reputation thresholds

`worker.js` → `repVerdict()` — `x` = times contradicted, `c` = times corroborated.

| Verdict | Rule | Effect |
|---|---|---|
| `limited` | `x ≥ 3` and `x > c + 1` | May still file; never auto-confirmed. |
| `shadow` | `x ≥ 6` and `x > c × 2` | Files return `200`, but only they can see the result. |

Neither fires on a single unlucky report — both need a sustained pattern.

### What can be reported

`worker.js` → `REPORT_TYPES` (enforced) and `public/index.html` → `TYPES_BY_KIND` (shown).
**Keep these two in sync** — the server rejects anything the client offers that it doesn't know.

| Category | Types |
|---|---|
| `bus` | `breakdown`, `crowded`, `noac`, `inspector` |
| `metro` | `inspector`, `lift` |

Labels live in the `ti_*` i18n keys (`ti_noac`, `ti_lift`, …) in both languages.
Every flag renders **red**; the type decides the label and the lifetime, never the colour.

---

## 3. The stop list and map

`public/index.html` → `CONFIG`

| Parameter | Default | What it means | If you change it |
|---|---|---|---|
| `listStops` | **10** | Hard cap on rows in the list. Every visible row is guaranteed to have its arrivals loaded. | **The main cost dial** — one OASA arrivals call per row per refresh. |
| `maxMarkers` | **120** | Stops drawn on the map. Markers are nearly free — no per-stop request. | Raise freely; the map is not what costs money. |
| `maxRows` | **6** | Arrival rows shown per stop. | Display only. |
| `refreshMs` | **30 000 ms** | Foreground refresh interval. | Doubling it halves your request rate. |
| `idleMs` | **45 000 ms** | Refresh interval once idle. |  |
| `idleAfter` | **240 000 ms** (4 min) | No interaction → switch to the idle interval. |  |
| `sleepAfter` | **900 000 ms** (15 min) | No interaction → stop refreshing entirely. |  |
| `walkSpeed` | **80 m/min** | Used for the "🚶 ~4′" walking estimate. |  |
| `detour` | **1.35** | Straight-line distance × this ≈ real walking distance. |  |
| `FAV_MAX` | **6** | Maximum pinned favourite stops (`FAV_KEY = "favStops"`). | Favourites count *within* `listStops`. |

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
| `nearby` `limit` | **10** | Stops the server loads arrivals for. Client sends `CONFIG.listStops`. |
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
| `POST /reports/vote` | **40** |
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
| `REP_TTL_DAYS` | `worker.js` | **60 days** | Reporter reputation counters. |
| Active reports | `worker.js` → `TTL` | 5 min – 2 h | Deleted on expiry, coordinates included. |

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
| `edge` | **34 px** | On the map, only a swipe starting this close to the left edge counts (the rest pans the map). |
| `.slide-l/.slide-r` | **0.3 s** | Tab transition duration (CSS). |

Long-press to pin a favourite: **430 ms** (`onLongPress` default).

---

## What actually costs money

Cloudflare's free tier gives 100 000 requests/day and **1 000 KV writes/day** — the
KV write ceiling is what breaks first, and only reports write to KV.

Per list refresh (every `refreshMs`): **1** request to `/nearby`, which fans out to
about 30 OASA subrequests. Subrequests are free; the one browser request is what
counts. So the levers, in order:

1. **`CONFIG.refreshMs`** — doubling it halves everything.
2. **`CONFIG.listStops`** — one arrivals lookup per row per refresh.
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
