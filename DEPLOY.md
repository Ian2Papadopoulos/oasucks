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
   should name Chrome's ⋮ menu, not iOS's Share sheet. It is reachable again from
   ☰ → Settings → **How it works**.

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
- **Language:** ☰ menu → Γλώσσα / Language. About *and* Terms & privacy both follow it —
  check `/legal.html` in both settings.
- **☰ menu:** find a line and preview its route, live bus map, language, about, and
  **Terms & privacy** (`/legal.html`).
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
straight lines and house numbers will not resolve — the two symptoms have one cause.

> **PowerShell note.** `curl` there is an alias for `Invoke-WebRequest`, which parses the
> response and warns about script execution. Use **`curl.exe`** (the real one, shipped
> with Windows 10+) for anything that should just print the body, or
> `Invoke-RestMethod` if you want PowerShell to parse the JSON for you.

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
You want `{"ok":true,"version":"v50",...}` — the same version your Worker reports. A
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

### How many people are using it?

```powershell
curl "https://<your-url>/stats/usage?token=$ADMIN_TOKEN&days=30"
```

Daily totals of `open`, `open_app` (launched from a home-screen icon) and `install`.
`/health?token=…` carries the headline figures too, and the Cloudflare dashboard
(Workers & Pages → your Worker → **Metrics**) gives raw requests per day for free.

These count **openings, not people** — nothing identifying is stored, so no unique-user
figure exists or can be derived. See the README for why, and for what changing that would
cost.

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
  `SHELL = "stop-shell-v40"` to `v41` in `public/sw.js` and redeploy to force an update.

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
