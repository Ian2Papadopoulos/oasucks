/* Why riders were getting 503s, and the reasons they should not have.

   Every case below is a way the Worker turned a working upstream — or an
   edge cache holding the whole answer — into an empty board:

   - the breaker and the budget refused EVERY OASA call, including the stop
     lists and route lists the edge cache answers whether OASA is up or not;
   - the runtime's own "too many subrequests" was booked as OASA failing,
     so one overloaded request opened the breaker for the whole isolate;
   - the alert sweep rode on whatever request came first, usually a board
     already planned to within six calls of the free plan's fifty;
   - per-call CPU (a collator per comparison, a date formatter per planner
     node, a dead-stop index that grew with the app's age and was rewritten
     on every board) pushed requests past 10 ms, which Cloudflare answers
     with error 1102 — a 503 to the rider;
   - /api forwarded OASA's own 503s and ignored the breaker entirely.

   worker.js runs in a vm with fetch, the edge cache and KV replaced by
   counting fakes, so subrequests can be added up the way the runtime adds
   them. Nothing here touches the network or OASA. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

/* ------------------------------- OASA ------------------------------- */
// Twenty stops within ~170 m of one corner, each served by one line.
const LAT = 37.9755, LNG = 23.7348;
const STOPS = Array.from({ length: 20 }, (_, i) => ({
  StopCode: String(10000 + i), StopDescr: `ΣΤΑΣΗ ${i}`, StopDescrEng: `STOP ${i}`,
  StopLat: LAT + ((i % 5) - 2) * 0.0006, StopLng: LNG + (Math.floor(i / 5) - 2) * 0.0006 }));
let DEAD = new Set();                 // stop codes no line serves any more
const LINES = ["608", "10", "2", "X95", "022", "Α1"].map((id, i) => ({
  LineCode: String(800 + i), LineID: id, LineDescr: `ΓΡΑΜΜΗ ${id}`, LineDescrEng: `LINE ${id}` }));
function body(act, q) {
  const p1 = q.get("p1");
  if (act === "getClosestStops") return STOPS;
  if (act === "webRoutesForStop") return DEAD.has(p1) ? []
    : [{ RouteCode: "R1", LineID: "608", RouteDescr: "ΑΚΑΔΗΜΙΑ", RouteDescrEng: "AKADIMIA" },
       { RouteCode: "R2", LineID: "022", RouteDescr: "ΚΑΛΛΙΘΕΑ", RouteDescrEng: "KALLITHEA" },
       { RouteCode: "R3", LineID: "10", RouteDescr: "ΧΑΛΑΝΔΡΙ", RouteDescrEng: "CHALANDRI" }];
  if (act === "getStopArrivals") return [{ route_code: "R1", veh_code: "V" + p1, btime2: "6" }];
  if (act === "webGetStops") return STOPS;
  if (act === "webGetLines") return LINES;
  return [];
}

/* What OASA does, per act: "ok" (fresh), "hit" (from the edge cache),
   "hit503" (a refusal the edge kept), a status code, "hang" (until the
   caller gives up), "fastfail" (connection dropped), or "local" (the
   runtime's own refusal). A function gets the query and returns one. */
const MODE = {};
let fetches = [];
const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  const act = u.searchParams.get("act") || u.hostname;
  fetches.push(act);
  const m0 = MODE[act];
  const m = typeof m0 === "function" ? m0(u.searchParams) : (m0 || "ok");
  if (m === "local") throw new Error("Too many subrequests.");
  if (m === "fastfail") throw new Error("Network connection lost.");
  if (m === "hang") return new Promise((_, rej) => {
    const s = init && init.signal;
    if (s) s.addEventListener("abort", () => rej(new Error("The operation was aborted")));
  });
  if (m === "hit503") return new Response("busy", { status: 503,
    headers: { "CF-Cache-Status": "HIT", "Age": "40" } });
  if (/^\d{3}$/.test(m)) return new Response("<html>no</html>", { status: +m });
  const headers = { "Content-Type": "application/json" };
  if (m === "hit") { headers["CF-Cache-Status"] = "HIT"; headers["Age"] = "30"; }
  return new Response(JSON.stringify(body(act, u.searchParams)), { status: 200, headers });
};

/* ---------------------- the edge cache, and KV ---------------------- */
const EDGE = new Map();
let cacheOps = 0;
const ek = r => (typeof r === "string" ? r : r.url);
const edge = {
  async match(r) { cacheOps++; const v = EDGE.get(ek(r)); return v ? v.clone() : undefined; },
  async put(r, res) { cacheOps++; EDGE.set(ek(r), res.clone()); },
};
const KVS = new Map();
let kvPuts = [], kvGets = [];
const KV = {
  async get(k, type) { kvGets.push(k); const v = KVS.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { kvPuts.push(k); KVS.set(k, String(v)); },
  async delete(k) { KVS.delete(k); },
  async list() { return { keys: [] }; },
};

/* Formatters and collators, counted as they are built. */
let dtfBuilt = 0;
const CIntl = Object.create(Intl);
CIntl.DateTimeFormat = function (...a) { dtfBuilt++; return new Intl.DateTimeFormat(...a); };
CIntl.Collator = Intl.Collator;

const src = readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler =");
const ctx = {
  console, Date, Math, JSON, Map, Set, Intl: CIntl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, URLSearchParams,
  Request, Response, Headers, TextEncoder, TextDecoder, btoa, atob, WeakMap, WeakSet, Symbol,
  Error, TypeError, RegExp, Uint8Array, ArrayBuffer, DataView,
  encodeURIComponent, decodeURIComponent,
  AbortController,                     // the real one: timeouts are under test here
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: { default: edge },
  fetch: fakeFetch,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const run = code => vm.runInContext(code, ctx);

const ENV = { ALERTS: KV };
const ENV_PUSH = { ALERTS: KV, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q" };
const OASA = run("OASA");

function reset() {
  EDGE.clear(); KVS.clear(); kvPuts = []; kvGets = []; fetches = []; cacheOps = 0; DEAD = new Set();
  for (const k of Object.keys(MODE)) delete MODE[k];
  run(`circuit.fails = 0; circuit.openedAt = 0; circuit.lastProbe = 0; circuit.lastFail = null;
    budget.windowStart = Date.now(); budget.spent = 0;
    localFail.count = 0; localFail.last = null;
    slMem = null; slDirty = false; slSavedAt = 0; slLoadedAt = 0;
    piggybackAt = 0; piggybackBusy = false; windowCache = { at: 0, windows: [] };
    RL.clear(); edgeHeld.clear();`);
}
/* One invocation, background work included: whatever it leaves running
   in waitUntil spends the same fifty subrequests as the answer did. */
async function call(pathq, { env = ENV, method = "GET" } = {}) {
  const pending = [];
  ctx.__c = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
  ctx.__req = new Request("https://oasax.test" + pathq, { method });
  ctx.__env = env;
  const f0 = fetches.length, c0 = cacheOps;
  const res = await run("__handler.fetch(__req, __env, __c)");
  for (let i = 0; i < 6 && pending.length; i++) await Promise.allSettled(pending.splice(0));
  res.subrequests = (fetches.length - f0) + (cacheOps - c0);
  return res;
}
const board = (extra = "") => `/nearby?lat=${LAT}&lng=${LNG}&radius=250&limit=11&markers=60${extra}`;
const forget = prefix => { for (const k of [...EDGE.keys()]) if (k.startsWith(prefix)) EDGE.delete(k); };
const openBreaker = () => run(`for (let i = 0; i < CIRCUIT.openAfter; i++) circuitNote(false, "HTTP 503")`);
const arrivalsUrl = c => `${OASA}?act=getStopArrivals&p1=${c}`;
const routesUrl = c => `${OASA}?act=webRoutesForStop&p1=${c}`;

/* -------------------------------------------------------------------- */
console.log("\n— a tripped breaker no longer empties the board —");
{
  reset();
  let r = await call(board());
  let j = await r.json();
  ok("a healthy board first", r.status === 200 && j.stops.length > 0
    && j.stops[0].arrivals.length > 0, `${r.status}, ${j.stops.length} stops`);

  // OASA stops answering; the stop lists and route lists are in the edge cache,
  // and the ninety-second copies of the arrivals have run out
  forget("https://nearby/");
  run("edgeHeld.clear()");
  openBreaker();
  MODE.getClosestStops = "hit"; MODE.webRoutesForStop = "hit"; MODE.getStopArrivals = "hang";
  fetches = [];
  r = await call(board());
  j = await r.json();
  ok("the board still answers — not a 503", r.status === 200, String(r.status));
  ok("...with the stops, which came from the edge cache", j.stops.length > 0
    && fetches.includes("getClosestStops"), `${j.stops.length} stops`);
  ok("...and no live call went near an upstream the breaker says is failing",
    !fetches.includes("getStopArrivals"), fetches.join(","));
  ok("...so the arrivals are the last good board's, honestly marked stale", j.stale === true
    && j.stops[0].arrivals.length > 0);

  // the same, at a corner with no last good board
  forget("https://nearby");
  r = await call(board());
  j = await r.json();
  ok("with nothing to fall back on it is still a board, not a 503", r.status === 200
    && j.stops.length > 0, String(r.status));
  ok("...that says why its rows are empty", j.upstream && j.upstream.ok === false,
    JSON.stringify(j.upstream));
  ok("...and is not cached, so the next rider asks again",
    r.headers.get("Cache-Control") === "no-store"
    && ![...EDGE.keys()].some(k => k.startsWith("https://nearby/")));

  // arrivals a rider fetched a minute ago are still in the edge cache
  reset();
  await call(board());
  forget("https://nearby/");
  openBreaker();
  MODE.getClosestStops = "hit"; MODE.webRoutesForStop = "hit"; MODE.getStopArrivals = "hit";
  r = await call(board());
  j = await r.json();
  ok("arrivals the edge still holds are read from it while the breaker is open",
    r.status === 200 && j.stale !== true && j.stops[0].arrivals.length > 0,
    "asking the edge is not asking OASA");
  ok("...and reading them does not close the breaker", run("circuitState().open") === true);
}

console.log("\n— a spent budget no longer empties the board —");
{
  reset();
  await call(board());
  forget("https://nearby/");
  run("edgeHeld.clear()");
  run("budget.windowStart = Date.now(); budget.spent = UPSTREAM_BUDGET.perMin;");
  MODE.getClosestStops = "hit"; MODE.webRoutesForStop = "hit";
  fetches = [];
  let r = await call(board());
  let j = await r.json();
  ok("past the ceiling the board still answers", r.status === 200 && j.stops.length > 0,
    String(r.status));
  ok("...reference data is not what the budget is for", fetches.includes("getClosestStops")
    && fetches.includes("webRoutesForStop"), [...new Set(fetches)].join(","));
  ok("...arrivals are, and were held back", !fetches.includes("getStopArrivals"));
  ok("...and the rider gets the last good board instead of nothing", j.stale === true);
  ok("a cache hit on reference data does not spend the budget",
    run("budget.spent") === run("UPSTREAM_BUDGET.perMin"), String(run("budget.spent")));

  // the busy stop: every rider near it asks, and the edge answers them all
  reset();
  await call(board());
  forget("https://nearby/");
  run("budget.windowStart = Date.now(); budget.spent = UPSTREAM_BUDGET.perMin;");
  MODE.getClosestStops = "hit"; MODE.webRoutesForStop = "hit"; MODE.getStopArrivals = "hit";
  r = await call(board());
  j = await r.json();
  ok("past the ceiling, a stop the edge still holds keeps its arrivals",
    r.status === 200 && j.stale !== true && j.stops[0].arrivals.length > 0,
    "it was refused before — for a list the edge was holding");
  ok("...without spending budget it does not cost",
    run("budget.spent") === run("UPSTREAM_BUDGET.perMin"), String(run("budget.spent")));
  // ...and when the guess was wrong, the call is charged after all
  reset();
  await call(board());
  forget("https://nearby/");
  const spent0 = run("budget.spent");
  MODE.getClosestStops = "hit"; MODE.webRoutesForStop = "hit";        // arrivals come back fresh
  await call(board());
  ok("a guess that missed the edge is charged", run("budget.spent") > spent0,
    `${spent0} → ${run("budget.spent")}`);
}

console.log("\n— our own limits are not OASA failing —");
{
  reset();
  MODE.getStopArrivals = "local";
  const aged = run("getJSONAged");
  for (let i = 0; i < 10; i++) await aged(arrivalsUrl(10000 + i), 90);
  const st = run("circuitState()");
  ok("ten 'too many subrequests' do not open the breaker", !st.open && st.fails === 0,
    JSON.stringify({ open: st.open, fails: st.fails }));
  ok("...they are counted on their own, where /health shows them",
    st.ownLimits && st.ownLimits.count === 10 && /too many subrequests/i.test(st.ownLimits.why),
    JSON.stringify(st.ownLimits));
  ok("...and none was retried — the runtime would only refuse again",
    fetches.length === 10, `${fetches.length} fetches`);
  ok("the board says nothing is wrong upstream", run("upstreamState().ok") === true);
}

console.log("\n— only an answer OASA gave just now moves the breaker —");
{
  reset();
  const aged = run("getJSONAged");
  openBreaker();
  MODE.webRoutesForStop = "hit";
  const g = await aged(routesUrl(10001), 86400);
  ok("a reference call still answers while the breaker is open", g.ok && Array.isArray(g.data));
  ok("...but a cached answer does not close it", run("circuitState().open") === true,
    "it says nothing about OASA now — closing on it reopened the floodgates");
  MODE.webRoutesForStop = "ok";
  await aged(routesUrl(10002), 86400);
  ok("a fresh one does", run("circuitState().open") === false);

  reset();
  MODE.getStopArrivals = "hit503";
  for (let i = 0; i < 10; i++) await aged(arrivalsUrl(10000), 90);
  ok("a refusal the edge kept is not counted again on every read",
    run("circuit.fails") === 0, `${run("circuit.fails")} fails`);

  reset();
  MODE.getStopArrivals = "404";
  for (let i = 0; i < 10; i++) await aged(arrivalsUrl("nonsense" + i), 90);
  ok("a bad question is not an outage — /api cannot be used to open the breaker",
    run("circuit.fails") === 0);
  reset();
  MODE.getStopArrivals = "403";
  for (let i = 0; i < 6; i++) await aged(arrivalsUrl(10000 + i), 90);
  ok("...but a 403, which is how a block arrives, still is", run("circuitState().open") === true);
  reset();
  MODE.getStopArrivals = "429";
  for (let i = 0; i < 6; i++) await aged(arrivalsUrl(10000 + i), 90);
  ok("...and so is a 429", run("circuitState().open") === true);
}

console.log("\n— a retry is for a connection that failed fast —");
{
  reset();
  const timed = run("timedFetch");
  MODE.getStopArrivals = "hang";
  const t0 = Date.now();
  let threw = false;
  try { await timed(arrivalsUrl(10000), 0, { timeoutMs: 40, tries: 2 }); } catch (_) { threw = true; }
  ok("a timeout is not retried into the same slow upstream", threw && fetches.length === 1,
    `${fetches.length} attempts in ${Date.now() - t0} ms — it used to be two 8 s waits`);
  fetches = [];
  MODE.getStopArrivals = "fastfail";
  try { await timed(arrivalsUrl(10000), 0, { timeoutMs: 40, tries: 2 }); } catch (_) { }
  ok("a dropped connection still gets its second go", fetches.length === 2,
    `${fetches.length} attempts`);

  reset();
  openBreaker();
  MODE.webRoutesForStop = "hang";
  const s0 = Date.now();
  const g = await run("getJSONAged")(routesUrl(10003), 86400);
  const took = Date.now() - s0;
  ok("while the breaker is open, a reference miss gets one short try", !g.ok
    && fetches.length === 1 && took < 4000, `${fetches.length} attempt, ${took} ms`);
}

console.log("\n— a board stays inside the free plan's fifty subrequests —");
{
  reset();
  const favs = ["90001", "90002", "90003", "90004", "90005", "90006"];
  let r = await call(`/nearby?lat=${LAT}&lng=${LNG}&radius=900&limit=11&markers=150&favs=${favs.join(",")}`);
  ok("the widest board the app can ask for, cold, with six far favourites",
    r.status === 200 && r.subrequests <= 48, `${r.subrequests} of 50`);
  reset();
  const eight = [...favs, "90007", "90008"];
  r = await call(`/nearby?lat=${LAT}&lng=${LNG}&radius=2000&limit=16&markers=150&favs=${eight.join(",")}`);
  ok("...and the largest any caller can ask for is trimmed to fit",
    r.status === 200 && r.subrequests <= 48, `${r.subrequests} of 50 — it used to plan 57`);
  reset();
  MODE.webRoutesForStop = q => (Number(q.get("p1")) % 3 ? "ok" : "fastfail");
  r = await call(`/nearby?lat=${LAT}&lng=${LNG}&radius=900&limit=11&markers=150&favs=${favs.join(",")}`);
  ok("...with room left for the retries a flaky minute costs", r.subrequests <= 50,
    `${r.subrequests} of 50`);
}

console.log("\n— background work rides only on light requests —");
{
  reset();
  await call(board(), { env: ENV_PUSH });
  ok("a board being built carries nothing extra", run("piggybackAt") === 0,
    "it used to carry the alert sweep and vehicle tracking on top of its own fan-out");
  await call(board(), { env: ENV_PUSH });
  ok("the same board served from the cache does", run("piggybackAt") > 0);
  run("piggybackAt = 0; piggybackBusy = false;");
  await call("/reports", { env: ENV_PUSH });
  ok("...as do the small reads the app makes anyway", run("piggybackAt") > 0);
  run("piggybackAt = 0; piggybackBusy = false;");
  await call("/health", { env: ENV_PUSH });
  ok("...including the bare /health an uptime monitor pings", run("piggybackAt") > 0,
    "a monitor every minute is the steadiest ride the sweep can get");
  run("piggybackAt = 0; piggybackBusy = false;");
  await call("/health?token=k", { env: { ...ENV_PUSH, ADMIN_TOKEN: "k" } });
  ok("...but not the admin view, which runs a dozen queries of its own", run("piggybackAt") === 0);
  run("piggybackAt = 0; piggybackBusy = false;");
  await call("/alerts/why", { env: ENV_PUSH });
  ok("...and the alert endpoints never do", run("piggybackAt") === 0);

  // a sweep that would overrun its share stops and says where
  const now = run("athensNow()");
  const hhmm = run("minToHhmm");
  const rules = [10000, 10001, 10002, 10003].map((c, i) => ({ id: "r" + i, sub: "s", stopCode: String(c),
    routeCodes: ["R1"], lineId: "608", days: [now.day], from: hhmm(now.minutes - 5),
    to: hhmm(now.minutes + 30), leads: [10] }));
  KVS.set("rules:index", JSON.stringify(rules));
  ctx.__T = {};
  fetches = []; cacheOps = 0;
  await run("runAlerts({ ALERTS: __kv, VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q' }, __T, subMeter(9))"
    .replace("__kv", "__KV"), Object.assign(ctx, { __KV: KV }));
  const T = ctx.__T;
  const notReached = Object.values(T.stops || {}).filter(v => /NOT REACHED.*subrequests/.test(v)).length;
  // room for a whole stop is kept (4), what it actually spent is charged (2 here)
  ok("a sweep with a small share serves what fits and names the rest", notReached === 1
    && fetches.length + cacheOps <= 9, `${notReached} not reached, ${fetches.length + cacheOps} used of 9`);
  ok("...and the meter counted what the runtime would",
    run("1") && fetches.length + cacheOps === 6, `${fetches.length} fetches, ${cacheOps} cache calls`);
}

console.log("\n— a worse board never replaces the last good one —");
{
  reset();
  await call(board());
  const good = EDGE.get([...EDGE.keys()].find(k => k.startsWith("https://nearby-last/")));
  ok("a complete board becomes the corner's last good one", !!good);
  forget("https://nearby/");
  MODE.getStopArrivals = q => (Number(q.get("p1")) % 2 ? "503" : "ok");
  let r = await call(board());
  ok("a half-filled board is still served", r.status === 200);
  const after = EDGE.get([...EDGE.keys()].find(k => k.startsWith("https://nearby-last/")));
  ok("...but does not overwrite the last good one", after === good,
    "that copy is what riders get when OASA goes quiet");
  forget("https://nearby/");
  delete MODE.getStopArrivals;
  r = await call(board());
  const fresh = EDGE.get([...EDGE.keys()].find(k => k.startsWith("https://nearby-last/")));
  ok("...and a complete one does", fresh !== good);
}

console.log("\n— the dead-stop index no longer grows with the app's age —");
{
  reset();
  await call(board());
  ok("resolving live stops writes nothing", !kvPuts.includes("stops:lines"),
    "it used to rewrite the whole index on every board built");
  reset();
  DEAD = new Set(["10003"]);
  await call(board());
  const saved = JSON.parse(KVS.get("stops:lines") || "{}");
  ok("a stop found dead is written", kvPuts.filter(k => k === "stops:lines").length === 1
    && saved["10003"] && saved["10003"].n === 0, JSON.stringify(saved));
  ok("...and only the dead are kept", Object.keys(saved).length === 1);
  forget("https://nearby/");
  kvPuts = [];
  await call(board());
  ok("...once — the next board finds nothing new to say", !kvPuts.includes("stops:lines"));

  // an index in the old shape: every stop ever seen, live ones included
  reset();
  const nowS = Math.floor(Date.now() / 1000);
  const legacy = {};
  for (let i = 0; i < 3000; i++) legacy[String(50000 + i)] = { n: 1 + (i % 5), t: nowS - 3600 };
  legacy["60000"] = { n: 0, t: nowS - 3600 };          // dead, and nowhere near this board
  legacy["10012"] = { n: 0, t: nowS - 3600 };          // the nearest stop — serving lines again
  KVS.set("stops:lines", JSON.stringify(legacy));
  const before = KVS.get("stops:lines").length;
  await call(board());
  const now2 = KVS.get("stops:lines");
  const kept = JSON.parse(now2);
  ok("an index in the old shape is rewritten short, once", now2.length < 100
    && kept["60000"] && kept["60000"].n === 0, `${(before / 1024).toFixed(0)} KB → ${now2.length} bytes`);
  ok("...and a stop that has come back is dropped from it", !kept["10012"]);
  ok("...reading the old index once, not twice", kvGets.filter(k => k === "stops:lines").length === 1,
    "a second parse of 240 KB was most of what that request cost");

  // two isolates finding different dead stops do not erase each other
  reset();
  KVS.set("stops:lines", JSON.stringify({ "77777": { n: 0, t: nowS - 60 } }));
  run(`slMem = new Map(); slDirty = false; slSavedAt = 0; slLoadedAt = 0;   // loaded long ago`);
  run(`slSet(slMem, "88888", 0, ${nowS})`);
  await run("saveStopLines")(ENV);
  const merged = JSON.parse(KVS.get("stops:lines"));
  ok("another isolate's findings survive a save", merged["77777"] && merged["88888"],
    JSON.stringify(Object.keys(merged)));
  run(`slSet(slMem, "99999", 0, ${nowS})`);
  kvPuts = [];
  await run("saveStopLines")(ENV);
  ok("...and saves are spaced out, not one per board", kvPuts.length === 0,
    "the free plan allows 1,000 KV writes a day, shared with reports, rules and subscriptions");
}

console.log("\n— the status strip forgets a refusal that is over —");
{
  reset();
  run(`circuitNote(false, "HTTP 503"); circuitNote(true);`);
  ok("one 503 followed by a success is not 'OASA is overloaded'", run("upstreamState().ok") === true,
    "lastFail is never cleared, so this used to stay 'busy' for the isolate's whole life");
  reset();
  run(`circuitNote(false, "HTTP 503"); circuit.lastFail.at = Date.now() - 10 * 60000;`);
  ok("...nor is one from ten minutes ago", run("upstreamState().ok") === true);
  reset();
  run(`circuitNote(false, "HTTP 429"); circuitNote(false, "HTTP 503");`);
  ok("a refusal streak still running is", run("upstreamState().reason") === "busy");
}

console.log("\n— nothing is built per call that could be built once —");
{
  const d0 = dtfBuilt;
  const clockAt = run("clockAt");
  const base = Date.now();
  for (let i = 0; i < 4000; i++) clockAt(base, i * 0.37);
  for (let i = 0; i < 200; i++) { run("athensNow()"); run("dayKey(Date.now())"); }
  ok("four thousand planner clock reads build at most two formatters", dtfBuilt - d0 <= 2,
    `${dtfBuilt - d0} built — it was one per node, ~100 µs each`);
  const a = run("athensParts")(base + 37 * 60000), b = clockAt(base, 37);
  ok("...and the memo answers what the formatter would", a.min === b.min && a.day === b.day);

  reset();
  dtfBuilt = 0;
  const plan = await run("planJourney")({ lat: LAT, lng: LNG }, { lat: LAT + 0.0024, lng: LNG + 0.0012 },
    Date.now(), {});
  ok("a whole journey plan builds at most one", dtfBuilt <= 1 && Array.isArray(plan.itineraries),
    `${dtfBuilt} built, ${plan.itineraries.length} itineraries`);

  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("no comparison builds a collator", !/localeCompare\([^)]*numeric/.test(w));
  const ids = ["608", "10", "2", "X95", "022", "Α1"];
  const want = ids.slice().sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  const got = ids.map(id => ({ id })).sort(run("byLineId")).map(x => x.id);
  ok("...and lines still sort as people read them", got.join(",") === want.join(","), got.join(" "));
}

console.log("\n— /api goes the same way as everything else —");
{
  reset();
  let r = await call("/api?act=getStopArrivals&p1=10001");
  let j = await r.json();
  ok("a fresh answer", r.status === 200 && Array.isArray(j) && j[0].btime2 === "6");
  fetches = [];
  r = await call("/api?act=getStopArrivals&p1=10001");
  ok("...kept, so the next rider costs OASA nothing", r.status === 200 && fetches.length === 0);

  // three minutes on, OASA refuses: the kept copy, aged, beats an error
  const k = [...EDGE.keys()].find(x => x.startsWith("https://oasa-api/"));
  const old = EDGE.get(k);
  EDGE.set(k, new Response(await old.clone().text(), { headers: {
    "Content-Type": "application/json", "X-Fetched-At": String(Math.floor(Date.now() / 1000) - 180) } }));
  MODE.getStopArrivals = "503";
  r = await call("/api?act=getStopArrivals&p1=10001");
  j = await r.json();
  ok("OASA's 503 is not passed on when there is a last answer", r.status === 200
    && r.headers.get("X-Stale-Seconds") !== null, String(r.status));
  ok("...whose minutes have been aged by its age", j[0] && j[0].btime2 === "3", JSON.stringify(j));
  r = await call("/api?act=getStopArrivals&p1=10002");
  j = await r.json();
  ok("with nothing kept, a failed upstream is a 502 — bad gateway, not ours",
    r.status === 502 && j.upstream, `${r.status} ${JSON.stringify(j)}`);

  reset();
  openBreaker();
  r = await call("/api?act=getStopArrivals&p1=10004");
  ok("while the breaker is open it holds back, and says when to come back",
    r.status === 503 && r.headers.get("Retry-After") === "30" && !fetches.includes("getStopArrivals"),
    `${r.status}, ${fetches.length} upstream calls — it used to go straight through`);

  reset();
  MODE.webRoutesForStop = "404";
  r = await call("/api?act=webRoutesForStop&p1=nope");
  ok("a 404 is passed on as a 404", r.status === 404);
  ok("...and leaves the breaker alone", run("circuit.fails") === 0);
}

console.log("\n— /lines —");
{
  reset();
  MODE.webGetLines = "503";
  let r = await call("/lines");
  ok("an empty catalogue is never kept", r.status === 200
    && r.headers.get("Cache-Control") === "no-store" && !EDGE.has("https://lines/v1"),
    "it used to be served with a day's max-age");
  delete MODE.webGetLines;
  r = await call("/lines");
  const j = await r.json();
  ok("a real one is, assembled", EDGE.has("https://lines/v1") && j.length === LINES.length);
  fetches = [];
  await call("/lines");
  ok("...so the next request does not parse and sort it all again", fetches.length === 0);
  const want = LINES.map(l => l.LineID).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  ok("...in reading order", j.map(l => l.id).join(",") === want.join(","), j.map(l => l.id).join(" "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
