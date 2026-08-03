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
git clone https://github.com/Ian2Papadopoulos/oasucks.git
cd oasucks
```

## 2. Open a terminal *in that folder*

If you cloned from the command line you're already there. Otherwise open the `oasucks`
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
- **Language:** ☰ menu → Γλώσσα / Language.
- **☰ menu:** find a line and preview its route, live bus map, language, about.
- **Reports:** tap the red **!** — the map shows only what's currently flagged (buses
  and metro stations), and **Report an issue** underneath lets you file one. Test it
  from a bus: pick *On a bus*, wait for the candidate list, confirm your vehicle, pick
  the issue. Withdraw your own report from the list under the map; it disappears for
  everyone. You can't report a bus you're not on, or a station more than 600 m away.

### If something's off
- **Empty boards / "no arrivals":** normal late at night or on quiet lines — check a
  central stop (Change → Syntagma) during the day to confirm data is flowing.
- **`npx wrangler deploy` complains about account/auth:** run `npx wrangler login` again.
- **Nothing loads on the phone but the `/api?...` URL returns JSON:** hard-refresh (pull
  down in Chrome) — the old service-worker shell may be cached. You can also bump
  `SHELL = "stop-shell-v13"` to `v14` in `public/sw.js` and redeploy to force an update.

---

## Updating later

Change any file, then just:
```powershell
npx wrangler deploy
```
The same URL updates. On the phone, pull to refresh (or reopen) to pick up changes.

## Costs

Cloudflare's free tier covers 100,000 requests/day — far more than personal use. No card
required to deploy on `workers.dev`.
