# Turning on bus alerts (push notifications)

The app works fully without this. These steps add the alert engine: a cron job that
checks live arrivals (every minute during the day, every 5 minutes overnight) and
pushes a notification before your bus reaches your stop.

Everything below is free tier. Do it once, in the project folder.

---

## 1. The storage namespace (KV)

Push alerts store subscriptions and rules in a KV namespace bound as `ALERTS`. The
repo's **wrangler.toml already has this binding active**, pointing at the project's
namespace — so if you deploy to the same Cloudflare account it was created in, you can
**skip this step** and go straight to the keys.

Only if you're deploying under a *different* account: create your own namespace and
replace the `id` in `wrangler.toml`:

```powershell
npx wrangler kv namespace create ALERTS   # older wrangler: kv:namespace create
```

It prints an `id = "a1b2c3d4e5f6..."` — paste that over the existing `ALERTS` id in the
`[[kv_namespaces]]` block of **wrangler.toml**.

> The same `ALERTS` namespace also holds the community reports, so setting this up
> lights up reports too, not just alerts.

## 2. Generate your signing keys

```powershell
node genkeys.mjs
```

It prints a `VAPID_PUBLIC_KEY` and a `VAPID_PRIVATE_KEY`. These identify your
server to Google/Mozilla's push services. Keep the private one secret.

## 3. Store the keys as secrets

Run each command, paste the matching value when prompted, press Enter:

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

For `VAPID_SUBJECT` enter a contact URL like `mailto:you@example.com` — push
services require one so they can reach you if something misbehaves.

## 4. Deploy

```powershell
npx wrangler deploy
```

The output should now mention the KV binding and the cron trigger.

---

## 5. Use it on your phone

1. Open the app, tap the **🔔** button in the header.
2. Tap **Send test notification** → allow notifications when Chrome asks.
   A test notification should arrive within a second or two. If it does, the
   whole chain works.
3. Tap **＋ New alert** and set up your rule:
   - **Stop** — one of your current nearby stops
   - **Line / direction** — e.g. `036 · ΠΛ. ΚΥΨΕΛΗΣ - ΠΑΝΟΡΜΟΥ`
   - **Days** — Mo–Fr are pre-selected
   - **From / To** — e.g. 08:30 to 08:50
   - **Notify before** — 10′ and 5′ are pre-selected; 15′ and 3′ available
4. Save. You'll get a notification when a bus on that line is 10 minutes and
   again when it's 5 minutes from that stop, but only for buses predicted to
   arrive inside your window, and only on the days you chose.

Alerts are deduplicated per vehicle **per lead time**, so one bus gives you one
notification per lead — not one every minute — and a 15/10/5 set arrives as three
separate notifications that each alert you. (Before v26 all three shared one
notification tag, so the later ones silently *replaced* the first in the tray instead
of ringing.)

---

## How the timing actually works

OASA reports live predicted arrivals at a stop, not a fixed timetable. So the
rule reads: *"between 08:30 and 08:50 on weekdays, when a 036 heading to
Panormou is predicted to reach Πλ. Κυψέλης, warn me 10 and 5 minutes before."*
A bus predicted to arrive at 08:42 triggers at roughly 08:32 and 08:37.

Because it's prediction-based, times shift as traffic changes — a bus can be
"5 minutes away" for two consecutive minutes. The dedupe logic means you still
only get one alert per lead time.

## Trimming the cron to your actual alert windows

The default schedule is deliberately broad (~1,150 runs/day) so *any* rule anyone
creates is covered. Once you know your real usage you can cut that hard — the Worker
computes the minimum schedule from the live rules:

```powershell
curl "https://<your-url>/alerts/windows?token=YOUR_ADMIN_TOKEN"
```

```json
{ "rules": 2,
  "crons": ["* 5,6 * * 1,2,3,4,5", "* 18,19,20 * * 6"],
  "estimatedRunsPerDay": 111 }
```

Paste those `crons` into `wrangler.toml` → `[triggers]` and redeploy. (Times are
converted to UTC for you, DST included; the lead time is already subtracted so the
notification still fires early enough.) With **no** alert rules it returns none, and
you can drop the trigger entirely.

**Optional — let it retune itself.** If you'd rather not do this by hand, set two more
secrets and the Worker rewrites its own schedule once a day:

```powershell
npx wrangler secret put CF_API_TOKEN      # scope: Workers Scripts:Edit, this account
npx wrangler secret put CF_ACCOUNT_ID
```

Weigh that: the token can edit your Worker, so it's opt-in and off by default. Without
it nothing happens — `applySchedule` is a no-op. Add `&apply=1` to the `/alerts/windows`
call to apply immediately instead of waiting for the daily pass.

Runs where nothing is due now cost effectively nothing anyway: the cron checks the alert
windows first and returns before touching OASA or D1.

## Costs and limits

- Cron runs once a minute during Athens daytime and every 5 minutes overnight by
  default (`wrangler.toml` → `[triggers]`) — well inside the free tier, and trimmable
  to ~110/day as above.
- KV free tier allows 1,000 writes/day; each alert sent writes one small key.
- Notifications only fire while a rule's window is active, so most runs do no work
  at all.

## Turning it off

Delete a rule with the ✕ next to it in the 🔔 sheet, or revoke notification
permission in Chrome (site settings → Notifications).

## Troubleshooting

- **"Push isn't configured on the server yet"** → a secret or the KV binding is
  missing. Re-check steps 1–3, then redeploy.
- **Test works, alerts don't** → check the rule's days/window match the current
  time in Athens, and that buses actually run then. Watch live logs with
  `npx wrangler tail` and look for the cron runs.
- **Nothing after reinstalling the app** → the push subscription is per-browser;
  tap the test button once more to re-register.
