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
let overpassReply = null;     // the street geometry and its numbered points
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
ctx.__overpass = () => overpassReply;
vm.runInContext(`
  fetch = async (url, opts) => {
    __record(url, (opts && opts.headers) || {});
    const r = __ors();
    if (r === "throw") throw new Error("ORS down");
    if (r === "500") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  getJSON = async (u) => {
    __record(u, {});
    return String(u).includes("overpass") ? __overpass(u) : __osm();
  };
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

/* ---- the number OpenStreetMap never recorded ------------------------ *
   Most Athens streets carry a few numbered points and no more. Between
   them the position of a number can be read off the road itself, which is
   an estimate, is labelled as one, and lands within a block — where the
   alternative was the midpoint of the whole street. */
console.log("\n— interpolating a house number —");
const STREET = "Φιλοτίμου";
const street = (over = {}) => ({
  lat: "37.9750", lon: "23.7350", class: "highway",
  display_name: `${STREET}, Πολύγωνο, Αθήνα`, address: { road: STREET }, ...over,
});
// a straight run due east, so distance along it is linear in longitude
const road = (lon0 = 23.7300, lon1 = 23.7400) => ({
  type: "way", tags: { highway: "residential", name: STREET },
  geometry: [{ lat: 37.9750, lon: lon0 }, { lat: 37.9750, lon: lon1 }],
});
const at = (n, lon, lat = 37.9750) => ({
  type: "node", lat, lon,
  tags: { "addr:housenumber": String(n), "addr:street": STREET },
});
const askFor = async (num, elements, rows = [street()]) => {
  orsReply = fc();
  osmReply = rows;
  overpassReply = elements === null ? null : { elements };
  return body(await geocode("q=" + encodeURIComponent(`${STREET} ${num}`), KEY));
};
const overpassCalls = () => sent.filter(s => s.url.includes("overpass"));

{
  const j = await askFor(20, [road(), at(10, 23.7320), at(30, 23.7360)]);
  ok("a number between two mapped ones is placed between them",
    Math.abs(Number(j[0].lon) - 23.7340) < 0.0002, j[0].lon);
  ok("...and says so, rather than passing for a surveyed address",
    j[0].precision === "interpolated", j[0].precision);
  ok("...carrying the number the rider asked for",
    j[0].address.house_number === "20" && j[0].address.road === STREET,
    JSON.stringify(j[0].address));
  ok("...and keeping the neighbourhood it was found in",
    /Πολύγωνο/.test(j[0].display_name), j[0].display_name);
}
{
  const j = await askFor(21, [road(), at(11, 23.7320), at(31, 23.7360),
                              at(10, 23.7300), at(100, 23.7400)]);
  ok("odd and even are read off their own pavement",
    Math.abs(Number(j[0].lon) - 23.7340) < 0.0002,
    `${j[0].lon} — mixing the sides doubles the steps per metre`);
}
{
  const j = await askFor(12, [road(), at(10, 23.7320), at(12, 23.7330), at(30, 23.7360)]);
  ok("a number that IS mapped is used as it stands, not estimated",
    j[0].precision === "address" && Math.abs(Number(j[0].lon) - 23.7330) < 0.0002,
    `${j[0].precision} ${j[0].lon}`);
}
{
  const j = await askFor(24, [road(), at(10, 23.7320), at(20, 23.7360)]);
  ok("just past the last mapped number, the rate carries on",
    j[0].precision === "interpolated" && Number(j[0].lon) > 23.7360, j[0].lon);
  const far = await askFor(400, [road(), at(10, 23.7320), at(20, 23.7360)]);
  ok("...but 380 numbers past it is guessing, so the street comes back instead",
    far[0].precision === "street", far[0].precision);
}
{
  const j = await askFor(20, [road(), at(10, 23.7320)]);
  ok("one lonely number is nothing to measure against",
    j[0].precision === "street", j[0].precision);
}
{
  // same numbers, but sitting a street away — they describe a different road
  const j = await askFor(20, [road(), at(10, 23.7320, 37.9790), at(30, 23.7360, 37.9790)]);
  ok("numbered points off the line belong to another street and are ignored",
    j[0].precision === "street", `${j[0].precision} — 440m off the road`);
}
{
  const j = await askFor(20, null);
  ok("Overpass being down leaves the street answer standing",
    j.length === 1 && j[0].precision === "street", JSON.stringify(j[0]));
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("...and it fails fast, because someone is mid-keystroke",
    /timeoutMs: INTERP\.timeoutMs, tries: 1/.test(w) && /timeoutMs: 3500/.test(w),
    "the shared helper retries twice at 8s, which is 16s of nothing on screen");
}
{
  const rows = [street(), street({ lat: "37.9800", lon: "23.7500" }),
                street({ lat: "37.9900", lon: "23.7600" }),
                street({ lat: "38.0000", lon: "23.7700" }),
                street({ lat: "38.0100", lon: "23.7800" })];
  const j = await askFor(20, [road(), at(10, 23.7320), at(30, 23.7360)], rows);
  ok("every same-named street in Athens is still offered", j.length === 5);
  ok("...but only the first few cost an Overpass call",
    overpassCalls().length === 3, `${overpassCalls().length} calls`);
  ok("...and the ones not estimated are still there as streets",
    j.slice(3).every(r => r.precision === "street"));
}
{
  const j = await askFor(20, [road(), at(10, 23.7320), at(30, 23.7360)],
    [street({ lat: "37.9750", lon: "23.7350" }), street({ lat: "37.97501", lon: "23.73502" })]);
  ok("two ways of one road are one street, not two Overpass calls",
    overpassCalls().length === 1, `${overpassCalls().length} calls`);
}
{
  orsReply = fc(feature());          // an exact address, first time of asking
  osmReply = [];
  overpassReply = { elements: [road(), at(10, 23.7320), at(30, 23.7360)] };
  const j = await body(await geocode("q=" + encodeURIComponent("Φιλοτίμου 12"), KEY));
  ok("a geocoder that found the building is not second-guessed",
    j[0].precision === "address" && overpassCalls().length === 0);
}
{
  orsReply = fc();
  osmReply = [street()];
  overpassReply = { elements: [road(), at(10, 23.7320), at(30, 23.7360)] };
  await body(await geocode("q=" + encodeURIComponent(STREET), KEY));
  ok("a search with no number in it never asks", overpassCalls().length === 0,
    "nothing to interpolate, and a quota to protect");
}
{
  await askFor(20, [road(), at(10, 23.7320), at(30, 23.7360)]);
  const q = decodeURIComponent(new URL(overpassCalls()[0].url).searchParams.get("data") || "");
  ok("the query asks for the road and its numbered points in one round trip",
    /\[highway\]\[name="Φιλοτίμου"\]/.test(q) && /addr:housenumber/.test(q), q.slice(0, 90));
  ok("...bounded to the neighbourhood the street was matched in",
    /around:350,37\.975,23\.735/.test(q), q.slice(0, 90));
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
    /function closeJourneyPick\(\)[\s\S]{0,400}jpq\.ctrl\.abort\(\)/.test(html));
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
  ok("an estimated number is labelled as estimated in the list",
    /it\.precision === "interpolated" \? t\("addrApprox"\)/.test(html),
    "the rider has to be able to tell a survey from an interpolation");
  ok("...in both languages", (html.match(/addrApprox:/g) || []).length === 2);
  ok("every map builds its tiles through addTiles",
    (html.match(/L\.tileLayer\(/g) || []).length === 1,
    "a second construction is how the journey map shipped broken in v43");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
