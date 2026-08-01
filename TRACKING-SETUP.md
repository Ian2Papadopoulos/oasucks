# Vehicle tracking & service stats — setup

Turns your Worker into a data logger: every minute it samples the live position
of buses on the lines you choose, records when each bus reaches a stop, and from
that stream computes headway regularity, bunching, and missing trips.

The app works fine without this. Stats simply report "tracking isn't configured".

> **v18 note:** the line-stats screen in the app was replaced by the community
> reports feature (the red ❗). Tracking still runs and collects data exactly as
> described here, but its numbers are now only reachable through the Worker's
> `/stats`, `/stats/bunching` and `/stats/missing` endpoints (curl or browser),
> not from the UI.

---

## ⚠️ First: don't overwrite your wrangler.toml

Your current `wrangler.toml` contains **your real KV namespace id** (for push
alerts). The copy in this zip has a placeholder. So:

- **Copy over:** `worker.js` and `public/index.html`
- **Do NOT copy:** `wrangler.toml` — edit your existing one instead (step 2 below)

If you already overwrote it, just paste your KV id back in:
```toml
[[kv_namespaces]]
binding = "ALERTS"
id = "286552a0463b4334b79d2961622a9ffe"
```

---

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

1. Open the app, tap **📊** in the header.
2. Pick a route from the dropdown (it lists lines serving your nearby stops) and
   tap **Track a line**. Choose a direction you actually care about — each
   direction is a separate route.
3. That's it. The cron begins sampling within a minute.

You can track up to **8 routes**. That cap is deliberate — see limits below.

## 5. Reading the numbers

Tap 📊 next to a tracked line. Metrics are measured at that route's busiest
stop, over 7 or 30 days:

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
