# Privacy policy

**Last updated: 4 August 2026**

> Not legal advice. This mirrors the in-app text at `public/legal.html` — change
> both together.

No account, no advertising, no analytics, no cookies, no third-party scripts. The
controller is the operator of this instance: **oasax@proton.me**.

## What is processed

| Data | Why | Legal basis | Stored? |
|---|---|---|---|
| **Your location** | Find nearby stops and the vehicle you are on | Consent | **Never stored** |
| **IP address** | Rate limiting | Legitimate interests | In memory, ≤60 s |
| **Anonymous random id** | So you can withdraw your own reports | Legitimate interests | With an active report |
| **Push subscription** | Only if you enable alerts | Consent | Until you disable alerts |
| **Report contents** | Line or station + a fixed-menu selection | Consent | Public while active |

Reports contain **no free text, no photos and nothing identifying any person**.
There is no way to enter such information.

## Retention

- Active reports: until they expire (15 minutes to 2 hours), then deleted with
  their coordinates.
- Anonymous history log (time, line, station, report type — **no coordinates, no
  reporter id**): 90 days.
- Push subscriptions: until you disable alerts.
- Local settings (`localStorage`): until you clear site data.

## Recipients

Cloudflare (hosting; our processor under Art. 28, possibly outside the EEA under
Standard Contractual Clauses); OASA (receives our server's requests, not yours);
OpenStreetMap / CARTO (your browser fetches map tiles, so they see your IP address).
Nothing is sold or shared otherwise.

## Your rights

Access, rectification, erasure, restriction, portability and objection. You may
withdraw consent at any time by revoking location or notification permission.
Delete a report in the app with ✕; clear everything else by clearing site data.
Written requests: **oasax@proton.me**. You may complain to the Hellenic Data
Protection Authority (<https://www.dpa.gr>).

## Security

All traffic is HTTPS. Reports carry no identity beyond a random token, which is
never sent to other users' devices.
