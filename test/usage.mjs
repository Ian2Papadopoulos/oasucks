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

/* The notice has to be settable by exactly one person and readable by
   everyone, which is the whole security model of it. */
/* When nothing arrives on the phone, the question is always which half is
   wrong, and the answer is usually in a response body we were throwing
   away. 401/403 is the VAPID keys, 404/410 a dead subscription, 400 the
   encryption — four different jobs behind one "not sent". */
/* "The test notification arrives but a real one never does" is a sentence
   about a chain with eight links in it, and until now the app could see
   none of them. This walks the same gates runAlerts walks and names the
   one that stopped each rule. It sends nothing. */
console.log("\n— why an alert did not fire —");
{
  const store = new Map();
  const KV = {
    async get(k, type) { const v = store.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  };
  let arrivals = [], stopRoutes = [];
  ctx.__arr = () => arrivals;
  ctx.__routes = () => stopRoutes;
  const realGet = vm.runInContext("getJSON", ctx);
  vm.runInContext(`getJSON = async (u) => u.includes("getStopArrivals") ? __arr()
    : u.includes("webRoutesForStop") ? __routes() : null;`, ctx);

  const now = vm.runInContext("athensNow", ctx)();
  const hhmm = vm.runInContext("minToHhmm", ctx);
  const env = { ALERTS: KV, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q", ADMIN_TOKEN: "k" };
  const ask = async () => {
    ctx.__req = new Request("https://x/alerts/why?token=k", { method: "GET" });
    ctx.__env = env;
    return (await vm.runInContext(
      `__handler.fetch(__req, __env, { waitUntil(){}, passThroughOnException(){} })`, ctx)).json();
  };
  const rule = { id: "r1", sub: "s1", enabled: true, stopCode: "10361", lineId: "608",
    routeCodes: ["2045"], days: [0, 1, 2, 3, 4, 5, 6],
    from: hhmm(now.minutes), to: hhmm(now.minutes + 20), leads: [10, 5] };
  const setup = (r, arr, sub = true, routes = []) => {
    store.clear(); store.set("rules:index", JSON.stringify([r]));
    if (sub) store.set("sub:s1", JSON.stringify({ endpoint: "https://p/x", keys: {} }));
    arrivals = arr; stopRoutes = routes;
  };

  {
    ctx.__req = new Request("https://x/alerts/why", { method: "GET" });
    ctx.__env = { ALERTS: KV, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q" };
    const r = await vm.runInContext(
      `__handler.fetch(__req, __env, { waitUntil(){}, passThroughOnException(){} })`, ctx);
    ok("it needs the admin token", r.status === 403, String(r.status));
  }
  setup(rule, [{ route_code: "2045", veh_code: "V1", btime2: "4" }]);
  let j = await ask();
  ok("a rule that should fire says so",
    /WOULD FIRE/.test(JSON.stringify(j.rules[0].verdict)), JSON.stringify(j.rules[0].verdict));
  ok("...and confirms the subscription it would go to exists",
    j.rules[0].subscription === "found", j.rules[0].subscription);

  /* The suspect that matches the symptom exactly: a rule saved on one
     device names that device, and testing on another proves nothing. */
  setup({ ...rule, sub: "elsewhere" }, [{ route_code: "2045", veh_code: "V1", btime2: "4" }]);
  j = await ask();
  ok("a rule pointing at a subscription that is gone says which",
    /MISSING/.test(j.rules[0].subscription) && /elsewhere/.test(j.rules[0].subscription),
    j.rules[0].subscription);

  setup({ ...rule, days: [(now.day + 1) % 7] }, []);
  j = await ask();
  ok("the wrong day is named as the wrong day",
    /today is day/.test(j.rules[0].blocked), j.rules[0].blocked);

  setup({ ...rule, from: hhmm(now.minutes - 120), to: hhmm(now.minutes - 100) }, []);
  j = await ask();
  ok("...and a window that has passed gives the hours it is live",
    /outside the window/.test(j.rules[0].blocked) && /live \d\d:\d\d/.test(j.rules[0].blocked),
    j.rules[0].blocked);

  setup(rule, [{ route_code: "9999", veh_code: "V2", btime2: "3" }]);
  j = await ask();
  ok("another line at the same stop is named, not ignored",
    /route 9999 is line .*, not 608/.test(JSON.stringify(j.rules[0].verdict)),
    JSON.stringify(j.rules[0].verdict));

  /* The bug that made real alerts never arrive. `webRoutesForStop` lists
     every direction and variant of a line, so a rule saved off that list
     can name route 2045 while the bus actually running is route 2046 —
     same line, different code, and the old exact-code test dropped it. */
  setup(rule, [{ route_code: "2046", veh_code: "V3", btime2: "4" }], true,
    [{ RouteCode: "2045", LineID: "608" }, { RouteCode: "2046", LineID: "608" }]);
  j = await ask();
  ok("...but a different route code on the SAME line is matched anyway",
    /WOULD FIRE/.test(JSON.stringify(j.rules[0].verdict)),
    JSON.stringify(j.rules[0].verdict));
  ok("...and says why it was matched, so the fallback is visible",
    /different variant of line 608/.test(JSON.stringify(j.rules[0])),
    JSON.stringify(j.rules[0].verdict));

  setup(rule, []);
  j = await ask();
  ok("a stop with nothing due says exactly that",
    /no arrivals at this stop/.test(JSON.stringify(j.rules[0].verdict)));

  store.clear();
  j = await ask();
  ok("no rules at all is not an error", j.rules === "no rules stored", JSON.stringify(j.rules));

  vm.runInContext(`getJSON = __realGet;`, Object.assign(ctx, { __realGet: realGet }));
}

/* /alerts/why can prove a rule SHOULD fire and still tell you nothing
   about what happened when it did, because runAlerts swallowed the
   result. These drive the real thing. */
console.log("\n— what runAlerts does when the push fails —");
{
  const store = new Map();
  const KV = {
    async get(k, type) { const v = store.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  };
  const realGet = vm.runInContext("getJSON", ctx);
  const realPush = vm.runInContext("sendPush", ctx);
  const now = vm.runInContext("athensNow", ctx)();
  const hhmm = vm.runInContext("minToHhmm", ctx);
  const env = { ALERTS: KV, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q" };

  let arrivals = [], routes = [], reply = { status: 201, detail: "", gone: false }, calls = 0;
  ctx.__arr = () => arrivals; ctx.__routes = () => routes;
  ctx.__reply = () => { calls++; return reply; };
  vm.runInContext(`getJSON = async (u) => u.includes("getStopArrivals") ? __arr()
    : u.includes("webRoutesForStop") ? __routes() : null;`, ctx);
  vm.runInContext(`sendPush = async () => __reply();`, ctx);

  const rule = { id: "r1", sub: "s1", enabled: true, stopCode: "10361", lineId: "608",
    routeCodes: ["2045"], days: [0, 1, 2, 3, 4, 5, 6],
    from: hhmm(now.minutes), to: hhmm(now.minutes + 20), leads: [10, 5] };
  const run = async (arr, rep, rts = []) => {
    store.clear(); store.set("rules:index", JSON.stringify([rule]));
    store.set("sub:s1", JSON.stringify({ endpoint: "https://p/x", keys: {} }));
    arrivals = arr; routes = rts; reply = rep; calls = 0;
    ctx.__env = env;
    await vm.runInContext(`runAlerts(__env)`, ctx);
  };
  const sentKeys = () => [...store.keys()].filter(k => k.startsWith("sent:"));

  await run([{ route_code: "2045", veh_code: "V1", btime2: "4" }], { status: 201, detail: "", gone: false });
  ok("a delivered push marks its leads as spent", sentKeys().length === 2, sentKeys().join(","));
  ok("...and it went out once, not once per lead", calls === 1, String(calls));

  /* The bug that turned one bad minute into a lost hour: the dedupe key
     was written whatever the push service said, so a 500 or a timeout
     inside the lead silently cancelled every retry for the next hour. */
  await run([{ route_code: "2045", veh_code: "V1", btime2: "4" }], { status: 502, detail: "bad gateway", gone: false });
  ok("a push that FAILED does not mark the lead as spent",
    sentKeys().length === 0, sentKeys().join(",") || "(none)");
  ok("...so the next minute tries again rather than skipping the hour",
    (await (async () => { const before = calls; arrivals = [{ route_code: "2045", veh_code: "V1", btime2: "4" }];
      ctx.__env = env; await vm.runInContext(`runAlerts(__env)`, ctx); return calls > before; })()));

  /* Unguarded, this call could end the whole run — and it runs on
     arrivals the rule did NOT ask for, so the bus it skipped past was
     somebody else's alert. */
  ctx.__routes = () => { throw new Error("upstream fell over"); };
  await run([{ route_code: "9999", veh_code: "V9", btime2: "2" },
             { route_code: "2045", veh_code: "V1", btime2: "4" }],
            { status: 201, detail: "", gone: false });
  ok("a line lookup that throws does not abort the run behind it",
    calls === 1 && sentKeys().length === 2, `${calls} pushes, ${sentKeys().length} keys`);
  ctx.__routes = () => routes;

  /* Every early return in runAlerts is a legitimate "nothing to do", and
     from the outside they are indistinguishable from each other and from a
     crash. Each one has to name itself. */
  await run([], { status: 201, detail: "", gone: false });
  {
    const T = {}; ctx.__env = env; ctx.__T = T;
    store.set("rules:index", JSON.stringify([rule]));
    arrivals = [];
    await vm.runInContext(`runAlerts(__env, __T)`, ctx);
    ok("a stop OASA answered with nothing is not the same as no answer",
      T.stops && /0 arrivals/.test(String(T.stops["10361"])), JSON.stringify(T.stops));
  }
  {
    const T = {}; ctx.__env = env; ctx.__T = T;
    vm.runInContext(`getJSON = async () => null;`, ctx);
    await vm.runInContext(`runAlerts(__env, __T)`, ctx);
    ok("...and OASA not answering at all says so, rather than passing quietly",
      /NO ANSWER/.test(String((T.stops || {})["10361"])), JSON.stringify(T.stops));
    vm.runInContext(`getJSON = async (u) => u.includes("getStopArrivals") ? __arr()
      : u.includes("webRoutesForStop") ? __routes() : null;`, ctx);
  }
  /* The fault that cost every alert this service has ever tried to send:
     an isolate serves fetch AND scheduled events from one module state, so
     user traffic could open the breaker and starve a cron sharing it —
     while a different isolate answered /alerts/why with a closed one. The
     alert path is one call per stop per minute; refusing it protects
     nobody and loses the bus. */
  {
    const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
    ok("the breaker cannot refuse the alert cron",
      /const ALERT_FETCH = \{ ignoreCircuit: true \}/.test(w)
      && /getStopArrivals[\s\S]{0,80}ALERT_FETCH/.test(w),
      "one call per stop per minute is not what a breaker is for");
    ok("...and the line lookup behind it is exempt too",
      /fetchStopRoutes\(stopCode, ALERT_FETCH\)/.test(w));
    ok("...but the read path, which is what got us blocked, still is not",
      /if \(upstream && !\(opts && opts\.ignoreCircuit\) && circuitOpen\(\)\)/.test(w));
    ok("...so it carries its own ceiling instead, under the subrequest cap",
      /ALERT_MAX_STOPS = 20/.test(w) && /T\.overCapacity/.test(w));
    ok("a refused upstream call keeps the reason, not just a tally",
      /circuitNote\(false, `HTTP \$\{r\.status\}`\)/.test(w)
      && /lastFail: circuit\.lastFail/.test(w),
      "a 403, a timeout and an HTML error page need different fixes");
  }
  {
    const T = {}; ctx.__env = env; ctx.__T = T;
    store.set("rules:index", JSON.stringify([{ ...rule, days: [(now.day + 1) % 7] }]));
    await vm.runInContext(`runAlerts(__env, __T)`, ctx);
    ok("...and 'no window is open' is named too",
      /window is open/.test(String(T.stopped)), String(T.stopped));
  }

  vm.runInContext(`getJSON = __realGet; sendPush = __realPush;`,
    Object.assign(ctx, { __realGet: realGet, __realPush: realPush }));
}

/* A promise handed to ctx.waitUntil that REJECTS is discarded by the
   runtime without a word. Everything the cron does runs in there, so one
   throw used to cost every alert after it, invisibly and forever. */
console.log("\n— the cron writes down what it did —");
{
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("the whole scheduled body is caught, not left to waitUntil",
    /try \{ await cronRun\(event, env, T\); \}[\s\S]{0,20}catch \(e\) \{ T\.threw/.test(w),
    "a rejected waitUntil promise is discarded silently");
  ok("...and what it threw is written where a human can read it",
    /setMeta\(env, "cron_trace"/.test(w));
  ok("...but only for minutes that had work, so a quiet one cannot bury it",
    /if \(T\.due \|\| T\.threw\)/.test(w));
  ok("tracking and maintenance cannot take the alerts down with them",
    /catch \(e\) \{ T\.trackingError/.test(w) && /catch \(e\) \{ T\.maintError/.test(w),
    "they run after the alerts and are now caught separately");
  ok("/alerts/why hands the trace back with the rules",
    /lastCronWithWork/.test(w));
}

console.log("\n— the push service's own verdict, kept —");
{
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("sendPush returns why, not just a number",
    /return \{ status: res\.status, detail, gone:/.test(w));
  ok("...reading the body only when it failed",
    /if \(res\.status >= 300\) \{[\s\S]{0,120}await res\.text\(\)/.test(w),
    "a success body is noise and costs a read");
  ok("/push/test hands it to the app", /detail: r\.detail \|\| undefined/.test(w));
  /* RFC 8030: 404 and 410 mean the endpoint is retired. Keeping it means
     every future cron pays for a call that cannot succeed. */
  ok("a subscription the service has retired is forgotten",
    (w.match(/if \(r\.gone\) await env\.ALERTS\.delete/g) || []).length === 1
    && (w.match(/if \(sent\.gone\) await env\.ALERTS\.delete/g) || []).length === 1,
    "on both the test path and the alert path");
  ok("...and a failed send is not counted as one that worked",
    /if \(sent\.status < 300\) \{ try \{ await bumpUsage/.test(w),
    "alert_last was being stamped either way");
  const app = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("the app shows the verdict rather than 'not sent'",
    /pushTestWhy/.test(app) && /The push service answered/.test(app));
  ok("...in both languages",
    (app.match(/pushTestWhy:/g) || []).length === 2);
}

console.log("\n— setting the notice takes a token; reading it does not —");
{
  const KV = (() => {
    let v = null;
    return { async get() { return v; }, async put(_k, s) { v = JSON.parse(s); },
             async delete() { v = null; } };
  })();
  const env = { ALERTS: KV, DB };
  ctx.__body = null;
  const post = async (obj, token) => {
    const e = { ...env }; if (token) e.ADMIN_TOKEN = token;
    ctx.__req = new Request("https://x/notice", { method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
      body: JSON.stringify(obj) });
    ctx.__env = e;
    return vm.runInContext(`__handler.fetch(__req, __env, { waitUntil(){}, passThroughOnException(){} })`, ctx);
  };
  const get = async () => {
    ctx.__req = new Request("https://x/notice", { method: "GET" });
    ctx.__env = env;
    return body(await vm.runInContext(`__handler.fetch(__req, __env, { waitUntil(){}, passThroughOnException(){} })`, ctx));
  };

  ok("nothing is set to begin with", JSON.stringify(await get()) === "{}");
  const noAuth = await post({ id: "m1", en: "hi" });
  ok("a stranger cannot set one", noAuth.status === 403, String(noAuth.status));
  ok("...and nothing was written", JSON.stringify(await get()) === "{}");
  const okRes = await post({ id: "m1", el: "Εργασίες", en: "Maintenance" }, "k");
  ok("the operator can", okRes.status === 200, String(okRes.status));
  const shown = await get();
  ok("...and anyone may read it, with no token at all",
    shown.id === "m1" && shown.en === "Maintenance", JSON.stringify(shown));
  await post({ clear: true }, "k");
  ok("...and clear it again", JSON.stringify(await get()) === "{}",
    "taking it down must be as easy as putting it up");
  const empty = await post({ id: "m2" }, "k");
  ok("a notice with no words in it is refused", empty.status === 400, String(empty.status));
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
