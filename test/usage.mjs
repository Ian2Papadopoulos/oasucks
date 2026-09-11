/* The usage counter, and the splash.

   The counter is the feature with the sharpest edge in this codebase: it
   is the one place the app measures its own users, and the app's whole
   promise is that it does not measure them. So most of what follows is
   not "does it count" — it is "does it store anything it must not".
   `bumpUsage` is called with a real D1 stub and every statement it issues
   is inspected for an IP, a token, a user agent, a coordinate.

   worker.js runs in a vm; the splash is checked in a real browser,
   because "how long does a logo stay on screen" is a question about
   timing and CSS. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { TOUR_FLAG } from "./_tour.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

/* ---------------------------- the Worker ---------------------------- */

let sql = [];                       // every statement, with its bindings
let rows = [];                      // what a SELECT hands back
const stmt = q => ({
  _q: q, _b: [],
  bind(...b) { this._b = b; sql.push({ q, b }); return this; },
  async all() { sql.push({ q, b: this._b }); return { results: rows }; },
  async run() { return { success: true }; },
});
const DB = {
  prepare: q => stmt(q),
  async batch(list) { return list.map(() => ({ success: true })); },
};

const src = readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler =");
const ctx = {
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, URLSearchParams,
  Request, Response, Headers, TextEncoder, TextDecoder, btoa, atob, WeakMap, Symbol,
  Error, TypeError, RegExp, Uint8Array, ArrayBuffer, DataView,
  encodeURIComponent, decodeURIComponent,
  AbortController: class { constructor() { this.signal = null; } abort() {} },
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: { default: { async match() {}, async put() {} } },
  fetch: async () => { throw new Error("no network in the harness"); },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
ctx.__DB = DB;

const call = (path, { method = "POST", token, env = { DB } } = {}) => {
  sql = [];
  const e = { ...env };
  if (token) e.ADMIN_TOKEN = token;
  ctx.__req = new Request("https://x" + path, { method });
  ctx.__env = e;
  return vm.runInContext(`__handler.fetch(__req, __env, { waitUntil(){}, passThroughOnException(){} })`, ctx);
};
const body = async r => { try { return await r.json(); } catch (_) { return null; } };

console.log("\n— it counts —");
{
  const r = await call("/pulse?mode=web");
  const j = await body(r);
  ok("a cold boot is accepted", r.status === 200 && j.ok === true, JSON.stringify(j));
  ok("...and counted", j.counted === true);
  const kinds = sql.flatMap(s => s.b).filter(x => typeof x === "string" && /^(open|open_app|install)$/.test(x));
  ok("a browser tab counts as one open", kinds.join(",") === "open", kinds.join(","));
}
{
  await call("/pulse?mode=app");
  const kinds = sql.flatMap(s => s.b).filter(x => /^(open|open_app|install)$/.test(x));
  ok("a home-screen launch counts as an open AND an app open",
    kinds.includes("open") && kinds.includes("open_app"), kinds.join(","));
}
{
  await call("/pulse?ev=install");
  const kinds = sql.flatMap(s => s.b).filter(x => /^(open|open_app|install)$/.test(x));
  ok("an install is its own kind, and not also an open",
    kinds.join(",") === "install", kinds.join(","));
}
{
  const r = await call("/pulse?mode=web", { method: "GET" });
  ok("a GET cannot inflate the count from an address bar", r.status === 405);
}
{
  const r = await call("/pulse?mode=nonsense");
  const kinds = sql.flatMap(s => s.b).filter(x => /^(open|open_app|install)$/.test(x));
  ok("an unknown mode falls back to a plain open rather than failing",
    r.status === 200 && kinds.join(",") === "open", kinds.join(","));
}
{
  const r = await call("/pulse?mode=web", { env: {} });   // no D1 bound
  const j = await body(r);
  ok("with no database the beacon is accepted and dropped",
    r.status === 200 && j.ok === true && j.counted === false, JSON.stringify(j));
  ok("...and nothing was written", sql.length === 0);
}

console.log("\n— and it stores nothing else —");
{
  await call("/pulse?mode=app");
  const all = JSON.stringify(sql);
  for (const [what, re] of [
    ["an IP address", /\bip\b|\d+\.\d+\.\d+\.\d+|cf-connecting/i],
    ["a user agent", /user.?agent|mozilla|chrome/i],
    ["a device or session id", /\bsub_?id|session|device|token|uuid/i],
    ["coordinates", /\blat\b|\blng\b|\blon\b/i],
    ["anything hashed, which is an identifier wearing a hat", /hash|sha|digest|fingerprint/i],
  ]) {
    ok(`no ${what} reaches the database`, !re.test(all), all.slice(0, 120));
  }
  const bound = sql.flatMap(s => s.b);
  ok("only a date and a kind are ever bound",
    bound.every(b => /^\d{4}-\d{2}-\d{2}$/.test(b) || /^(open|open_app|install)$/.test(b)),
    JSON.stringify(bound));
  ok("the day is an Athens calendar day, not UTC",
    /timeZone: "Europe\/Athens"/.test(src.slice(src.indexOf("function dayKey"), src.indexOf("function dayKey") + 300)),
    "or a night bus at 01:00 lands on the wrong day");
}
{
  /* The schema is the durable promise: a column that does not exist
     cannot be filled in later by accident. */
  const create = (src.match(/CREATE TABLE IF NOT EXISTS usage\([^`]*\)/s) || [""])[0];
  ok("the table has three columns and no room for a fourth",
    /day TEXT/.test(create) && /kind TEXT/.test(create) && /n INTEGER/.test(create)
    && !/ip|user|device|session/i.test(create), create.replace(/\s+/g, " "));
}

console.log("\n— reading it back —");
{
  rows = [
    { day: "2026-09-07", kind: "open", n: 412 },
    { day: "2026-09-07", kind: "open_app", n: 38 },
    { day: "2026-09-06", kind: "open", n: 380 },
    { day: "2026-09-06", kind: "install", n: 9 },
  ];
  const j = await body(await call("/stats/usage?days=30&token=T", { method: "GET", token: "T" }));
  ok("the series comes back by day", !!j.byDay && !!j.byDay["2026-09-07"], JSON.stringify(j).slice(0, 80));
  ok("...with the kinds under each", j.byDay["2026-09-07"].open === 412);
  ok("...and totals across the window",
    j.total.open === 792 && j.total.open_app === 38 && j.total.install === 9,
    JSON.stringify(j.total));
}
{
  const r = await call("/stats/usage?days=30", { method: "GET", token: "T" });
  ok("without the admin token it is refused", r.status === 403);
}
{
  const r = await call("/stats/usage?days=30&token=T", { method: "GET", token: "T", env: {} });
  ok("with no database it says so rather than pretending zero", r.status === 501,
    String(r.status));
}
{
  rows = [];
  await call("/stats/usage?days=9999&token=T", { method: "GET", token: "T" });
  const day = sql.flatMap(s => s.b).find(b => /^\d{4}-\d{2}-\d{2}$/.test(b));
  ok("an absurd window is clamped rather than scanning everything", !!day, String(day));
}
{
  rows = [{ day: "2026-09-07", kind: "open", n: 5 }];
  const j = await body(await call("/health?token=T", { method: "GET", token: "T" }));
  ok("/health carries the headline numbers", !!j.usage, JSON.stringify(j.usage || {}));
  ok("...and says out loud that they are opens, not people",
    /opens, not people/.test((j.usage || {}).note || ""), (j.usage || {}).note);
}

/* ----------------------------- the splash ---------------------------- */
console.log("\n— the splash —");
const NOW = Math.floor(Date.now() / 1000);
const LAT = 37.976, LNG = 23.73;
const stops = [{ code: "500", name_el: "ΚΟΝΤΑ", name_en: "NEAR", lat: LAT, lng: LNG, dist: 40,
  detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V1", min: 4 }] }];
let stall = 0, pulses = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/pulse") { pulses.push(u.search); res.writeHead(200,
    { "Content-Type": "application/json" }); return res.end('{"ok":true}'); }
  // the mode probe: is there a Worker on this origin
  if (u.pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true,"version":"test"}'); }
  if (u.pathname === "/nearby") {
    if (stall) await new Promise(r => setTimeout(r, stall));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] }));
  }
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    res.writeHead(200, { "Content-Type": e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]");
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function boot({ standalone = false } = {}) {
  pulses = [];
  const c = await browser.newContext({ viewport: { width: 390, height: 780 },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(([s, tf]) => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf); } catch (_) {}
    if (s) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /display-mode: standalone/.test(q)
        ? { matches: true, media: q, addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {} } : mm(q);
    }
  }, [standalone, TOUR_FLAG]);
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "commit" });
  return { page, ctx: c, errs };
}
const covered = p => p.evaluate(() => {
  const s = document.getElementById("splash");
  return !!s && !s.classList.contains("gone");
});

{
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("it is in the markup, ahead of the app itself",
    html.indexOf('class="splash"') < html.indexOf('class="wrap"'),
    "added by script it would arrive a frame or two late, after a white flash");
  const b = await boot();
  await b.page.waitForTimeout(80);
  ok("...so it is covering the screen before the board is fetched",
    await covered(b.page));
  const mark = await b.page.evaluate(() => {
    const m = document.querySelector("#splash .mark");
    if (!m) return null;
    const a = getComputedStyle(m, "::after"), b2 = getComputedStyle(m, "::before");
    return { text: m.textContent, bg: getComputedStyle(m).backgroundColor,
             strike: [a.backgroundColor, b2.backgroundColor],
             turned: [a.transform, b2.transform] };
  });
  ok("...and it is the graphic mark", mark && mark.text === "OASA", JSON.stringify(mark));
  /* The splash wears the ORIGINAL strike, not the icon's yellow X: two
     crossed rules, both in paper white, both rotated. Black and white on
     purpose — the colour belongs to the icon. */
  ok("...struck through by two rules, not marked with an X",
     mark && mark.turned.every(x => /matrix/.test(x)), JSON.stringify(mark && mark.turned));
  ok("...and in black and white", mark && mark.strike.every(c => /255, 255, 255|247, 247, 245/.test(c)),
     JSON.stringify(mark && mark.strike));
  await b.page.waitForTimeout(200);
  ok("it does not flash away instantly on a fast load", await covered(b.page),
    "under SPLASH.minMs a quick load would strobe");
  await b.page.waitForTimeout(1400);
  ok("...but it is gone once the board is up", !(await covered(b.page)));
  ok("no page errors", b.errs.length === 0, b.errs.join(" | "));
  await b.ctx.close();
}
{
  stall = 9000;                                  // a network that never answers
  const b = await boot();
  await b.page.waitForTimeout(3200);
  ok("a dead network cannot trap anyone on a logo", !(await covered(b.page)),
    "SPLASH.maxMs is the promise this keeps");
  await b.ctx.close();
  stall = 0;
}
{
  const b = await boot();
  await b.page.waitForTimeout(1500);
  const brand = await b.page.evaluate(() => $(".brand").innerText.trim());
  ok("the loaded header carries the wordmark", /OASAX/i.test(brand.replace(/\s/g, "")), brand);
  ok("...and not the graphic mark as well",
    await b.page.evaluate(() => !document.querySelector("header .mark")),
    "it used to say the same word twice, side by side");
  await b.ctx.close();
}

console.log("\n— the beacon, from the app —");
{
  const b = await boot();
  await b.page.waitForTimeout(1500);
  ok("one beacon per boot, and only one", pulses.length === 1, JSON.stringify(pulses));
  ok("...a browser tab reports itself as web", /mode=web/.test(pulses[0] || ""), pulses[0]);
  await b.ctx.close();
}
{
  const b = await boot({ standalone: true });
  await b.page.waitForTimeout(1500);
  ok("an installed launch reports itself as app", /mode=app/.test(pulses[0] || ""), pulses[0]);
  await b.ctx.close();
}
{
  const b = await boot();
  await b.page.waitForTimeout(1500);
  const url = pulses[0] || "";
  ok("the beacon carries nothing but the mode",
    !/lat|lng|id=|token|uuid/.test(url), url);
  await b.ctx.close();
}

console.log("\n— and the documents say so —");
{
  /* A counter the terms deny is worse than no counter. The moment the app
     started measuring anything, "no analytics" stopped being true, and
     these check the wording followed the code. */
  const legal = readFileSync(path.join(PUB, "legal.html"), "utf8");
  const priv = readFileSync(path.join(REPO, "PRIVACY.md"), "utf8");
  const app = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("the flat 'no analytics' claim is gone from the terms",
    !/No analytics/i.test(legal) && !/Χωρίς analytics/i.test(legal),
    "it was true until the counter shipped, and then it was not");
  ok("...and from PRIVACY.md", !/No analytics/i.test(priv));
  ok("...and from About, both languages",
    !/no analytics/i.test(app) && !/διαφημίσεις ή analytics/i.test(app));
  ok("en: the terms explain the counter", /How many people use it/.test(legal));
  ok("el: so do the Greek terms", /Πόσοι το χρησιμοποιούν/.test(legal));
  ok("both say it counts openings rather than people",
    /openings, not people/.test(legal) && /ανοίγματα, όχι ανθρώπους/.test(legal));
  ok("...and About says the same, in short",
    /counts openings, not people/.test(app) && /ανοίγματα, όχι ανθρώπους/.test(app));
  ok("the retention list mentions the totals",
    /Daily opening totals/.test(legal) && /Daily opening totals/.test(priv));
}

/* An alert that never arrives and a scheduler that stopped calling look
   identical from outside the Worker. These are the two switches that made
   the difference visible, and the one that could silently turn the whole
   thing off. */
console.log("\n— proof that the scheduler is alive —");
{
  const cronFor = vm.runInContext("cronFor", ctx);
  const applySchedule = vm.runInContext("applySchedule", ctx);

  const none = cronFor([]);
  ok("no alert rules still leaves a cron running", none.length > 0, JSON.stringify(none));
  /* The run that widens the schedule again happens at 04:00 Athens. Leave
     that hour out and a narrowed schedule can never grow back, so the
     first rule written tomorrow would never fire and nothing would say
     why. It has to be in every schedule we emit. */
  const maint = vm.runInContext("maintenanceCron", ctx)();
  ok("...and it is the daily maintenance minute", none.includes(maint), maint);

  const some = cronFor([{ days: [1, 2, 3, 4, 5], from: 8 * 60 + 30, to: 8 * 60 + 50, lead: 10 }]);
  ok("a schedule built from real rules covers the window",
    some.some(c => /^\* /.test(c)), JSON.stringify(some));
  ok("...and still carries the maintenance minute", some.includes(maint), JSON.stringify(some));

  const env = { CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" };
  const empty = await applySchedule(env, []);
  ok("an empty schedule is refused, never PUT",
    /refused/.test(empty.skipped || ""), JSON.stringify(empty));
  ok("...and so is a missing one", /refused/.test((await applySchedule(env, null)).skipped || ""),
    "one PUT of [] removes every trigger, and only a trigger can put them back");
}
{
  rows = [];
  const r = await call("/health?token=k", { method: "GET", token: "k", env: { DB } });
  const j = await body(r);
  ok("health reports whether the cron is still running",
    j && j.cron && "agoSec" in j.cron && "healthy" in j.cron, JSON.stringify(j && j.cron));
  ok("...and a Worker that has never run one says so, rather than looking fine",
    j.cron.healthy === false && j.cron.lastRun === null, JSON.stringify(j.cron));
}

/* The wording people read when an alert does not arrive. "Keep the app
   open" would be the wrong advice as well as untrue — what an iPhone
   actually needs is the app on the Home screen. */
/* Vulnerability scanners ask for this dozens of times a day, and so, very
   occasionally, does a person with something to report. One contact
   address exists; this is where a researcher is trained to look for it. */
/* A client that keeps hammering a host which has stopped answering turns
   a rate limit into a ban, and makes every rider wait 16 seconds to be
   told nothing. */
console.log("\n— backing off when the upstream stops answering —");
{
  const note = vm.runInContext("circuitNote", ctx);
  const open = vm.runInContext("circuitOpen", ctx);
  const stateOf = vm.runInContext("circuitState", ctx);
  note(true);                                   // start closed
  ok("a healthy upstream keeps the circuit closed", !open());
  for (let i = 0; i < 5; i++) note(false);
  ok("...and a handful of failures is still not a verdict", !open(),
    `${stateOf().fails} failures`);
  note(false);
  ok("six in a row opens it", open() && stateOf().open, JSON.stringify(stateOf()));
  ok("...so the next call costs nothing instead of two 8s attempts", open());
  note(true);
  ok("one success closes it again", !open() && stateOf().fails === 0);
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("...and it reopens on its own, letting one request through to look",
    /probeEveryMs/.test(w) && /let exactly one through/.test(w),
    "a circuit that never retries is just an outage you inflicted on yourself");
  ok("only OASA calls are gated by it, not the geocoders",
    /const upstream = urlStr\.startsWith\(OASA\)/.test(w));
}

/* The question /health could not answer, on the morning it mattered: the
   Worker was fine, /nearby was fine, and OASA was timing out behind both. */
console.log("\n— health can be asked about the upstream too —");
{
  rows = [];
  const plain = await body(await call("/health?token=k", { method: "GET", token: "k", env: { DB } }));
  ok("it does not spend an upstream call unless asked", !("oasa" in plain),
    "a slow upstream would make the health check slow, which is backwards");
  ok("...and the flag is there to ask with",
    /searchParams\.get\("probe"\) === "1"/.test(readFileSync(path.join(REPO, "worker.js"), "utf8")),
    "curl /health?token=...&probe=1");
}

console.log("\n— someone with a bug report can find an address —");
{
  const r = await call("/.well-known/security.txt", { method: "GET", env: {} });
  const txt = await r.text();
  ok("it answers, with no bindings configured at all", r.status === 200, String(r.status));
  ok("...as plain text", /text\/plain/.test(r.headers.get("Content-Type") || ""));
  ok("...naming the app's one contact address",
    /^Contact: mailto:oasax@proton\.me$/m.test(txt), txt.split("\n")[0]);
  /* RFC 9116 requires an expiry, and a stale one is worse than none — so
     it is computed per request rather than typed into a file nobody will
     remember to edit. */
  const exp = (txt.match(/^Expires: (.+)$/m) || [])[1];
  const ahead = (Date.parse(exp) - Date.now()) / 86400e3;
  ok("...and an expiry that is always in the future, never edited by hand",
    ahead > 300 && ahead < 366, `${Math.round(ahead)} days ahead`);
  ok("...and no second identity anywhere in it",
    !/github|papadop|gmail/i.test(txt), txt.replace(/\n/g, " | "));
}

console.log("\n— what the app tells people about notifications —");
{
  const app = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("both languages say the app need not stay open",
    /does not need to stay open/.test(app) && /Δεν χρειάζεται να μένει ανοιχτή/.test(app));
  ok("...and name the one platform that will not deliver to a tab",
    /Safari tab/.test(app) && /καρτέλα Safari/.test(app),
    "iOS delivers push only to a home-screen install");
  ok("the FAQ answers it at length, in both languages",
    /faqAlertQ/.test(app) && /Why didn't my alert arrive\?/.test(app)
    && /Γιατί δεν ήρθε η ειδοποίηση;/.test(app));
  ok("...including the permission and battery-saver cases",
    /battery optimisation/i.test(app) && /Εξοικονόμηση μπαταρίας/.test(app));
  ok("...and it is in the FAQ list, not just declared",
    /\{q:"faqAlertQ",\s*a:"faqAlertA"\}/.test(app));
  ok("a test notification is offered again",
    /push\/test/.test(app) && /pushTestOk/.test(app),
    "a real alert needs a real bus, so it cannot be the test");

  /* "Push isn't configured on the server" was shown for four different
     failures, three of which were the browser's. Someone reading it went
     looking at the wrong end of the problem every time. */
  ok("each way this can fail says which way it was",
    /pushUnsupported/.test(app) && /pushNoSub/.test(app)
    && /pushNoBackend/.test(app) && /pushServer/.test(app));
  ok("...through one mapping, used by both the save and the test button",
    (app.match(/=pushErrMsg\(e\)/g) || []).length === 2,
    "they used to disagree about what the same failure meant");
  ok("...and a 501 is the only thing still blamed on the server",
    /kr\.status===501\) throw new Error\("notconfigured"\)/.test(app));
  ok("a browser that refuses to register is named as the browser",
    /Use Google services for push/.test(app) && /brave:\/\/settings\/privacy/.test(app),
    "Brave ships that off and every permission still looks correct");
  ok("...in both languages", (app.match(/brave:\/\/settings\/privacy/g) || []).length >= 2);
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
