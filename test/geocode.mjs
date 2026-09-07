/* Address search. Two geocoders sit behind one endpoint — OpenRouteService's
   Pelias autocomplete when ORS_KEY is set, Nominatim when it is not — and the
   app is never told which answered, so the contract this file defends is that
   both come back looking the same.

   worker.js is loaded into a vm with fetch and getJSON swapped for fixtures.
   Nothing here touches the network, ORS's daily quota, or Nominatim.

   The whole file is kept: json(), withCors() and friends are declared after
   `export default`, which is fine in a module because declarations hoist,
   but not if a harness truncates there. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const src = readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler =");

/* Every ORS request the code makes, recorded whole — url and headers both,
   because "the key must not be in the URL" is the point of one of the tests
   below and can only be checked by looking at what was actually sent. */
let sent = [];
let orsReply = null;          // set per test: a Pelias FeatureCollection, or a thrower
let osmReply = null;          // what the Nominatim fallback returns
let cachePuts = [];

const ctx = {
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, Request, Response, Headers,
  TextEncoder, TextDecoder, btoa, atob, WeakMap, Symbol, Error, TypeError, RegExp,
  Uint8Array, ArrayBuffer, DataView, encodeURIComponent, decodeURIComponent,
  AbortController: class { constructor() { this.signal = null; } abort() {} },
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: {
    default: {
      async match() { return undefined; },          // always a cold cache
      async put(req, res) { cachePuts.push(req.url); },
    },
  },
  fetch: async () => { throw new Error("no network in the harness"); },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);

ctx.__record = (url, headers) => sent.push({ url, headers });
ctx.__ors = () => orsReply;
ctx.__osm = () => osmReply;
vm.runInContext(`
  fetch = async (url, opts) => {
    __record(url, (opts && opts.headers) || {});
    const r = __ors();
    if (r === "throw") throw new Error("ORS down");
    if (r === "500") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  getJSON = async (u) => { __record(u, {}); return __osm(); };
`, ctx);

const geocode = (params, env) => {
  sent = []; cachePuts = [];
  const u = new URL("https://x/geocode?" + params);
  return vm.runInContext("handleGeocode", ctx)(u, env);
};
const body = async r => r.json();
const orsCalls = () => sent.filter(s => s.url.includes("openrouteservice"));
const osmCalls = () => sent.filter(s => s.url.includes("nominatim"));
const KEY = { ORS_KEY: "test-key-123" };

/* A Pelias answer shaped the way ORS actually returns it: GeoJSON, with
   coordinates in lng,lat order and the interesting parts under properties. */
const feature = (over = {}) => ({
  geometry: { type: "Point", coordinates: [23.7348, 37.9755] },
  properties: {
    layer: "address", name: "Φιλοτίμου 12", street: "Φιλοτίμου", housenumber: "12",
    neighbourhood: "Αμπελόκηποι", borough: "Αθήνα", locality: "Αθήνα",
    label: "Φιλοτίμου 12, Αθήνα, Ελλάδα", ...over,
  },
});
const fc = (...feats) => ({ type: "FeatureCollection", features: feats });

console.log("\n— the request that goes out —");
{
  orsReply = fc(feature());
  const r = await geocode("q=filotimou&lat=37.9755&lng=23.7348", KEY);
  await body(r);
  const c = orsCalls()[0];
  const q = new URL(c.url).searchParams;
  ok("the autocomplete endpoint is the one called", /geocode\/autocomplete/.test(c.url));
  ok("the key travels in a header, never the query",
    c.headers.Authorization === KEY.ORS_KEY && !/api_key/.test(c.url),
    "otherwise the secret lands in the cache key for every search ever run");
  ok("results are boxed to Attica",
    q.get("boundary.rect.min_lon") === "23.4" && q.get("boundary.rect.max_lat") === "38.4",
    `${q.get("boundary.rect.min_lon")}..${q.get("boundary.rect.max_lon")}`);
  ok("...and to Greece", q.get("boundary.country") === "GRC");
  ok("your position biases the ranking",
    q.get("focus.point.lat") === "37.98" && q.get("focus.point.lon") === "23.73",
    "focus.point " + q.get("focus.point.lat") + "," + q.get("focus.point.lon"));
  ok("coarse layers are excluded",
    !/\bregion\b|\bcountry\b/.test(q.get("layers") || ""), q.get("layers"));
}
{
  orsReply = fc(feature());
  await body(await geocode("q=syntagma", KEY));
  const q = new URL(orsCalls()[0].url).searchParams;
  ok("with no position, nothing is focused", !q.has("focus.point.lat"));
}
{
  orsReply = fc(feature());
  await body(await geocode("q=syntagma&lang=en", KEY));
  ok("the label language follows the app",
    new URL(orsCalls()[0].url).searchParams.get("lang") === "en");
}

/* Pelias splits address parsing out of /autocomplete, so a query with a
   house number has to go to /search or the number is quietly dropped and
   you get the middle of the street. */
console.log("\n— house numbers —");
{
  const endpointFor = async q => {
    orsReply = fc(feature());
    await body(await geocode("q=" + encodeURIComponent(q), KEY));
    return new URL(orsCalls()[0].url).pathname;
  };
  const addressed = ["Φιλοτίμου 12", "filotimou 12", "Λεωφόρος Αλεξάνδρας 45",
                     "Ερμού 12Α", "Πατησίων 12-14", "12 Φιλοτίμου"];
  for (const q of addressed) {
    ok(`"${q}" goes to the full address parser`,
      (await endpointFor(q)) === "/geocode/search");
  }
  const notAddressed = ["Σύνταγμα", "syntagma", "608", "11527",
                        "Πλατεία Αμερικής", "φιλ"];
  for (const q of notAddressed) {
    ok(`"${q}" stays on autocomplete`,
      (await endpointFor(q)) === "/geocode/autocomplete",
      "a line number, a postcode and a half-typed word are not addresses");
  }
}
{
  orsReply = fc(feature());
  await body(await geocode("q=" + encodeURIComponent("Φιλοτίμου 12"), KEY));
  const q = new URL(orsCalls()[0].url).searchParams;
  ok("an addressed query narrows the layers to the one thing asked for",
    q.get("layers") === "address,street", q.get("layers"));
  ok("...and keeps the Attica box", q.get("boundary.rect.min_lon") === "23.4");
}
{
  orsReply = fc(feature());
  await body(await geocode("q=filotimou%2012", KEY));
  ok("a latin numbered address is tried as typed first",
    new URL(orsCalls()[0].url).searchParams.get("text") === "filotimou 12");
}
{
  let n = 0;
  ctx.__ors = () => (++n === 1 ? fc() : fc(feature()));
  await body(await geocode("q=filotimou%2012", KEY));
  ok("...then transliterated with the number left alone",
    new URL(orsCalls()[1].url).searchParams.get("text") === "φιλοτιμου 12",
    new URL(orsCalls()[1].url).searchParams.get("text"));
  ctx.__ors = () => orsReply;
}

console.log("\n— what comes back —");
{
  orsReply = fc(feature());
  const j = await body(await geocode("q=filotimou", KEY));
  const row = j[0];
  ok("one row per feature", j.length === 1);
  ok("coordinates are un-flipped from GeoJSON's lng,lat",
    Number(row.lat).toFixed(4) === "37.9755" && Number(row.lon).toFixed(4) === "23.7348",
    `${row.lat},${row.lon}`);
  ok("the house number survives into the label", row.address.road === "Φιλοτίμου 12",
    "losing it is what made the old address labels useless");
  ok("the area comes through", row.address.neighbourhood === "Αμπελόκηποι");
  ok("...and the city", row.address.city === "Αθήνα");
  ok("the row says which geocoder answered", row.source === "ors");
  ok("a street is not mistaken for a venue", row.address.amenity === null);
}
{
  orsReply = fc(feature({ layer: "street", name: "Φιλοτίμου", housenumber: undefined }));
  const j = await body(await geocode("q=filotimou", KEY));
  ok("a street with no number is just the street", j[0].address.road === "Φιλοτίμου");
}
{
  orsReply = fc(feature({ layer: "venue", name: "Μουσείο Μπενάκη", street: undefined }));
  const j = await body(await geocode("q=benaki", KEY));
  ok("a venue lands in the field the label builder reads for one",
    j[0].address.amenity === "Μουσείο Μπενάκη" && j[0].address.road === null);
}
{
  orsReply = { type: "FeatureCollection", features: [
    { properties: { label: "nowhere" } },                                  // no geometry
    { geometry: { coordinates: ["x", "y"] }, properties: { label: "bad" } }, // unparseable
    feature(),
  ] };
  const j = await body(await geocode("q=filotimou", KEY));
  ok("features without usable coordinates are dropped, not rendered", j.length === 1);
}

console.log("\n— greeklish —");
{
  orsReply = fc(feature());
  await body(await geocode("q=filotimou", KEY));
  ok("a latin query is tried as typed first", orsCalls().length === 1 &&
    new URL(orsCalls()[0].url).searchParams.get("text") === "filotimou",
    "Pelias indexes the English names too");
}
{
  let n = 0;
  ctx.__ors = () => (++n === 1 ? fc() : fc(feature()));   // first spelling misses
  await body(await geocode("q=filotimou", KEY));
  ok("...and only then transliterated", orsCalls().length === 2 &&
    new URL(orsCalls()[1].url).searchParams.get("text") === "φιλοτιμου",
    new URL(orsCalls()[1].url).searchParams.get("text"));
  ctx.__ors = () => orsReply;
}
{
  orsReply = fc();
  osmReply = [];
  await body(await geocode("q=filotimou", KEY));
  ok("two shots at ORS, never four", orsCalls().length === 2,
    `${orsCalls().length} — every miss is a request off the daily quota`);
}
{
  orsReply = fc(feature());
  await body(await geocode("q=Σύνταγμα", KEY));
  ok("a Greek query is not transliterated at all", orsCalls().length === 1);
}

console.log("\n— falling back —");
{
  orsReply = fc();
  osmReply = [{ lat: "37.97", lon: "23.73", display_name: "Σύνταγμα, Αθήνα",
                address: { road: "Σύνταγμα" } }];
  const j = await body(await geocode("q=syntagma", KEY));
  ok("ORS finding nothing hands over to Nominatim rather than giving up",
    j.length === 1 && j[0].source === "osm");
  ok("...and Nominatim is only asked after ORS has been", osmCalls().length >= 1);
}
{
  orsReply = "throw";
  osmReply = [{ lat: "37.97", lon: "23.73", display_name: "Σύνταγμα", address: {} }];
  const j = await body(await geocode("q=syntagma", KEY));
  ok("ORS being down falls back too, it does not 500", j.length === 1 && j[0].source === "osm");
}
{
  orsReply = "500";
  osmReply = [{ lat: "37.97", lon: "23.73", display_name: "Σύνταγμα", address: {} }];
  const j = await body(await geocode("q=syntagma", KEY));
  ok("...as does a rejected key", j.length === 1 && j[0].source === "osm");
}
{
  orsReply = fc(feature());
  osmReply = [{ lat: "37.97", lon: "23.73", display_name: "Σύνταγμα", address: {} }];
  const j = await body(await geocode("q=syntagma", {}));
  ok("with no key configured ORS is never called at all", orsCalls().length === 0);
  ok("...and the app still gets addresses", j.length === 1 && j[0].source === "osm");
}
{
  orsReply = fc();
  osmReply = [];
  const j = await body(await geocode("q=zzzzzz", KEY));
  ok("nothing anywhere is an empty list, not an error", Array.isArray(j) && j.length === 0);
}
{
  const r = await geocode("q=", KEY);
  ok("an empty query is refused before any request goes out",
    r.status === 400 && sent.length === 0);
}

console.log("\n— caching —");
{
  orsReply = fc(feature());
  await body(await geocode("q=filotimou&lat=37.9755&lng=23.7348", KEY));
  ok("a hit is cached", cachePuts.length === 1);
  ok("...under a key with no secret in it", !/test-key-123/.test(cachePuts[0] || ""),
    cachePuts[0]);
}
{
  orsReply = fc();
  osmReply = [];
  await body(await geocode("q=zzzzzz", KEY));
  ok("a miss is not cached, so a later index update can answer it",
    cachePuts.length === 0);
}
{
  orsReply = fc(feature());
  await body(await geocode("q=filotimou&lat=37.975512&lng=23.734829", KEY));
  const q = new URL(orsCalls()[0].url).searchParams;
  ok("the focus point is coarse, so a neighbourhood shares one cache entry",
    /^\d+\.\d\d$/.test(q.get("focus.point.lat")) && /^\d+\.\d\d$/.test(q.get("focus.point.lon")),
    `${q.get("focus.point.lat")},${q.get("focus.point.lon")} — it only nudges the ranking`);
}

/* ---- the client half: the picker has to survive fast typing ---------- */
console.log("\n— the type-ahead itself —");
{
  const html = readFileSync(path.join(REPO, "public", "index.html"), "utf8");
  ok("the focus point is sent from the app", /geocode\?q=\$\{[^}]*\}&lang=/.test(html) &&
    /url\+=`&lat=\$\{o\.focus\.lat/.test(html));
  ok("a newer keystroke aborts the older request", /jpq\.ctrl\.abort\(\)/.test(html));
  ok("...and a late answer is discarded rather than rendered",
    /if \(seq !== jpq\.seq\) return;/.test(html),
    "otherwise a slow 'syn' overwrites a fast 'syntagma'");
  ok("an abort is not reported to the user as a network failure",
    /e\.name === "AbortError"/.test(html));
  ok("closing the picker orphans anything still in flight",
    /closeJourneyPick\(\)[\s\S]{0,220}jpq\.ctrl\.abort\(\)/.test(html));
  ok("the dials are named in one place, not sprinkled",
    /const JPQ = \{ minChars: \d+, debounceMs: \d+, minGapMs: \d+, memo: \d+ \}/.test(html));
  ok("a floor sits between requests, on top of the debounce",
    /JPQ\.minGapMs - \(Date\.now\(\) - jpq\.last\)/.test(html),
    "measured 7 requests for one nine-letter street without it");
  ok("...and waiting out that floor lets a newer keystroke win first",
    /await new Promise\(r => setTimeout\(r, gap\)\);[\s\S]{0,80}if \(seq !== jpq\.seq\) return;/.test(html));
  ok("a query already answered this session is served from memory",
    /jpq\.seen\.has\(query\)/.test(html), "backspacing costs nothing");
  ok("...and the memo is bounded", /while \(jpq\.seen\.size > JPQ\.memo\)/.test(html));
  ok("a failed lookup is not memoised as an answer",
    /if \(!failed\) \{\s*jpq\.seen\.set\(query, items\);/.test(html));
  ok("'no results' still appears on the memoised path",
    /jpq\.seen\.get\(query\)\); noneMsg\(false\)/.test(html) && /addAddrs\(items\);\s*noneMsg\(failed\)/.test(html),
    "both exits report the empty case; a blank list is not an answer");
  ok("...and the input actually uses them", /qt=setTimeout\([\s\S]{0,80}JPQ\.debounceMs\)/.test(html) &&
    /query\.length < JPQ\.minChars/.test(html));
  ok("address hits are told apart from stops at a glance",
    /add\("📍 " \+ lab/.test(html));
  ok("every map builds its tiles through addTiles",
    (html.match(/L\.tileLayer\(/g) || []).length === 1,
    "a second construction is how the journey map shipped broken in v43");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
