# Vehicle tracking & service stats — setup

Turns your Worker into a data logger: on each cron run it samples the live position
of buses on the lines you choose, records when each bus reaches a stop, and from
that stream computes headway regularity, bunching, and missing trips.

The app works fine without this. Stats simply report "tracking isn't configured".

> **The stats screen is currently off in the UI.** It was retired in v18 to make room
> for the community-reports feature (the red ❗), but all the code and the tracking
> backend are intact — the cron still collects data. Today the numbers are read through
> the Worker's endpoints (`/stats`, `/stats/bunching`, `/stats/missing`, and
> `/reports/toplist`) from curl or a browser; re-enabling the in-app screen is a small
> change (wiring `openStats()` to a menu entry) whenever you want it back.

---

## The database binding (D1)

Tracking (and the report-history log behind `/reports/toplist`) stores its data in a D1
database bound as `DB`. The repo's **wrangler.toml already has this binding active**,
pointing at the project's database — so on the same Cloudflare account it's ready to go
and you can skip to *Start tracking* below. Tables are created automatically on first
use; there's no migration step.

Only if you're deploying under a *different* account, create your own database and swap
the id:

## 1. Create the database

```powershell
npx wrangler d1 create oasa-stats
```

It prints a block like:
```
[[d1_databases]]
binding = "DB"
database_name = "oasa-stats"
database_id = "b7f3...9a21"
```

## 2. Add it to your wrangler.toml

Paste those four lines at the end of your existing `wrangler.toml` (keeping the
KV block). Binding must be exactly `DB` — that's the name the code looks for.

## 3. Deploy

```powershell
npx wrangler deploy
```

The output should now list **both** bindings (ALERTS and DB) plus the cron
trigger. Tables are created automatically on first use — no migration step.

---

## 4. Start tracking a line

With the in-app screen currently off, add routes through the Worker's endpoints. A
`route_code` is a single direction of a line — get it from `/lines` then
`getRoutesForLine`, or from the ☰ → *Find a line* preview (the code is in the request).

```powershell
# add a route (repeat for each direction you care about)
curl -X POST https://<your-url>/track/add ^
  -H "Content-Type: application/json" ^
  -d "{\"route_code\":\"1873\",\"line_id\":\"608\"}"

# see what's tracked and how much data has accrued
curl https://<your-url>/track/list
```

The cron begins sampling within a minute (5 minutes overnight). You can track up to
**8 routes** — that cap is deliberate, see limits below.

## 5. Reading the numbers

Fetch a route's stats as JSON. Metrics are measured at that route's busiest stop, over
`days` (7 or 30):

```powershell
curl "https://<your-url>/stats?route=1873&days=7"
curl "https://<your-url>/stats/bunching?route=1873&days=7"
curl "https://<your-url>/stats/missing?route=1873&days=7"
```

The `/stats` response carries the same figures the retired screen showed:

| Metric | Meaning |
|---|---|
| **Real wait** | What a passenger arriving at random actually waits, `E[gap²]/(2·E[gap])`. On perfectly even service it's half the headway; irregular service pushes it up sharply. This is the honest headline number. |
| **Headway** | Typical gap between buses, ignoring bunched pairs. |
| **Regularity** | % of gaps within ±50% of typical. Above ~75% is good. |
| **Bunching** | % of gaps ≤ 2 min — buses arriving nose-to-tail. |
| **Missing trips** | % of gaps ≥ 2.5× typical (min 12 min) — service that didn't show. |
| **Worst gap** | Longest hole observed. |

Below that: hourly activity, plus timestamped bunching incidents and missing-service
gaps you can point at.

**Give it time.** One rush hour is not a sample. A day gets you a rough picture;
a week is when patterns get trustworthy.

---

## How it works

Rather than logging raw GPS pings (huge and mostly redundant), the cron snaps
each vehicle to its nearest stop and writes **one row when a bus reaches a new
stop**. Roughly 5× fewer rows, and it's exactly the event all three analyses need.

- `stop_event` — the event stream (route, vehicle, stop, timestamp)
- `veh_state` — each vehicle's last known stop, so we only record transitions
- `route_stops` — cached stop lists, refreshed weekly
- `sched_dep` — published timetable times, synced daily at ~04:00 Athens
- Rows older than 45 days are deleted automatically

## Limits and cost

D1's free tier allows 100,000 writes/day. Each tracked route generates roughly
1,000–3,000 rows/day depending on frequency and fleet size, so 8 routes sits
comfortably inside it. If you want more, raise `TRACK.maxRoutes` in `worker.js`
and watch your usage in the Cloudflare dashboard.

## Troubleshooting

- **"Tracking isn't configured"** → the `DB` binding is missing. Check step 2 and redeploy.
- **No events after an hour** → confirm buses actually run on that route now, and
  watch the cron with `npx wrangler tail`. You can force a sample with a POST to
  `/track/sample`.
- **Want the raw data?** `npx wrangler d1 execute oasa-stats --command "SELECT COUNT(*) FROM stop_event"`
  (add `--remote` to query the deployed database rather than a local one).

## Where this can go

Once a few weeks of data exist, the same `stop_event` table supports: per-hour
reliability heatmaps, comparing lines against each other, "is my commute getting
worse over time", and segment speed profiles for a traffic-congestion map.
