# Deploy & test on your phone — step by step

This deploys **one** Cloudflare Worker that serves the app *and* proxies the OASA API
from the same URL. One command, one URL, no CORS, free tier.

I (Claude) can't run the deploy for you — `wrangler login` opens a browser and signs
into *your* Cloudflare account, which only you can do. Everything else is already done;
the steps below are the two that need your login, plus checks.

---

## What you need

- **Node.js 18+** — get the LTS installer from https://nodejs.org and install it.
  (You don't need Visual Studio for this. Any terminal works: PowerShell, or the
  integrated terminal in VS Code / Visual Studio.)
- A free **Cloudflare account** — you'll create/sign in during step 3 (no card needed).

Check Node is installed — open a new PowerShell window and run:
```powershell
node --version
```
You should see something like `v20.x` or `v22.x`.

---

## 1. Get the project onto your PC

Clone the repo (needs Git — https://git-scm.com — or use GitHub Desktop / "Download ZIP"
from the repo page):
```powershell
git clone <your-repo-url> oasax
cd oasax
```

## 2. Open a terminal *in that folder*

If you cloned from the command line you're already there. Otherwise open the `oasax`
folder in VS Code → Terminal → New Terminal, or Shift + right-click the folder →
**"Open PowerShell window here"**.

Install the tooling (this just pulls in `wrangler`, Cloudflare's CLI):
```powershell
npm install
```

> The `wrangler.toml` already has the KV (reports/alerts) and D1 (stats) bindings wired
> up, so deploying to **the same Cloudflare account** these were created in just works.
> Deploying under a *different* account? See PUSH-SETUP.md / TRACKING-SETUP.md to make
> your own storage and swap the ids — the core arrivals app runs without either.

## 3. Log in to Cloudflare

```powershell
npx wrangler login
```
Your browser opens. Sign in — or click **Sign up** to make a free account — then click
**Allow**. When it says you're logged in, return to the terminal.

## 4. Deploy

```powershell
npx wrangler deploy
```
When it finishes it prints your live URL, something like:
```
https://oasa-stop.<your-subdomain>.workers.dev
```
**Copy that URL.** That's your app.

> First deploy only: if it asks you to register a free `workers.dev` subdomain, follow
> the prompt (or do it once in the Cloudflare dashboard → Workers & Pages → pick a
> subdomain), then run `npx wrangler deploy` again.

---

## 5. Run it on your Android phone

1. Open **Chrome** on your phone and go to your `…workers.dev` URL.
2. When it asks, tap **Allow** for location. Your nearest stops appear with live
   countdowns; the thin bar at the very top is the 30-second refresh.
3. Install it like an app: Chrome menu (⋮) → **Add to Home screen** → Add. It now opens
   full-screen with its own icon, no browser bars.

   The app says this itself on the **last card of the first-run carousel**, with the
   steps for whichever device is reading — and on Chrome and Edge it offers a real
   **Install** button instead of instructions. Worth checking on the phone: the card
   should name Chrome's ⋮ menu, not iOS's Share sheet. The same steps are written out
   in ☰ → Settings → **FAQ** for anyone who skipped the card.

---

## 6. Check it's actually working

- **The board:** each stop shows its name + distance, and rows of `line · to
  destination · minutes`. Numbers should tick down and the list should refresh on its own.
- **The API, directly:** in any browser, open
  `https://<your-url>/api?act=getClosestStops&p1=37.9755&p2=23.7348`
  You should get a JSON list of stops. If you see JSON, the proxy works.
- **Location:** if the board shows Syntagma instead of where you are, location was
  blocked — tap **Αλλαγή / Change** and allow location, or in Chrome: site settings →
  Location → Allow.
- **Language:** ☰ → Γλώσσα / Language. About *and* Terms & privacy both follow it —
  check `/legal.html` in both settings.
- **☰:** opens Settings itself — your **alerts** (first row, with the count), language,
  hide-empty-stops, push, and the **FAQ**, whose last entry links **Terms & privacy**
  (`/legal.html`).
- **⌕ (first in the header):** find a line and preview its route, or find a stop by name.
- **Holding a stop** — in the list, on the map, on the stop card, or in a search result —
  blurs the board and offers **Pin / Unpin** and **Set alert**. Check it on a mouse too:
  the stop card must *not* open behind the menu.
- **Live reports:** tap the **orange dot** — the map shows only what's currently flagged
  (buses and metro stations), every flag one colour with its label above it, and
  **New report** underneath lets you file one. Test it
  from a bus: pick *On a bus*, give it ~15 s (it watches your GPS, then samples vehicle
  positions three times), then confirm your vehicle from the ranked list. One marked
  **✓ moving with you** is a confirmed report; picking a dashed one files an
  *unconfirmed* flag that shows hollow for 5 minutes until someone agrees. Withdraw your
  own from the list under the map. A station must be within 600 m.

### The padlock says the site is insecure

Almost always this is not the app — it is the edge serving plain HTTP. Typing a bare
`oasax.com` on a phone goes to `http://` first, and Cloudflare does **not** redirect to
HTTPS by default.

**Fix:** Cloudflare dashboard → your domain → **SSL/TLS → Edge Certificates** →
turn on **Always Use HTTPS**. While you are there, set **SSL/TLS encryption mode** to
**Full (strict)**.

If it persists, check in this order:

1. **Certificate still issuing.** Under Edge Certificates, the Universal certificate
   should say *Active*. It usually takes minutes; allow up to 24 hours.
2. **Mixed content.** Open the page on a desktop, F12 → Console, and look for "blocked
   mixed content". `npm test` fails if anything in the app fetches over `http://`, so
   this should never be the cause — but a stale cached page can be.
3. **A stale service worker** serving an old shell. Hard-refresh, or bump `SHELL` in
   `public/sw.js`.

`public/_headers` adds HSTS on top, so a browser that has been to the site once will
refuse plain HTTP by itself. That does nothing for a *first* visit, which is why the
redirect above is the actual fix and HSTS is only the reinforcement.

**On Full (strict).** Worth setting, but understand what it is: that mode governs how
Cloudflare talks to *your origin server*, and a Worker custom domain has no origin — the
code runs on the edge. It changes nothing about the padlock. It only starts to matter if
you later point a subdomain at a real server.

### HSTS at the edge — worth it, with two switches left off

SSL/TLS → Edge Certificates → **HTTP Strict Transport Security**. Enabling it here is
broader than `public/_headers`, which only covers the static files: the dashboard setting
applies to every response through the edge, the Worker's JSON endpoints included. Keep
both — the file travels with the repo if this is ever deployed elsewhere.

| Setting | Value |
|---|---|
| Enable HSTS | **On** |
| Max-Age | **6 months** to start |
| Apply HSTS to subdomains | **Off** |
| Preload | **Off** |
| No-Sniff header | On |

**`includeSubDomains` is unnecessary here.** `www` serves its own HSTS header on its own
first visit, so it is covered independently. Switching it on would force HTTPS onto every
future subdomain, including one set up later on something not ready for it.

**Preload is a one-way door.** It bakes the domain into the HTTPS-only lists compiled
into Chrome, Firefox and Safari. Undoing it means a removal request and then waiting for
browser *releases* — months, with nothing you can do in the meantime. The benefit is
negligible at this scale.

**Order matters, and this part is not reversible by flipping the switch back.** HSTS
tells browsers "never speak HTTP to this host again, for six months". Enable it while
something is misconfigured and visitors are locked into the broken state for that whole
period. So: Always Use HTTPS on → confirm the site loads over https → *then* HSTS.

### Walking times say "estimated"

The planner routes walking legs for real when a key is configured, and falls back to a
distance-aware straight-line estimate when it is not. To turn routing on:

```bash
npx wrangler secret put ORS_KEY     # free key from openrouteservice.org
```

Unlike the tile key this one is a **secret**: it stays in the Worker and never reaches a
browser. Without it nothing breaks, the app just says walking times are estimated.

**Check whether it is actually set:**
```powershell
curl.exe "https://oasax.com/health?token=$env:ADMIN_TOKEN"
```
Look for `"ors": true` under `bindings`. If it is `false`, walking legs will be drawn as
straight lines and house numbers resolve worse — the two symptoms have one cause.

`bindings` only appears when you are authenticated, and that needs a second secret:

```bash
npx wrangler secret put ADMIN_TOKEN   # any long random string you keep
npx wrangler secret list              # names only, never values
```

`secret list` answers the same question offline: if `ORS_KEY` is in that list, the Worker
has it. Without `ADMIN_TOKEN` set, `/health` still answers — it just returns `ok`, the
version and the time, and no `bindings` block, which is the point. There is no way to
read a secret's value back out of Cloudflare, by design; if you have lost it, put a new
one in.

> **PowerShell note.** `curl` there is an alias for `Invoke-WebRequest`, which parses the
> response and warns about script execution. Use **`curl.exe`** (the real one, shipped
> with Windows 10+) for anything that should just print the body, or
> `Invoke-RestMethod` if you want PowerShell to parse the JSON for you.

**Address estimates need no key and no account.** When no geocoder can find a house
number, the Worker asks the public Overpass API for the street and the numbered points
along it and estimates the position between them. Nothing to configure — but it is a
third-party service with a fair-use policy, so if you ever see estimated numbers stop
appearing, check that `overpass-api.de` is answering before looking anywhere else. The
app degrades to the street row, which is what it did before this existed.

The same key also powers **address search**. With it, typing a destination into the
journey planner matches partial words, ranks what is near you first, and finds street
addresses down to the house number. Without it the app falls back to OpenStreetMap's
Nominatim, which needs a more complete query and cannot be steered — usable, but
noticeably worse. One key, both features, no extra setup.

Type a street with a number — `Φιλοτίμου 12`, or `filotimou 12` — and it resolves to the
building, not the middle of the street: a query that looks like a complete address is sent
to Pelias's address parser rather than its prefix matcher.

**Budget.** Address search is the heavier of the two: one request per search that gets
past the 260 ms debounce, the 700 ms floor and three characters, cached at the edge for
24 hours and remembered in the page for the session. Journey planning spends at most four.
If you approach the daily quota, raise `JPQ.debounceMs` and `JPQ.minGapMs` in
`public/index.html` before you touch anything else.

## Putting it on your own domain

The app is **origin-relative throughout** — `start_url` and `scope` are `.`, the backend
is same-origin, no page link names a host — so moving it needs no code change at all.
What it needs is DNS.

**1. Point the domain at Cloudflare.** In the Cloudflare dashboard: **Add a site** →
type `oasax.com` → Free plan. Cloudflare shows you two nameservers, something like
`xxx.ns.cloudflare.com`. Go to whoever you bought the domain from, find **Nameservers**,
and replace what is there with those two. This is the step that takes time — usually
minutes, sometimes a few hours.

Check it landed:
```powershell
nslookup -type=NS oasax.com
```
You want Cloudflare's nameservers back, not your registrar's. While it still answers with
the registrar's, everything below will fail and that is expected, not broken.

**2. Attach the domain to the Worker.** Workers & Pages → your Worker → **Settings** →
**Domains & Routes** → **Add** → **Custom domain** → `oasax.com`. Add `www.oasax.com` the
same way if you want it. Cloudflare creates the DNS record and the certificate itself;
there is nothing to configure and no certificate to buy.

**3. Confirm it is really your Worker answering.**
```powershell
curl https://oasax.com/health
```
You want `{"ok":true,"version":"v78",...}` — the same version your Worker reports. A
registrar parking page or a certificate error means step 1 or 2 has not finished yet.
Then open `https://oasax.com` on your phone and check the board fills.

**4. Leave the old URL alone.** Both addresses now serve the same Worker. Anyone who
installed from `…workers.dev` keeps working exactly as before, because nothing moved.

**5. Only then, tell the old address it has moved.** In `public/index.html`:

```js
const MOVED_TO="https://oasax.com";
```

and redeploy. The `workers.dev` origin — and only that one — grows a dismissible line
saying where the app lives now, with a link. The new domain says nothing, because it is
the new home. Set this **after** step 3 passes: a banner pointing at a domain that does
not answer yet is worse than no banner.

**What does not follow anyone to the new address**, whatever you do:

- **Favourites, settings and the anonymous report id.** Browsers keep stored data per
  origin. Someone opening the new domain starts fresh and can no longer withdraw reports
  filed under the old id.
- **Push subscriptions.** Anyone with alerts set has to re-enable them. The VAPID keys
  can stay; the subscription cannot.
- **The install itself.** The home-screen icon still points at the old origin. That is
  what the banner in step 5 is for.

None of this is recoverable by any means, which is why the honest move is to keep both
origins alive indefinitely rather than to migrate anybody.

### One host, not two

`oasax.com` and `www.oasax.com` both answer, and to a browser those are **different
origins**. A PWA installed from one has its own local storage, its own favourites, its own
anonymous report id and its own push subscription; none of it is visible from the other.
Ship like this and you get two userbases that can never be merged, split by whether
someone typed `www`.

Pick one and redirect the other, before anyone installs. Free plan, no code:

1. Rules → **Redirect Rules** → Create rule.
2. If: `Hostname` **equals** `www.oasax.com`.
3. Then: **Dynamic** redirect, `concat("https://oasax.com", http.request.uri.path)`,
   status **301**, preserve query string.

Apex is the better canonical: it is shorter, it is what people will type, and it is what
the domain is called. Check it with `curl.exe -I https://www.oasax.com/` — you want a 301
to `https://oasax.com/`.

Cloudflare issues its certificate for both names either way, so nothing breaks at the TLS
layer while you decide.

### Blocking the scanner noise

A generic vulnerability scanner will sweep any domain within days of it resolving,
regardless of what is on it, asking for `.env`, `.git/config`, `/actuator/env`,
`/v2/_catalog`, cPanel, Confluence, Tomcat and forty more. None of it can succeed here —
the Worker has no filesystem, no framework and no secrets reachable by URL — but each
probe still spends a request, and they arrive in bursts of sixty.

Security → WAF → Custom rules, free plan allows five:

```
(http.request.uri.path contains "wp-")
or (http.request.uri.path contains "xmlrpc.php")
or (http.request.uri.path contains "/.env")
or (http.request.uri.path contains "/.git")
or (http.request.uri.path contains "/actuator")
or (http.request.uri.path contains "/.vscode")
or (http.request.uri.path contains "/v2/_catalog")
or (http.request.uri.path contains "login.action")
or (http.request.uri.path contains "/console/")
or (http.request.uri.path contains "info.php")
```

set to **Block**. Nothing the app serves matches any of those. It drops them at the edge
before the Worker is invoked, so they cost neither a request nor a log line.

Do **not** add a blanket rule on `/.well-known/`. That path is where certificate
validation and `security.txt` live, and the app answers the latter with a real address.

### Closing the `workers.dev` address

Only worth doing **before anyone has installed from it**. After that, the reasoning above
applies and the answer is no.

There is one switch. In `wrangler.toml`:

```toml
workers_dev = false
```

then `npx wrangler deploy`. The `…workers.dev` subdomain stops routing to the Worker and
answers with a Cloudflare error; `oasax.com` is untouched, because a custom domain is a
separate route. Set it back to `true` and redeploy to reopen it. Note that this also
takes away the per-version preview URLs, which is usually what you want and occasionally
not.

**Cloudflare Access cannot help here.** It protects hostnames in a zone you own, and
`workers.dev` is not one — there is no password to put in front of that subdomain.

**If you want it reachable but not public**, gate it in the Worker rather than at the
edge: check `new URL(req.url).hostname.endsWith(".workers.dev")` at the top of `fetch` and
return a 404 for anyone without a shared token in a cookie or a query parameter. That
keeps a working staging address for you while the public sees nothing, at the price of a
branch on every request.

**A note on your own phone.** If you installed the app from the `…workers.dev` URL while
testing, closing that address breaks *that* install — the icon opens to an error. Delete
it and reinstall from `oasax.com` before flipping the switch, and you will never think
about it again.

### How many people are using it?

**Step 1 — set an admin token, once.** Both endpoints refuse without it, and there is no
way to read a secret back out of Cloudflare, so keep a copy where you keep passwords.

```powershell
npx wrangler secret put ADMIN_TOKEN      # paste a long random string
npx wrangler secret list                 # names only; confirms it landed
```

**Step 2 — the daily series.** In PowerShell, `curl` is an alias for something that
mangles output, so use `curl.exe`:

```powershell
$env:ADMIN_TOKEN = "the-string-you-just-set"
curl.exe "https://oasax.com/stats/usage?token=$env:ADMIN_TOKEN&days=30"
```

On macOS or Linux the same call is plain `curl`. `days` accepts 1 to 365 and defaults to
30. What comes back is one row per day per kind:

| Kind | What it counts |
|---|---|
| `open` | The app was opened. Every cold start, browser tab or installed app alike. |
| `open_app` | Of those, the ones launched from a home-screen icon rather than a tab. |
| `install` | The browser reported a completed install. Fires once per install. |
| `cron` | Minutes the scheduler woke the Worker. Roughly 1,440 on a full day. |
| `alert` | Push notifications actually handed to a push service. |

`open_app` is your installed-user signal and `install` is your growth signal. Neither is a
count of people — see below.

**Step 3 — the one-glance summary.**

```powershell
curl.exe "https://oasax.com/health?token=$env:ADMIN_TOKEN"
```

Without a token this returns only `ok`, the version and the time, which is deliberate.
With one it adds `bindings` (is the ORS key set, is push configured, is D1 there),
`reports.activeNow`, `alerts.rules`, `usage` for today and the last 30 days, and the two
fields that say whether alerts can work at all:

- `cron.agoSec` — seconds since the scheduler last woke the Worker. Under 120 on a
  healthy deployment. Null or thousands means **the cron is not running**, and no alert
  will ever fire until that is fixed.
- `alerts.lastSent` — when a push last went out. Null means none ever has.

**Step 4 — the dashboard, for what the app cannot see.** Workers & Pages → your Worker →
**Metrics** gives requests, errors and CPU time per day, and **Logs** → *Begin log stream*
shows live requests including the cron firing. That is the place to confirm the scheduler
is alive if `/health` says it is not.

**What none of this can tell you.** There is no active-tab or concurrent-user figure, and
no unique-visitor count. The app sends one beacon per cold start carrying a single word
and stores nothing but a running daily total: no id, no session, no coordinates. It cannot
distinguish two opens by one person from one open each by two, and that is the design, not
a gap. Twenty `open` and eight `open_app` on a Tuesday means twenty openings, of which
eight came from an installed icon. Any "users" number is your own inference from that.

### Telling everyone something, without shipping a version

One card in the middle of the app, in your own words, switched on and off with a request.
No deploy, no cache purge, no wait — which matters, because the moment you need this is
the moment deploying is least appealing.

**Once, if you have not already:**

```powershell
npx wrangler secret put ADMIN_TOKEN      # any long random string; keep a copy
$env:ADMIN_TOKEN = "the-string-you-just-set"
```

**Step 1 — write the message to a file.** Do not try to put Greek inside a PowerShell
command line; the quoting and the encoding will both bite you. Copy
`notice.example.json` in the project root to `notice.json` and edit it. It is not
committed and is not served — it exists only to be posted from. Saved as **UTF-8**:

```json
{
  "id": "maint-2026-09-14",
  "el": "Κάνουμε εργασίες συντήρησης. Κάποια στοιχεία μπορεί να λείπουν για λίγο.",
  "en": "We are doing maintenance. Some information may be missing for a while."
}
```

In VS Code the encoding is in the status bar, bottom right — it should say UTF-8, not
UTF-8 with BOM.

**Step 2 — put it up.**

```powershell
curl.exe -X POST "https://oasax.com/notice" `
  -H "X-Admin-Token: $env:ADMIN_TOKEN" `
  -H "Content-Type: application/json" `
  --data-binary "@notice.json"
```

You want `{"ok":true,"notice":{...}}` back. Reload the app and the card is there.

**Step 3 — check what is live.** Public, no token:

```powershell
curl.exe https://oasax.com/notice
```

`{}` means nothing is showing.

**Step 4 — take it down.** This one is plain ASCII, so inline is fine:

```powershell
curl.exe -X POST "https://oasax.com/notice" -H "X-Admin-Token: $env:ADMIN_TOKEN" `
  -H "Content-Type: application/json" -d "{\"clear\":true}"
```

Three things worth knowing:

- **The heading is the app's, not yours.** Every notice appears under *Maintenance* /
  *Εργασίες συντήρησης* with a 🛠. You supply the sentence underneath, so the tone stays
  the same however hurried you are when you write it.
- **`id` is what dismissal is remembered against.** Each reader sees a given notice once.
  Change the `id` for a genuinely new message; editing only the words leaves it dismissed
  for everyone who already closed the old one.
- **Write both languages.** It follows the language in Settings and falls back to
  whichever one is filled in, so a Greek-only notice still reaches an English reader.

### Reading the numbers

The dashboard draws a graph and gives you no figures, so "is that spike real people or a
scanner" cannot be answered by looking at it. `npm run metrics` prints the figures.

**Step 1 — make a token.** dash.cloudflare.com → the account menu, top right → **Profile**
→ **API Tokens** → **Create Token** → **Create Custom Token**.

- Permissions: **Zone** → **Analytics** → **Read**. That one row, nothing else.
- Zone Resources: **Include** → **Specific zone** → `oasax.com`.
- Create, then copy the token. It is shown once.

**Step 2 — find the zone id.** dash.cloudflare.com → `oasax.com` → **Overview**. It is in
the right-hand column, under API, labelled **Zone ID**.

**Step 3 — run it.**

```powershell
$env:CF_API_TOKEN = "the-token"
$env:CF_ZONE_ID   = "the-zone-id"
npm run metrics            # last 30 days
node tools/metrics.mjs 7   # or any number of days
```

You get one row per day: requests, how many were served from cache, Cloudflare's own
unique-visitor estimate, and how many requests it blocked outright as threats.

That `uniques` column is the closest thing to a userbase figure that exists without
tracking anyone. It is computed at the edge from addresses, with no cookie and no script,
and it over-counts a phone moving between wifi and mobile data while under-counting a
household behind one address. Read it as a shape, not a headcount.

Paste the whole table when you want it read. The other half worth sending is your own
counter, which sees people rather than requests:

```powershell
curl.exe "https://oasax.com/stats/usage?token=$env:ADMIN_TOKEN&days=30"
```

Comparing the two is what separates users from bots: scanners generate requests and never
send an `open`.

### The board is empty, or stuck on loading

The app's own screen answers most of this now: it distinguishes "still waiting", "nothing
due on this street" and "we failed, here is why". If it says **OASA is not responding**,
that is the whole story and there is nothing to do but wait — OASA's telematics API goes
down, and no amount of redeploying will bring it back.

To confirm from outside, run these three in order. Each rules out one layer:

```powershell
curl.exe -i https://oasax.com/health
curl.exe -i "https://oasax.com/nearby?lat=37.9755&lng=23.7348&radius=450&limit=14&markers=120"
curl.exe -i "https://oasax.com/health?token=$env:ADMIN_TOKEN&probe=1"
```

| What you see | What it means |
|---|---|
| `/health` not 200 | Cloudflare or your Worker. Check Redirect Rules and WAF first, not the code. |
| `/health` fine, `/nearby` returns `503` with `"upstream":"down"` | OASA is not answering the Worker. Nothing to fix. |
| `/nearby` returns `200` with a non-empty `stops` array | The backend is healthy; the problem is on the device. |
| `probe=1` shows `oasa.ok: false` | Same as the 503, stated directly, with the time it waited. |

`probe=1` is opt-in because it spends a real call on a slow upstream. Without it `/health`
stays instant, which is the point of a health check.

**A 502 from `/api`** with `{"error":"upstream timeout"}` is the same diagnosis from the
raw proxy: OASA took longer than 8 seconds, twice. It is the clearest single signal that
the fault is upstream and not yours.

### An alert didn't arrive

Work down this list; each step rules out one half of what is left.

**0. Is push configured on the server at all?** This is the one to check first, because it
is invisible from the app until you try:

```powershell
curl.exe "https://oasax.com/push/key"
```

`{"key":"B..."}` means it is set up. `{"error":"push not configured"}` with a **501** means
the Worker has no VAPID keys, alerts have never worked and never will until you follow
`PUSH-SETUP.md`: `node genkeys.mjs`, then `npx wrangler secret put VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, then redeploy. `npx wrangler secret list` shows
which of the three are already there. This is also the only failure the app is entitled to
blame on the server, and since v59 it is the only one it does.

**1. Does any notification reach the device?** In the app: 🔔 → **Send test notification**.
Since v70 the result names the push service's own verdict instead of "not sent", which
is the fastest way to tell the halves apart:

| What it says | What it means |
|---|---|
| `answered 401` or `403` | The VAPID keys are wrong or missing. Re-run `PUSH-SETUP.md`. |
| `answered 404` or `410` | This subscription is retired. The Worker forgets it; reload and set the alert again. |
| `answered 400` | The push service rejected the payload. Report this — it is a bug in the Worker, not your setup. |
| `Push isn't configured…` | `/push/key` returned 501. The Worker has no VAPID keys at all. |

If that does not arrive, no bus alert ever will, and the cause is on the phone:

- **iPhone or iPad** must have the app on the **Home screen** and be opened from there.
  iOS delivers push only to an installed web app, never to a Safari tab, and needs
  iOS 16.4 or later. This is the single most common cause and it looks exactly like a
  broken app.
- **Permission** must be granted. A browser asks once; a dismissed prompt is not asked
  again and has to be changed in the site's settings.
- **Battery savers** on some Android phones delay delivery rather than stopping it.
- **Brave** ships with Google's push service turned off, on desktop and Android alike.
  Every permission reads as granted and `pushManager.subscribe()` rejects anyway. Open
  `brave://settings/privacy`, turn on **Use Google services for push messaging**, restart
  the browser. The app now names this case instead of blaming the server for it.

The app does **not** need to be open, on any platform. If it did, the feature would be
pointless, and any advice to keep it running in the background is wrong.

**2. Is the scheduler running?**

```powershell
curl.exe "https://oasax.com/health?token=$env:ADMIN_TOKEN"
```

`cron.agoSec` should be under 120. If it is null or large, alerts are dead at the source:
check that `wrangler.toml` still has a `[triggers]` block with `crons`, and that Workers &
Pages → your Worker → **Settings → Trigger Events** lists them. Redeploy to restore them.

> **The trap this had.** With `CF_API_TOKEN` and `CF_ACCOUNT_ID` set, the Worker narrows
> its own cron schedule nightly to the hours your rules actually need. If it ever ran with
> no rules it wrote an *empty* schedule — and the run that would put the triggers back is
> itself a trigger, so alerts stopped permanently and silently. Since v58 the schedule
> always contains the daily maintenance minute and an empty one is refused outright. If
> you are on an older deploy and `Trigger Events` is empty, that is what happened; a
> redeploy fixes it.

**3. The test arrives but a real alert never does.** That sentence describes a chain with
eight links in it. Ask the Worker which one broke:

```powershell
curl.exe "https://oasax.com/alerts/why?token=$env:ADMIN_TOKEN"
```

It walks the same gates the cron walks, for every stored rule, and sends nothing.

**Read the three top-level fields first** — they are about the machinery, not any one
rule, and a rule that looks perfect cannot fire if these are wrong:

| Field | What to look for |
|---|---|
| `cron` | `healthy: true` means the scheduler is calling the Worker. `healthy: false` means **nothing can fire, however correct every rule is** — check `[triggers]` in `wrangler.toml` and Workers & Pages → your Worker → Settings → Trigger Events, then redeploy. This is the one fault that makes a perfect `WOULD FIRE` verdict meaningless. |
| `lastPush` | What happened the last time an alert was actually attempted: the rule, route, vehicle, lead, and the push service's own answer. `ok: false` with a `status` is the push service refusing — 401/403 is the VAPID keys, 404/410 a subscription the browser has retired, 400 the encryption. `"no alert push has ever been attempted"` with a healthy cron means no rule has ever got as far as sending. |
| `lastDelivered` | How long ago a push last went out successfully. |
| `lastCronWithWork` | The last cron minute that found a rule inside its window — the stretch between "the scheduler is calling us" and "a push was attempted". `due` says a window was open; `stops` says what OASA answered for each one (`13 arrivals`, `NO ANSWER from OASA on this run`, or `SKIPPED — circuit open`); `attempts` counts pushes tried; `stopped` names the early exit if there was one; `threw` carries a stack if the run died. Quiet minutes never overwrite it. |

Then read the per-rule fields:

| Field | What to look for |
|---|---|
| `subscription` | `found`, or `MISSING — no sub:… in KV`. **Missing is the common one:** a rule saved on one device names that device's subscription, so testing on a second device proves nothing about it. Delete the rule and set it again from the phone you expect to be notified on. |
| `blocked` | The rule never got as far as looking at buses. It names the day or the window, with the hours the rule is actually live — which include the lead time, so a 08:30 rule with a 10-minute lead goes live at 08:19. |
| `verdict` | It looked. Each line says what it found: `WOULD FIRE`, a route that is not yours, a bus further away than any lead, a bus arriving outside your window, or `no arrivals at this stop at all`. |

Run it **inside the window you set**, with a bus actually due. Outside the window every
rule reports `blocked`, correctly and uselessly.

**3a. Fire one right now, by hand.** This is the fastest way to separate
"the scheduler cannot do it" from "push is broken", because it runs the real alert
logic, sends real notifications, and prints the whole trace:

```powershell
curl.exe -H "X-Admin-Token: $env:ADMIN_TOKEN" "https://oasax.com/alerts/run"
```

Run it inside a window with a bus due. If your phone buzzes, the alert logic and the push
chain are both fine and the fault is in the cron's context — check `via` in
`lastCronWithWork`. If it does not, read `attempts` and `stops` in what it prints.

> **Why this endpoint exists.** The same OASA call succeeded every time from a request and
> aborted every time from a cron — for weeks, not intermittently. Rather than keep guessing
> at the cause, the cron now pokes this URL over HTTP so the arrivals fetch happens inside a
> normal request, which demonstrably works. `via` in the trace says which path served a run:
> `request` is the good path, `in-process (…)` means the self-call could not be made and
> says why.

**3b. `WOULD FIRE` but the phone stayed quiet.** The rule is right; something downstream
of it is not. In order of likelihood:

- **`cron.healthy` is false.** Nothing is calling `runAlerts`. Fix the triggers.
- **`lastPush.ok` is false.** The push service refused; `status` and `detail` say why.
- **`lastPush` is a different rule, or missing entirely.** The run is not reaching this
  rule. Read `lastCronWithWork`: `stops` says whether OASA answered, `stopped` names the
  early exit, `threw` carries the stack if the run died. Note `upstream.open` in the top
  of the response reflects the *web* isolate — a cron runs in its own, so a circuit can be
  open there and closed here; `stops` is the one that tells you about the cron's isolate.
  Since v75 the alert path is exempt from the breaker entirely, so a stop that reports
  `NO ANSWER from OASA on this run` names the real upstream failure after the dash.
- **`subscription` is `found` but the phone is a second device.** A rule names the
  subscription of the device it was made on. The push is being delivered — to the other
  phone.

**4. Does the rule match?** `alerts.rules` in `/health` is how many are active, and
`alerts.dueNow` says whether any window is open at this moment. An alert fires only for a
vehicle **arriving inside the window you set** — a bus five minutes away at 08:20 does not
match an 08:30–08:50 rule. Widen the window to test.

### The logo changed but the installed icon didn't

The home-screen icon is a PNG, not the CSS mark, so it does not follow a stylesheet
edit. Rebuild it:

```powershell
npm run icons        # needs a Chromium; set CHROME_PATH if it is not found
npx wrangler deploy
```

Already-installed phones keep the old icon until the launcher refreshes it — usually a
reinstall. `npm test` fails if the icons and the mark have drifted apart, so this is
caught before it ships rather than after.

### The map is covered in "API KEY REQUIRED"

CARTO started requiring a key for their basemaps in August 2026. Get a free one at
<https://carto.com/basemaps/apikey>, paste it into `TILE_KEY` near the top of the
script block in `public/index.html`, and redeploy. Restrict it to your domain in
CARTO's dashboard — it is visible in the page source, as every browser-side tile key
is. Leave `TILE_KEY` empty and the app uses OpenStreetMap tiles instead, which need
no key but are a donated service meant for small projects.

### If something's off
- **Empty boards / "no arrivals":** normal late at night or on quiet lines — check a
  central stop (Change → Syntagma) during the day to confirm data is flowing.
- **`npx wrangler deploy` complains about account/auth:** run `npx wrangler login` again.
- **Nothing loads on the phone but the `/api?...` URL returns JSON:** hard-refresh (pull
  down in Chrome) — the old service-worker shell may be cached. You can also bump
  `SHELL = "stop-shell-v41"` to `v42` in `public/sw.js` and redeploy to force an update.

---

## Branches

`main` is what gets deployed. **`backup`** holds the previous release, and is
force-updated to the outgoing version each time a new one lands on `main`, so
there is always exactly one branch to fall back to:

```bash
git push -f origin <previous-release-sha>:refs/heads/backup
```

Reviving it is `git checkout backup && npx wrangler deploy` — bump `SHELL` in
`public/sw.js` first, or phones will keep serving the shell they cached from the
version you are rolling back from.

---

## Updating later

Change any file, then just:
```powershell
npx wrangler deploy
```
The same URL updates. On the phone, pull to refresh (or reopen) to pick up changes.

## Before you publish it publicly

1. **Contact address:** `oasax@proton.me`, in `PRIVACY.md`, `TERMS.md` and
   `public/legal.html`. It is the GDPR contact and the DSA notice-and-action
   channel — make sure the inbox is actually monitored.
2. **Pick your URL first, not later.** Push subscriptions and PWA installs are bound to
   the origin: change the URL after people install and their alerts go dead and their
   home-screen icon points at the old address. Renaming the worker in `wrangler.toml`
   creates a *new* worker and needs the secrets re-uploaded; attaching a **custom
   domain** to the existing worker (Workers & Pages → your worker → Settings → Domains
   & Routes → Add → Custom Domain) changes the URL with no code change and no secret
   re-upload.
3. **Check the About screen** still carries the "unofficial · not affiliated with OASA"
   banner, and say the same in your launch post.

## Costs

Cloudflare's free tier covers 100,000 requests/day — far more than personal use. No card
required to deploy on `workers.dev`.
