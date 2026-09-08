# OASAx — live OASA arrivals & community reports

A clean, fast web/mobile view of live bus & trolley arrivals for the stops nearest you,
built on the unofficial OASA telematics API. One Cloudflare Worker serves the whole
app and proxies the API. Installs on Android and iOS like a native app. **Current
version: v49.**

**The top bar** is three buttons — live reports (the orange dot), alerts 🔔, and a ☰ menu
holding [look up a line](#search--lines-and-stops), **Settings** (language, and whether
to hide stops with nothing coming), About, and Terms & privacy.

**Live reports.** The old line-stats button is now the orange live dot. Tap it and a live map of
Athens opens — only the buses and metro stations that currently carry a flag, each
labelled with what it is. Every flag is one colour and says what it is in words:
on a vehicle, breakdown · overcrowded · no A/C · security presence · OASA staff;
at a station, elevator or escalator out of order · no wheelchair access ·
overcrowded · security presence · OASA staff. Under the map, **New report** lets you
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
| `public/legal.html` | Terms + privacy, as served in the app (☰ → Terms & privacy). **Bilingual**: it reads the same `lang` setting the app writes, so nobody who set the app to Greek lands on an English wall of terms. `?lang=` overrides it for a shared link, and a button switches the page without rewriting the app's setting. |
| `LICENSE`, `PRIVACY.md`, `TERMS.md` | AGPL-3.0 and the documents the hosted service runs under — see [Legal](#legal). |
| `PARAMETERS.md` | **Every tunable number in one table** — radii, lifetimes, rate limits, cost dials. |
| `test/` | `npm test` — 523 assertions across eleven suites. The routing engine and the geocoder run in a `vm` against fixtures (no network, no quota); the report suite reads the source; the tile, journey, brand, legal, install, usage, origin and fixes suites drive a real browser via Playwright. |
| `public/_headers` | Security headers for the static files (HSTS, nosniff, frame-deny, referrer and permissions policy), applied by Cloudflare's asset server. |
| `tools/icons.mjs` | `npm run icons` — rebuilds the PWA icons from the mark. Run it whenever `.mark` changes; `test/brand.mjs` fails if you don't. |

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

**The app tells people this itself.** The last card of the first-run carousel is the
install card, and it names the steps for *the device in your hand* — Android's ⋮ menu,
iOS's Share sheet, the desktop address-bar icon, Safari's Add to Dock — rather than
listing all four and making the reader find their own. Firefox gets told plainly that
it doesn't install web apps, because it doesn't, and a vague instruction there is worse
than none.

Where Chrome and Edge hand the page an install prompt of their own
(`beforeinstallprompt`), the instructions give way to a real **Install** button and the
whole thing is one tap. An app already running standalone is not told how to install
itself; it just says so. The carousel is reachable again from **Settings → How it works**,
so the card is not a one-time thing someone dismissed on day one.

## How many people use it

Three places, in increasing order of effort:

**1. The Cloudflare dashboard, for free and with no code.** Workers & Pages → your
Worker → **Metrics** gives requests per day, errors and CPU time. A session on the board
is about **2 requests a minute**, so requests ÷ ~40 is a serviceable estimate of sessions.
That is the zero-cost answer and for a while it is the only one you need.

Do **not** reach for Cloudflare Web Analytics for this. It is a beacon script that
fingerprints visitors, and installing it would make the app's privacy page false.

**2. `/health?token=$ADMIN_TOKEN`** now carries a `usage` block: today's numbers and the
last thirty days' totals.

**3. `/stats/usage?token=$ADMIN_TOKEN&days=30`** returns the daily series:

```json
{ "since": "2026-08-09", "days": 30,
  "total": { "open": 792, "open_app": 38, "install": 9 },
  "byDay": { "2026-09-07": { "open": 412, "open_app": 38 } } }
```

- `open` — the app was opened.
- `open_app` — of those, the ones launched from a home-screen icon rather than a browser
  tab. This is the closest thing to an install figure that does not require tracking
  anybody, and it is arguably the better number: an installed app nobody opens is not
  counted.
- `install` — the browser's own `appinstalled` event, on the day it fires.

### What this deliberately cannot tell you

**It counts openings, not people.** One row per day per kind, holding an integer. No
identifier of any sort touches it — no IP, no device token, no user agent, no session, and
nothing hashed that could stand in for a person. Two openings by one rider and one each by
two riders are the same number here, and no later query will separate them.

That is a real limitation and it was chosen. The app's privacy page promises no tracking,
and a unique-visitor count is tracking however it is dressed up — an IP hash is still an
identifier, daily rotation or not. If you ever decide the trade is worth making, the
honest order is: change the privacy page first, then write the code.

`test/usage.mjs` inspects every statement the counter issues and fails if an IP, a user
agent, a session id, a coordinate or anything hashed reaches the database — and separately
fails if the terms still claim there is no measurement at all.

Storage is D1, not KV: a counter writing on every app open would eat the 1 000/day KV write
ceiling by lunchtime, while D1's is 100 000. With no D1 binding the beacon is accepted and
dropped, so an install without a database is uncounted rather than broken.

## Moving to a real domain

Short answer: **easy, and safe if you add the domain rather than replace the URL.**

A PWA install, its service worker, its `localStorage` (favourites, settings, the anonymous
report id) and its push subscription are all bound to the **origin**. A new origin is, to
the browser, a different app. So:

**Do this.** In the Cloudflare dashboard, Workers & Pages → your Worker → **Settings →
Domains & Routes → Add custom domain**. The *same* Worker now answers on both
`oasa-stop.<you>.workers.dev` and `yourdomain.gr`. Nothing breaks, because nothing moved:
existing installs keep loading the origin they were installed from, and new users get the
good URL. Point new links, the manifest and any QR code at the new domain and let the old
one live on indefinitely — it costs nothing to keep.

**Don't do this.** Delete or stop serving the `workers.dev` URL. Every installed app
silently fails to load, every push subscription dies, and every rider's favourites are
gone — none of which they can fix except by reinstalling, which nothing will have told them
to do.

Two caveats even on the good path:

- **`localStorage` does not follow.** Someone who opens the new domain starts with no
  favourites and a new report id, so they can no longer withdraw reports filed under the
  old one. Unavoidable — browsers isolate origins by design.
- **Push subscriptions do not follow.** Anyone with alerts set has to re-enable them on
  the new origin. The VAPID keys can stay the same; the subscription cannot.

The cheapest time to do this is **now, before there is a userbase**. If you are already
past that, add the domain, keep both alive, and turn on the notice below.

### Telling the old address it has moved

`MOVED_TO` near the top of the script block in `public/index.html`:

```js
const MOVED_TO="https://oasax.com";     // "" = say nothing, anywhere
```

Set it and the **old** origin grows a dismissible line naming the new host, warning that
favourites and alerts do not travel, and linking to the same page on the new domain.
The new origin stays silent — the check is against the live host, not a build flag, so
the same deploy behaves correctly on both.

Dismissal is remembered per host, so it appears once. It ships empty on purpose: turn it
on only once `https://<newdomain>/health` answers with your Worker's version, because a
banner pointing at a domain that does not resolve yet is worse than no banner — the
people who follow it are the ones who trust you. Step-by-step in
[DEPLOY.md](DEPLOY.md#putting-it-on-your-own-domain).

### Nothing else needs changing

`start_url` and `scope` are `.`, `id` is `/`, `CONFIG.proxyBase` is empty (same-origin),
the service worker caches relative paths, and no link in the page names a host.
`test/origin.mjs` asserts all of that, so a hardcoded URL cannot creep in and quietly tie
the app to one domain.

### The icons

`npm run icons` rebuilds `icon-192`, `icon-512` and `icon-maskable-512` from the CSS mark
rather than from a separate drawing, because two drawings of one logo drift and the drift
is invisible until somebody installs the app and gets last year's icon. `test/brand.mjs`
looks for the mark's yellow in the icons' actual pixels, so forgetting to run it fails
the suite instead of shipping.

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

   The 30s is a **deadline, not an interval**. A 250ms tick asks whether it has passed.
   That sounds like more work and is less: comparing two numbers costs nothing, while a
   bare `setInterval(load, 30000)` is throttled by phones on a page that looks idle and
   has no memory of being late, so one deferred tick costs a whole extra period. Under a
   3x timer throttle the interval version refreshed every **90s instead of 30**, which is
   how arrivals ended up a minute or two behind the sign at the stop and how rows for
   buses that had already gone stayed on screen. The tick version holds its cadence.

**Favourites ride along with the sweep.** A pinned stop outside the nearby set —
your home stop while you are at work — used to be its own request, every 30s. Three
of them quadrupled a session's traffic, from 2.0 to **8.4 requests per minute**. The
sweep now carries them: `/nearby` takes a `favs=` list and resolves the ones it did
not already return.

They are deliberately **not** part of the edge-cache key. Everyone standing on one
corner shares the expensive half of that response, and folding a personal list into
the key would fragment the cache per user and cost far more than it saves. So the
cached body stays public and the favourites are merged on the way out — including on
a cache hit, which is the path that has to be right or one rider's pins would reach
another. The client falls back to per-stop fetches if the server sends no `favs`, so
an older Worker still works.

**It follows you.** The board used to be pinned to wherever you were when it
launched: one `getCurrentPosition` at boot and nothing after. Walk 150 m and every
distance, every walking estimate and the ordering of the whole list still described
where you set off from, while the arrivals beside them were seconds old. It now
**watches** your position instead, and four rules keep that from being worse than
the bug:

- **A location you set by hand is yours.** Searching an address or dropping the pin
  means "show me there"; the watch stops, and a GPS fix arriving after it will not
  drag the board back to your feet. Going back to GPS starts it again.
- **A fix is not a fact.** Phones emit 300 m garbage between good fixes, in street
  canyons and indoors. Anything worse than `GEO.accGate` is dropped unless there is
  nothing better at all.
- **Moving a few metres is not moving.** Under `GEO.moveM` nothing happens, or the
  list churns while you stand at the kerb.
- **Most moves cost nothing.** Distances, walking times and the ordering are all
  computable from coordinates already held, so a short walk re-sorts locally and
  instantly. Only drifting `GEO.refetchM` from where the list was fetched buys a new
  one, and never faster than `GEO.minFetchMs`.

The watch is released when the tab is hidden and when the app puts itself to sleep,
so it is not running in your pocket.

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

OASA lists a line once per route *variant* — short workings, school runs, depot trips —
so one bus route came back as `608, 608, 608`. Chips collapse on line **and destination**,
which is the distinction a rider standing there can actually see, and sort by number.

**The popup never moves the map, and never covers the stop.** Leaflet's default is to
pan so a tall popup fits, which slides the dot down the screen and puts the popup where
your finger already is: the second tap of a double-tap then lands on a line chip and
draws a route instead of pinning the stop. Auto-panning is off, the popup opens above the
dot, and a chip ignores taps that arrive within a double-tap's window of the popup
appearing. A refresh sweep also no longer rebuilds a pin whose popup is open, which is
what used to swallow taps that happened to coincide with one.

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
list**. The map tab is a frame, not a document: its height is measured against what is
left of the viewport and the page is pinned while it is up, so a swipe can no longer land
you halfway down it. The slide starts on the same frame as the gesture and the incoming tab renders on
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

## Journey planning (A → B)

Available from ☰ → **Journey**.

☰ → **Journey** takes two places and returns up to three ways to get between
them using **walking, bus/trolley and metro/ISAP** — the three modes this app has
any business claiming to know about. Either end can be your location, a favourite,
a stop, a metro station, or anything the geocoder can find.

### What it actually does

The Worker exposes `GET /plan?from=lat,lng&to=lat,lng` and runs a **time-dependent
Dijkstra**. The graph has a node per bus stop, a node per metro station, a node for
each *"aboard route R at its i-th stop"*, and the two endpoints. Boarding is its own
edge, which is the detail that makes it correct: without it the search strolls
between routes at a shared stop for free and invents connections nobody could make.
Time-dependent because the cost of boarding depends on **when** you reach the stop —
a wait is not a constant. Dijkstra stays valid under that as long as a later vehicle
can never deliver you sooner, which holds for everything modelled here.

Three searches run over the same graph and the distinct results are offered:
fastest, fewest changes (a search-time penalty per boarding, not a fake duration),
and metro-only. Walking straight there is always considered and wins when it should.

### The graph is bounded, on purpose

OASA publishes the network one route or one stop at a time, so building the whole
city means thousands of calls, and a Worker gets **fifty**. What gets fetched is the
routes that touch either end of *this* journey plus every stop along them; the metro
is static and therefore free. A cold plan costs about a dozen subrequests.

The honest limit: it will not find a three-bus trip whose middle leg starts somewhere
neither end has ever heard of. For a city the size of Athens that is a rare shape, and
the alternative does not fit in the budget.

### Which numbers are real

Every leg carries a `basis`, and the UI shows it, because a journey is routinely half
measured and half modelled:

| Basis | What it means |
|---|---|
| **live** | A real ETA for a vehicle that exists and is being tracked. Only inside `liveHorizonMin` (35 min). |
| **timetable** | Past that horizon nothing has been dispatched, so the wait comes from the line's **published OASA timetable**, shifted by the modelled running time from the terminus to the stop you are standing at — because OASA publishes departures from the terminus, not times at each stop. |
| **estimated** | No timetable could be read, or the leg is on rails. OASA's telematics feed carries **no trains at all**, so every metro time is estimated from published frequency bands by day type and hour. |

The timetable endpoint is undocumented and its field names vary, so the parser takes
anything unmistakably a time (`07:35`, `7:35`, `24:10` for after midnight) and a bare
integer **only** when the field it sits under is named like a time. A line code and
minutes-past-midnight look identical otherwise, and reading `608` as 10:08 would put a
departure in the plan that does not exist. Reading nothing is fine: the leg says
*estimated*, which is true, rather than *timetable*, which would not be.

### Walking

Every journey begins and ends on foot and every transfer is a walk, so this is where a
plan quietly goes wrong. Two levels, and each leg says which it got:

- **estimated** — straight line × a detour factor that **varies with distance**. A fifty
  metre hop detours proportionally far more than a kilometre does, so one flat factor is
  wrong at both ends. This is what the search uses on all of its thousands of edges,
  where only the ranking matters.
- **routed** — a real pedestrian route, with its real distance, duration and shape to
  draw. One request each, so only the walking legs of the itinerary that **won**, and
  only when `ORS_KEY` is set.

`ORS_KEY` is a Worker **secret**, not a client value — unlike the tile key it never has
to reach a browser, so it should not:

```bash
npx wrangler secret put ORS_KEY     # free key from openrouteservice.org
```

Without it the app still plans, still draws, and says plainly that walking times are
estimated rather than routed.

### Typing a destination

The picker at each end of a journey searches four things at once. Your location, your
favourites, the stops already loaded and every metro station match **locally**, from the
first character, with no request at all. Past three characters it also asks the geocoder.

Which geocoder depends on the same `ORS_KEY`:

- **With it** — OpenRouteService's Pelias *autocomplete*, which is built for type-ahead.
  It matches partial tokens, so "synt" already finds Syntagma; it takes a focus point, so
  the Φιλοτίμου two streets away outranks the one in Piraeus; and it carries street
  addresses down to the house number, which is the part Nominatim's `display_name`
  routinely loses.
- **Without it** — Nominatim, which wants a near-complete query and ranks by nothing you
  can steer. Still works; noticeably worse.

Either way the answers are flattened to the same rows server-side, so the app never
learns which one replied. ORS misses, errors and a rejected key all fall through to
Nominatim rather than surfacing an error.

**House numbers get a different endpoint.** Pelias keeps its address parser out of
`/autocomplete`, which is tuned for prefixes — ask it for "Φιλοτίμου 12" and the number is
quietly dropped and you get the middle of the street. So the moment a query *looks* like a
complete address — a short standalone number next to real words — it goes to
`/geocode/search` instead, with the layers narrowed to `address,street`. A line number
("608"), a postcode ("11527") and a half-typed word are all correctly not addresses.

Greeklish is handled in front of both — "filotimou" → "φιλοτίμου", digits left alone — but
with different budgets. Nominatim gets four candidate spellings because its requests are free; ORS gets
two, the query as typed and then transliterated, because every miss is a request off a
daily quota.

Typing fast used to be able to show you the wrong answer: a slow request for "syn"
landing after a fast one for "syntagma" overwrote the better list. Each keystroke now
aborts the request before it, and anything that still lands late is discarded rather
than rendered.

### Walking legs are routed when you look at them

The planner routes the walking legs of the itinerary it ranks first, because before
anyone has chosen, that is the only one worth spending requests on. The cost of that used
to be paid by anyone who opened the *second* option: its walking legs were still the
straight line the search had used for ranking — a line drawn across the blocks, which
reads as a route and is not one.

Opening an itinerary now fills in whatever it is still guessing at, through
`GET /walk?from=&to=`. That is better timed as well as cheaper: the request happens when
a rider actually looks at a leg. The endpoint caches for a week — the pavement between
two fixed points does not change — so the second person to open the same leg costs
nothing, and a router that is not configured answers 501 once and is then left alone.

**No key, no real routes.** `ORS_KEY` drives both this and the house numbers in address
search, so "why is my walk a straight line" and "why can't I type a house number" are
usually the same question. `GET /health?token=…` answers it: `bindings.ors`.

### Why it offered you a walk

"Walk 34 minutes" is the one answer a rider cannot check against anything. It can mean the
network is shut, or that the next bus is half an hour out, or that the planner simply
failed to find a way to ride — and those deserve very different reactions. So a walk-only
itinerary now carries the reason it was offered, and the card says it in words:

- **it beat something** — names the line, the wait that lost it, and how long riding would
  have taken. "Quicker than the 608: 22′ waiting, 31′ in all."
- **nothing is running** — the hour, not the route.
- **no stop within walking distance** of the start, or of the destination. The one
  actionable case: walk two streets and search again.
- **stops at both ends, nothing connecting them** — said plainly as either a gap in the
  network *or* more changes than the planner searches, because from here those are
  genuinely indistinguishable.

Two changes make that note trustworthy. A fourth search runs with the direct walk edge
removed, purely so the walking option has something honest to be measured against — it
costs no requests, being Dijkstra again over a graph already in memory, and it doubles as
the "I'd rather not walk it" option in the list. And forbidding the direct edge is not
enough on its own: walking to a stop and walking on from it is the same walk with a
waypoint, so in that run a stop you merely *walked* to cannot be a place you finish on
foot from.

The reverse case is handled by dropping the option entirely. A 38-minute walk against a
15-minute ride is not an alternative, it is padding, and it pushes a real second route out
of the three slots — so a walk more than `PLAN.walkKeepSlackMin` slower than riding is not
offered. Within that slack it stays, because "riding is a bit quicker but I'd rather walk"
is a real preference.

### Modes

Bus, **tram** and **trolley** all ride the same telematics feed and come back through the
same route calls, so they are planned over identically — the mode is read from OASA's own
route description rather than guessed from line numbers, which get renumbered. Metro and
ISAP are separate, from static line data, because the feed carries no trains.

Bus *ride* time is modelled everywhere: OASA gives no inter-stop times, so it is road
distance against an average speed that varies by day and hour, because Athens traffic
is a bigger term in any bus estimate than distance is. Metro run times use 34 km/h in
the city, 30 for ISAP, and 62 on the airport branch.

**Only some line 3 trains carry on past Doukissis Plakentias**, so crossing onto the
airport branch is charged its own 36-minute headway rather than the city one. It is
the single most common way an Athens estimate goes wrong.

Outside service hours the modes are simply unavailable, and an empty answer says
"neither buses nor trains are running" rather than "no route".

### Tuning it

Every number above is in `PLAN`, `HEADWAY_METRO`, `HEADWAY_BUS`, `BUS_SPEED`,
`METRO_SPEED_KMH` and the service windows in `worker.js`, and in
[PARAMETERS.md](PARAMETERS.md). The headway tables are the weakest part and the
easiest to improve: OASA has ~300 lines whose frequencies are nothing alike, so one
table can only ever be an order of magnitude. It is used **only** where no live ETA
exists to use instead.

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

Picking a result opens its card **over** the results, which stay where they are. Deciding
it was the wrong stop used to mean typing the query again.

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
Each pin carries a label above it saying what it is — *Escalator out of order*, *No A/C*,
*Overcrowded* — so the map answers "what and where" without a tap.

**Every flag is one colour.** There used to be two — red for problems, blue for
operational — and the split cost more than it bought: you had to decode a palette
before reading a word that was already printed on the pin. Shape still separates a
vehicle (square) from a station (diamond). Severity is not encoded anywhere.

Below zoom 15 the labels hide (a dozen of them overlap into
noise at city scale) and the pin's count badge carries the weight; tap a pin and the
popup says the same thing. Nothing that is fine is drawn. The full list of active
reports sits underneath, busiest first, above a **Report an issue** button.

You can only report what you are actually next to — no free text, ever:

| Where you are | Who can report it | What you can flag |
|---|---|---|
| **On a bus or trolley** | only the vehicle you're riding (see below) | breakdown · overcrowded · no A/C · security presence · OASA staff |
| **At a metro station** | stations within **600 m** of you | elevator not working · escalator out of order · no wheelchair access · overcrowded · security presence · OASA staff |

The menu changes with where you are — a bus never offers *escalator out of order* — and
the Worker enforces the same menus server-side, so a hand-made request can't file a
type the UI doesn't show.

**On staff and security entries.** These are factual, staff-agnostic statements about a
*situation*: "OASA staff are on this line" is service information of the same kind as
"this bus has no air conditioning". The app has no free-text field, no photo upload, and
no way to describe or identify a person — by design, and it is the single most important
thing to keep that way. See [Legal](#legal).

**On accessibility entries.** *Elevator not working*, *escalator out of order* and *no
wheelchair access* exist because a step-free route that turns out not to be step-free is
not an inconvenience, it is a journey that cannot be made. They carry the longest
lifetimes in the table for the same reason.

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
**"Overcrowded · 3 reports · 4′ ago"** under its direction, matched to that exact
vehicle, so the other bus on the same line stays clean.

The rules:

| Flag | Expires after |
|---|---|
| OASA staff / security presence on a bus | **30 min** — staff ride a few stops and get off |
| Breakdown / overcrowded / no A/C on a bus | **60 min** — it lasts the trip |
| Overcrowded at a station | **30 min** — a platform clears; a bus does not |
| Elevator / escalator out of order, staff, security at a station | **2 h** — a station is worked for hours, and a broken lift outlasts a trip |
| No wheelchair access | **3 h** — the longest of the lot: it is a fact about the building, not about this morning |

All of these live in one table, `TTL` in `worker.js` — see
[PARAMETERS.md](PARAMETERS.md).

Re-reporting the same thing renews your own record's timer without inflating the count.
**Nobody can cancel someone else's report** — a flag disappears when it expires or when
**the reporter who filed it** withdraws it (the app keeps an anonymous device token in
`localStorage`; the server never exposes it, so withdrawals can't be forged).

**History for statistics:** active flags live in KV and vanish when they expire, but
every filed report is *also* appended to D1's `report_log` table (timestamp, kind,
type, target, line — **no coordinates and no reporter id**).
`GET /reports/toplist?days=30&type=breakdown` returns the most-reported
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
# every breakdown report, live + history
curl -X POST "https://<your-url>/admin/reports/purge" ^
  -H "X-Admin-Token: YOUR_TOKEN" -H "Content-Type: application/json" ^
  -d "{\"type\":\"breakdown\",\"log\":true}"

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
  --command "DELETE FROM report_log WHERE type='breakdown' AND ts > unixepoch()-21600"
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

**When a search comes back empty**, the app says which kind of empty it is: no
connection, a service that will not answer, or no location fix to match against.
"No line by that name" is reserved for the case where it actually looked and found
nothing, since anything else sends people hunting for a typo they did not make.

**The basemap needs a key.** CARTO began requiring one on
`basemaps.cartocdn.com` in August 2026; without it the tiles still load but every
one carries an **"API KEY REQUIRED"** watermark. Get a free key (fair use, 5M tiles
a month) at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey) and paste
it into `TILE_KEY` near the top of the script in `public/index.html`.

It is a public value like every browser-side tile key — it ships in the page and
anyone can read it. **Restrict it to your domain in CARTO's dashboard** rather than
trying to hide it; there is nowhere in a static app to hide it, and proxying tiles
through the Worker would cost more requests than the whole rest of the app.

With no key the app falls back to OpenStreetMap's own tiles, desaturated to sit in
this palette (inverted for the dark toggle, since OSM has no dark style). That keeps
a fresh clone working and an expired key from looking broken, but **OSM's tiles are a
donated service with a usage policy written for small projects** — set a key before
you publish to more than a few people.

CARTO are also retiring these raster PNG endpoints in favour of vector tiles, so a
key buys time rather than settling this for good. When that lands, the move is
MapLibre plus a vector style, which is a bigger change than swapping a URL.

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
