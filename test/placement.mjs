/* Where the Worker runs, and whether OASA answers it there.

   OASA answers only addresses it places in Greece. Rider requests that
   Cloudflare ran in Athens got boards; the cron, which Cloudflare runs
   wherever it has spare machines, has not reached OASA since 27 August
   2026. v112 pins the Worker to Athens with [placement] in wrangler.toml,
   and — because a setting nobody can check is a hope — makes the location
   visible: /health says where each request ran, every OASA answer is
   counted by location, and `npm run checkup` turns that into words.

   worker.js runs in a vm with fetch, the edge cache, KV and D1 replaced by
   recording fakes; checkup.mjs runs for real against a stub server.
   Nothing here touches the network, OASA or Cloudflare. */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

console.log("\n— the setting —");
{
  const toml = readFileSync(path.join(REPO, "wrangler.toml"), "utf8");
  const block = (toml.match(/^\[placement\]\s*\n((?:(?!\[)[^\n]*\n?)*)/m) || [])[1] || "";
  const keys = [...block.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)].map(m => [m[1], m[2]]);
  const targets = keys.filter(([k]) => ["region", "host", "hostname"].includes(k));
  ok("wrangler.toml pins the Worker with a [placement] block", !!block.trim());
  /* wrangler refuses two of these at once; finding that out at deploy time
     is a deploy that did not happen. */
  ok("...naming exactly one target, as wrangler requires", targets.length === 1, JSON.stringify(keys));
  const [k, v] = targets[0] || [];
  ok("...and a well-formed one",
    k === "region" ? /^(aws|gcp|azure):[a-z0-9-]+$/.test(v)
      : k === "host" ? /^[a-z0-9.-]+:\d+$/.test(v)
      : k === "hostname" ? /^[a-z0-9.-]+$/.test(v) : false, `${k} = ${v}`);
  ok("...with the reason and the way back written next to it",
    /OASA only answers addresses it places in Greece/.test(toml) && /Running next to OASA/.test(toml));
  ok("DEPLOY.md says how to check it took, and how to undo it",
    /### Running next to OASA[\s\S]*Check it took[\s\S]*If `ranIn` shows a location outside Greece[\s\S]*Undo it/
      .test(readFileSync(path.join(REPO, "DEPLOY.md"), "utf8")));
}

/* ------------------------------ the Worker ------------------------------ */
const MODE = {};                        // per OASA act: "ok", "hit" (edge), "fastfail"
let sent = [];                          // every outside call: url + user agent
const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  const ua = (init && init.headers && (init.headers["User-Agent"] || init.headers["user-agent"])) || "";
  sent.push({ url: String(url), ua });
  if (u.hostname === "cloudflare.com") return new Response("fl=1\nip=203.0.113.7\ncolo=ATH\nloc=GR\n");
  const act = u.searchParams.get("act") || "";
  const m = MODE[act] || "ok";
  if (m === "fastfail") throw new Error("Network connection lost.");
  const headers = { "Content-Type": "application/json" };
  if (m === "hit") { headers["CF-Cache-Status"] = "HIT"; headers["Age"] = "30"; }
  return new Response(JSON.stringify([{ route_code: "R1", veh_code: "V1", btime2: "6" }]),
    { status: 200, headers });
};
const EDGE = new Map();
const edge = {
  async match(r) { const v = EDGE.get(typeof r === "string" ? r : r.url); return v ? v.clone() : undefined; },
  async put(r, res) { EDGE.set(typeof r === "string" ? r : r.url, res.clone()); },
};
const KVS = new Map();
const KV = {
  async get(k, type) { const v = KVS.get(k); return v == null ? null : (type === "json" ? JSON.parse(v) : v); },
  async put(k, v) { KVS.set(k, String(v)); },
  async delete(k) { KVS.delete(k); },
  async list() { return { keys: [] }; },
};
/* D1, recording every statement; SELECTs answer from WHERE_ROWS when they
   read the new table, and with nothing otherwise. */
let sql = [], WHERE_ROWS = [];
const stmt = q => ({
  _b: [],
  bind(...b) { this._b = b; sql.push({ q, b }); return this; },
  async all() { return { results: /FROM upstream_where/.test(q) ? WHERE_ROWS : [] }; },
  async first() { return null; },
  async run() { return { success: true }; },
});
const DB = { prepare: q => stmt(q), async batch(list) { return list.map(() => ({ success: true })); } };

const ctx = {
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, URLSearchParams,
  Request, Response, Headers, TextEncoder, TextDecoder, btoa, atob, WeakMap, WeakSet, Symbol,
  Error, TypeError, RegExp, Uint8Array, ArrayBuffer, DataView,
  encodeURIComponent, decodeURIComponent, AbortController,
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: { default: edge },
  fetch: fakeFetch,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler ="), ctx);
const run = code => vm.runInContext(code, ctx);
const OASA = run("OASA");
const TOKEN = "t0ken-for-tests";
const ENV = { ALERTS: KV, DB, ADMIN_TOKEN: TOKEN };

/* A request as Cloudflare hands it over: where it arrived (`cf.colo`), and
   with placement on, where it was run (`cf-placement`). */
function req(pathq, { colo = null, placement = null, admin = false, method = "GET" } = {}) {
  const headers = {};
  if (placement) headers["cf-placement"] = placement;
  if (admin) headers["X-Admin-Token"] = TOKEN;
  const r = new Request("https://oasax.test" + pathq, { method, headers });
  if (colo) Object.defineProperty(r, "cf", { value: { colo } });
  return r;
}
async function call(r, env = ENV) {
  const pending = [];
  ctx.__c = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
  ctx.__req = r; ctx.__env = env;
  const res = await run("__handler.fetch(__req, __env, __c)");
  for (let i = 0; i < 6 && pending.length; i++) await Promise.allSettled(pending.splice(0));
  return res;
}
function reset() {
  EDGE.clear(); KVS.clear(); sent = []; sql = []; WHERE_ROWS = [];
  for (const k of Object.keys(MODE)) delete MODE[k];
  run(`isolateColo = null; circuit.fails = 0; circuit.openedAt = 0; circuit.lastFail = null;
    budget.windowStart = Date.now(); budget.spent = 0; budget.ok = 0; budget.failed = 0;
    budget.flushedAt = Date.now();
    budget.flushed = { hits: budget.hits, misses: budget.misses, aged: budget.aged,
      shed: budget.shed, ok: 0, failed: 0 };
    edgeHeld.clear();`);
}

console.log("\n— where a request ran —");
{
  const p = r => JSON.stringify(run("placementOf")(r));
  ok("placed by Cloudflare: the location in cf-placement, not the one it arrived at",
    p(req("/", { colo: "FRA", placement: "remote-ATH" })) === JSON.stringify({ colo: "ATH", placement: "remote-ATH" }),
    p(req("/", { colo: "FRA", placement: "remote-ATH" })));
  ok("run where it arrived: cf-placement says local, and that is the location",
    run("placementOf")(req("/", { colo: "ATH", placement: "local-ATH" })).colo === "ATH");
  ok("no placement at all: the location it arrived at",
    p(req("/", { colo: "IAD" })) === JSON.stringify({ colo: "IAD", placement: null }), p(req("/", { colo: "IAD" })));
  ok("nothing to go on (local dev, a test): no location rather than a guess",
    p(req("/")) === JSON.stringify({ colo: null, placement: null }));
}
{
  reset();
  const j = await (await call(req("/health", { colo: "FRA", placement: "remote-ATH" }))).json();
  ok("the public /health says where it ran, for free",
    j.ok === true && j.ranIn && j.ranIn.colo === "ATH" && j.ranIn.placement === "remote-ATH", JSON.stringify(j));
  ok("...without spending a call to find out", sent.length === 0, sent.map(s => s.url).join(", "));
  ok("...and without the admin-only figures", !("oasaByLocation24h" in j) && !("egress" in j));
}

console.log("\n— what OASA said, location by location —");
{
  reset();
  await call(req("/health", { colo: "IAD" }));
  ok("an isolate learns its location from the first request it serves", run("isolateColo") === "IAD");
  await call(req("/health", { colo: "EWR" }));
  ok("...and keeps it: an isolate never moves", run("isolateColo") === "IAD");

  const get = (act, p1) => run(`getJSONAged(${JSON.stringify(`${OASA}?act=${act}&p1=${p1}`)}, 0)`);
  MODE.getStopArrivals = "fastfail";
  for (let i = 0; i < 3; i++) await get("getStopArrivals", "1000" + i);
  MODE.getStopArrivals = "ok";
  for (let i = 0; i < 2; i++) await get("getStopArrivals", "2000" + i);
  MODE.getStopArrivals = "hit";
  await get("getStopArrivals", "30001");
  ok("fresh answers and failures are counted; an edge hit is neither",
    run("budget.ok") === 2 && run("budget.failed") === 3, `ok ${run("budget.ok")}, failed ${run("budget.failed")}`);

  sql = [];
  run("budget.flushedAt = 0");
  await run("flushBudget(__env)");
  const w = sql.find(s => /INSERT INTO upstream_where/.test(s.q));
  ok("the flush writes them with the location that asked",
    !!w && w.b[1] === "IAD" && w.b[2] === 2 && w.b[3] === 3, JSON.stringify(w && w.b));
  ok("...next to the cache figures it always wrote", sql.some(s => /INSERT INTO upstream_stat/.test(s.q)));
  sql = [];
  run("budget.flushedAt = 0");
  await run("flushBudget(__env)");
  ok("a flush with nothing new writes nothing", !sql.some(s => /INSERT/.test(s.q)), sql.map(s => s.q).join(" | "));
  ok("the table exists, and is swept with the others",
    /CREATE TABLE IF NOT EXISTS upstream_where\(ts INTEGER, colo TEXT, ok INTEGER,\s*failed INTEGER\)/
      .test(readFileSync(path.join(REPO, "worker.js"), "utf8"))
    && /DELETE FROM upstream_where WHERE ts < \?/.test(readFileSync(path.join(REPO, "worker.js"), "utf8")));
}
{
  reset();
  await call(req("/health", { colo: "ATH" }));
  MODE.getStopArrivals = "ok";
  await run(`getJSONAged(${JSON.stringify(`${OASA}?act=getStopArrivals&p1=1`)}, 0)`);
  WHERE_ROWS = [{ colo: "ATH", ok: 120, failed: 2 }, { colo: "IAD", ok: 0, failed: 14 }];
  const j = await (await call(req("/health", { colo: "ATH", admin: true }))).json();
  ok("the admin /health lists every location's answers for the last day",
    j.oasaByLocation24h && j.oasaByLocation24h.IAD && j.oasaByLocation24h.IAD.failed === 14,
    JSON.stringify(j.oasaByLocation24h));
  ok("...with this isolate's unflushed answers added to its own location",
    j.oasaByLocation24h.ATH.ok === 121 && j.oasaByLocation24h.ATH.failed === 2, JSON.stringify(j.oasaByLocation24h.ATH));
  ok("...and no egress lookup unless asked for", !("egress" in j) && !sent.some(s => /cdn-cgi\/trace/.test(s.url)));
  const j2 = await (await call(req("/health?where=1", { colo: "ATH", admin: true }))).json();
  ok("?where=1 adds the address OASA actually sees",
    j2.egress && j2.egress.colo === "ATH" && j2.egress.ip === "203.0.113.7" && j2.egress.loc === "GR",
    JSON.stringify(j2.egress));
  const j3 = await (await call(req("/health?where=1", { colo: "ATH" }))).json();
  ok("...for the admin only: the public ping never spends a call",
    !("egress" in j3) && sent.filter(s => /cdn-cgi\/trace/.test(s.url)).length === 1);
}
{
  reset();
  const env = { ...ENV, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "q" };
  const r = await call(req("/alerts/run?wait=1", { colo: "FRA", placement: "remote-ATH", admin: true, method: "POST" }), env);
  const t = await r.json();
  ok("the cron's sweep, handed to a request, records where that request ran",
    t.ranIn && t.ranIn.colo === "ATH" && t.ranIn.placement === "remote-ATH", JSON.stringify(t).slice(0, 200));
}

console.log("\n— who is asking —");
{
  reset();
  MODE.getStopArrivals = "ok";
  await run(`getJSONAged(${JSON.stringify(`${OASA}?act=getStopArrivals&p1=7`)}, 0)`);
  const ua = (sent.find(s => s.url.startsWith(OASA)) || {}).ua || "";
  ok("every call to OASA names the app and where to find it, as the request to OASA says",
    /^OASAx\/[\d.]+ \(\+https:\/\/oasax\.com\)$/.test(ua), ua);
}

/* --------------------------- npm run checkup --------------------------- */
console.log("\n— the checkup, in words —");
let HEALTH = null;
const server = http.createServer((q, s) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/health") { s.writeHead(200, { "Content-Type": "application/json" }); return s.end(JSON.stringify(HEALTH)); }
  s.writeHead(404); s.end("{}");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${server.address().port}`;
const base = { ok: true, version: run("APP_VERSION"), time: 0, upstream: { open: false }, budget: {},
  cron: { healthy: true, agoSec: 30 } };
async function checkup(h) {
  HEALTH = { ...base, ...h };
  const env = { ...process.env, ADMIN_TOKEN: TOKEN };
  for (const k of ["CF_ANALYTICS_TOKEN", "CF_API_TOKEN", "CF_ZONE_ID", "OASAX_HOST", "CF_GRAPHQL_URL"]) delete env[k];
  return new Promise(res => execFile(process.execPath, [path.join(REPO, "tools", "checkup.mjs"), HOST],
    { env, timeout: 30000 }, (e, out) => res(String(out || ""))));
}
{
  const out = await checkup({ ranIn: { colo: "ATH", placement: "remote-ATH" },
    oasaByLocation24h: { ATH: { ok: 900, failed: 3 } } });
  ok("in Athens: says so, and how it got there",
    /\[OK  \] This request ran in ATH, where OASA answers\./.test(out) && /Placed by Cloudflare: remote-ATH/.test(out),
    out.split("\n").filter(l => /ran in|Placed/.test(l)).join(" / "));
  ok("...and that OASA answered everywhere it ran",
    /\[OK  \] OASA answered the Worker wherever it ran in the last 24 hours: ATH \(903 calls\)\./.test(out));
}
{
  const out = await checkup({ ranIn: { colo: "FRA", placement: null } });
  ok("abroad, no placement: a FIX that names the setting",
    /\[FIX \] This request ran in FRA, outside Greece, where OASA does not answer\./.test(out)
    && /Turn on \[placement\] in\s+wrangler\.toml/.test(out), out.split("\n").filter(l => /FRA|placement/.test(l)).join(" / "));
}
{
  const out = await checkup({ ranIn: { colo: "FRA", placement: "remote-FRA" } });
  ok("abroad WITH placement: the setting itself is the problem, so undo it",
    /Placement is on \(remote-FRA\) and put the Worker outside Greece\. Undo it/.test(out));
}
{
  const out = await checkup({ ranIn: { colo: "ATH" },
    oasaByLocation24h: { ATH: { ok: 400, failed: 1 }, IAD: { ok: 0, failed: 12 }, FRA: { ok: 2, failed: 1 } } });
  ok("refusals only abroad: OASA's filter, not an outage — and a single miss is not a pattern",
    /\[LOOK\] In the last 24 hours OASA refused the Worker outside Greece \(IAD: 12 of 12 calls failed\)\./.test(out),
    out.split("\n").filter(l => /refused|failed/.test(l)).join(" / "));
}
{
  const out = await checkup({ ranIn: { colo: "ATH" }, oasaByLocation24h: { ATH: { ok: 3, failed: 40 } } });
  ok("failing in Athens too: OASA itself, said differently",
    /\[FIX \] In the last 24 hours most calls to OASA failed, in Greece too \(ATH: 40 of 43 calls failed\)\./.test(out));
}
{
  const out = await checkup({});
  ok("a deploy too old to report a location: no verdict on it either way",
    !/This request ran in/.test(out) && !/OASA answered the Worker wherever/.test(out));
}
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
