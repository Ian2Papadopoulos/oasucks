# Where the OASA calls come from

This branch exists to answer one question: **whose IP address asks OASA for
the arrivals?**

Today it is ours. Every rider's request reaches the Worker, and the Worker
calls `telematics.oasa.gr` from a handful of Cloudflare egress addresses. To
OASA we are not a thousand people checking their bus, we are one client
making tens of thousands of calls a day from a datacentre range. In
September 2026 they stopped answering us, while the same URL answered fine
from a home connection — a range block, and the predictable end of this
design.

`pwa-v67` is the tag holding the last version of it, working.

## Is growth really the problem?

Partly. The instinct "more users means more upstream calls means a bigger
block" is half right, and the half that is wrong is worth understanding
before spending months on a rewrite.

**Upstream load does not scale with users.** Live arrivals are cached at the
edge for 50 seconds, per stop, shared by everyone. Two hundred people
waiting at Syntagma cost OASA one call, not two hundred. So the load is:

```
upstream calls/sec  ≈  distinct stops being watched / 50
```

Users only enter that formula through how many *distinct* stops they
collectively watch, and transit riders cluster hard onto busy stops. Ten
times the users is nowhere near ten times the calls.

**But concentration does scale, and that is what gets blocked.** Whatever
the total, it arrives from the same few addresses. A public API's abuse
heuristics are not counting our users; they are looking at one source
making sustained automated requests. Success makes that worse in a way no
amount of caching fixes, because the problem is the shape of the traffic,
not its size.

So: throttling buys time. It does not remove a structural ceiling.

## The fix, and why it is not a trick

Let each device ask for its own arrivals.

That is how the official OASA app works, how every native transit app
works, and why none of them get range-blocked: a thousand users are a
thousand mobile and home IP addresses making a handful of requests each,
which is exactly the traffic the API was built to serve. Nothing is
disguised and nothing is impersonated. The requests genuinely *are* coming
from a thousand different people's phones, because they are.

The reason the PWA cannot do this is CORS. OASA sends no
`Access-Control-Allow-Origin`, so a browser will fetch the response and
then refuse to let our JavaScript read it. That single header is the whole
reason the proxy exists. A native HTTP client is not a browser and is not
bound by it.

## The shape: a hybrid, not a rewrite

Not everything should move. The split falls out of asking which traffic is
high-volume-and-blockable and which is genuinely shared state.

| Stays on the Worker | Moves to the device |
|---|---|
| Community reports (KV, shared between users) | `getClosestStops` |
| Alerts, push, VAPID, the cron | `getStopArrivals` |
| Usage counters (D1) | `webRoutesForStop` |
| Geocoding (hides the ORS key) | `getBusLocation`, route detail |
| `/plan` journey routing | |

The left column is low-volume, genuinely needs a server, and has never
been anywhere near a block. The right column is the entire upstream load
and the entire problem.

## Why this is much smaller than it sounds

The code is already shaped for it, by accident of having supported a
no-backend mode from the beginning.

1. **`oasa(act, p1, p2, fresh)` in `public/index.html` is the single choke
   point.** Every OASA call in the client goes through it. It already
   branches on `MODE` and already has a path that calls
   `telematics.oasa.gr` directly — currently via public CORS proxies.
   A native build adds one more branch, and the transport underneath it
   changes from a CORS proxy to a native HTTP plugin.

2. **`loadStopsLegacy()` already does the whole fan-out client-side.**
   `samplePoints()`, merging the stop lists, `loadRoutes()`,
   `loadArrivals()` — the logic the Worker's `handleNearby` performs
   server-side already exists in the client as the fallback path. It is
   written, shipped and exercised by tests. It has simply never had a
   usable transport under it.

So the migration is closer to "give the existing fallback path a real
transport" than to "port the backend to the client".

## Steps

1. Wrap the existing `public/` in Capacitor. The UI, the service worker,
   the whole app is unchanged — Capacitor serves it in a native shell.
2. Add `MODE === "device"`, selected when a native bridge is present.
3. In `oasa()`, route that mode through `@capacitor/http` (or the platform
   HTTP plugin), which issues a real native request with no CORS.
4. Make `loadStops()` prefer `loadStopsLegacy()` in device mode. It is
   already the code path for "no backend to fan out for me".
5. Keep `base()` pointing at the Worker for reports, alerts, geocoding and
   journey planning. Those requests stay exactly as they are.
6. Delete `PUBLIC_PROXIES`. Once there is a real device transport, routing
   riders' coordinates through `allorigins.win` has no remaining excuse.

## What it costs

- **Install friction.** No more "open the link, add to home screen". Play
  Store and App Store listings, review, an Apple developer account at $99
  a year. This is the real price and it should not be waved away.
- **Two builds to keep in step.** Mitigated by the fact that the UI is one
  HTML file shared by both.
- **The PWA should stay.** It is a fine product for someone who will not
  install anything, and it works until the day OASA blocks the range
  again. The native build is what carries the load once there are enough
  users for that to matter.

## What is explicitly not on the table

Rotating addresses, residential proxy pools, or copying the official app's
headers to look like it. Those are circumventing an access control by
deception rather than distributing load honestly, they break the moment
the real app ships an update, and they would poison any future
conversation with OASA. The distinction is not subtle: sending a thousand
requests that genuinely originate on a thousand phones is not the same act
as sending them from one machine wearing a thousand masks.
