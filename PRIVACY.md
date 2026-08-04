# Privacy policy

**Last updated: 4 August 2026**

> ⚠️ **Before you publish:** replace `CONTACT@EXAMPLE.COM` throughout this file
> (and in `public/legal.html`, which is the copy users actually read) with a real
> address you monitor. A privacy policy with no working contact fails Art. 13(1)(b)
> GDPR and leaves you with no notice-and-action channel under the DSA.
>
> This document was written to be accurate about what the code in this repository
> actually does. It is not legal advice and it has not been reviewed by a lawyer.

OASUCKS is an unofficial app showing live OASA arrivals for the stops around you,
plus flags that riders file about what they're seeing. It has no accounts, no
sign-up, no advertising and no analytics.

The controller for the purposes of the GDPR (Regulation 2016/679) is the operator
of this instance, reachable at **CONTACT@EXAMPLE.COM**.

---

## 1. What is processed, and why

| Data | Why | Legal basis | Where it goes |
|---|---|---|---|
| **Your location** (GPS coordinates) | To find the stops around you, and to work out which vehicle you are on when you file a report | **Consent** (Art. 6(1)(a)) — the browser asks, and you can say no | Sent to our server only as coordinates in a request. **Never stored.** |
| **IP address** | Unavoidable in any HTTP request; also used for per-address rate limiting | **Legitimate interests** (Art. 6(1)(f)) — keeping the service up | Held in memory for at most 60 seconds for rate limiting. Not written to any database. |
| **Anonymous device id** | A random string generated in your browser, so you (and only you) can withdraw your own reports | **Legitimate interests** — abuse prevention and letting you undo your own actions | Stored with an active report; see retention below |
| **Push subscription** (only if you enable alerts) | To send the arrival notifications you asked for | **Consent** | Stored until you disable alerts or the browser revokes it |
| **Report contents** (line/vehicle/station, issue type, time) | The feature itself | **Consent** — you file it deliberately | Public to other users while active |

### What is *not* processed

- **No account, no name, no email, no phone number.**
- **No free-text field anywhere in a report.** You choose from a fixed menu. There
  is no way to type a comment, upload a photo, or name a person — by design.
- **No analytics, no advertising, no third-party tracking scripts.** Map code
  (Leaflet) is served from this app's own domain, not a CDN.
- **No cookies.** The app uses `localStorage` purely to remember your language,
  your pinned stops and your anonymous id. That is "strictly necessary" storage
  under the ePrivacy Directive, which is why there is no consent banner.
- **No location history.** Your position is used to answer the request in front of
  it and then discarded. It is never written to a database, and the app cannot
  reconstruct where you have been.

## 2. Who else sees your data

Three third parties necessarily receive your IP address when the app makes a
request, because that is how the internet works:

- **Cloudflare, Inc.** — hosts the app and its storage, acting as our **processor**
  under Art. 28 GDPR. Data may be processed outside the EEA under Cloudflare's
  Standard Contractual Clauses.
- **OASA** (`telematics.oasa.gr`) — the source of all arrival and vehicle data.
  Requests are made *by our server*, so OASA sees our server's address, not yours.
- **OpenStreetMap / CARTO** — map tiles are fetched *by your browser*, so these
  services see your IP address and the map area you are looking at.

We do not sell, rent or share your data with anyone else.

## 3. How long things are kept

| Thing | Kept for |
|---|---|
| Your location | Not stored at all |
| IP address | ≤ 60 seconds, in memory only |
| An active report (including its coordinates and the reporter's anonymous id) | Until it expires: **15 minutes** (bus inspector), **1 hour** (other bus issues), **2 hours** (metro inspector, broken lift). Then it is deleted outright. |
| Report history log (time, line, station, issue type — **no coordinates, no reporter id**) | **90 days**, then deleted automatically |
| Push subscription | Until you turn alerts off |
| Anything in `localStorage` | Until you clear your browser data or uninstall |

## 4. Your rights

Under the GDPR you may request access, rectification, erasure, restriction,
portability, and you may object to processing. You may also withdraw consent at
any time — revoke location permission in your browser, or turn off notifications.

Because the service holds no identifying data about you, we usually **cannot find
"your" records** from an email alone. That is a deliberate design outcome, not an
evasion. In practice:

- **Erase a report:** open the app, find it in the report list, tap ✕. Only you can.
- **Erase everything else:** clear the site's data in your browser. Your anonymous
  id disappears with it, and any remaining reports expire on their own within hours.

If you want to exercise a right in writing, contact **CONTACT@EXAMPLE.COM**. You
also have the right to complain to a supervisory authority — in Greece, the
Hellenic Data Protection Authority (<https://www.dpa.gr>).

## 5. Children

The app is not directed at children and collects no age information. It is a bus
timetable; there is nothing here that requires an age check.

## 6. Security

All traffic is HTTPS. Reports carry no identity beyond a random token. Withdrawal
is checked server-side against that token, so nobody can delete anyone else's
report. Reporter tokens are never sent to other users' devices.

## 7. Changes

Material changes will be noted here with a new date at the top. Since there is no
mailing list, the app's About screen links to this page so the current version is
always one tap away.
