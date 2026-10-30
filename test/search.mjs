/* Finding a place by the name people actually type.

   Three things are defended here. The sound key: "συνταγμα" with no
   accent, "ΣΥΝΤΑΓΜΑ" and "syntagma" have to be one station, and the app
   and the Worker each have a copy of the function that decides that, so
   the two are compared table by table and answer by answer. The stop
   index: every OASA stop by name, built from OASA's GTFS by
   tools/build-stop-index.mjs — the file, the tool, and the URL the app
   fetches it under. And the app itself, driven: a stop across town found
   by name, Greeklish included, listed once per place in the journey
   picker and once per stop in the search. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { deflateRawSync, crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { TOUR_FLAG } from "./_tour.mjs";
import { mustFindBrowser } from "../tools/browser.mjs";
import { readZipEntry, parseCsv, buildIndex, indexUrl } from "../tools/build-stop-index.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const html = readFileSync(path.join(PUB, "index.html"), "utf8");

/* The Worker's copy, out of the module the way geocode.mjs loads it. */
const worker = vm.createContext({
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, Request, Response, Headers,
  TextEncoder, TextDecoder, btoa, atob, WeakMap, Symbol, Error, TypeError, RegExp,
  Uint8Array, ArrayBuffer, DataView, encodeURIComponent, decodeURIComponent,
  crypto: { randomUUID: () => "x", subtle: {} }, caches: { default: {} },
});
vm.runInContext(readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler ="), worker);
/* The app's copy: the block between the Greeklish table and the next function. */
const app = vm.createContext({});
vm.runInContext(html.slice(html.indexOf("const GL2="), html.indexOf("function placeLabel(")), app);
const side = ctx => ({ key: vm.runInContext("soundKey", ctx), keys: vm.runInContext("soundKeys", ctx) });
const W = side(worker), A = side(app);
/* What both copies are used for: does a name contain what was typed. */
const hears = (f, name, typed) => { const k = f.key(name); return f.keys(typed).some(x => !!x && k.includes(x)); };

console.log("\n— one spelling per sound —");
const SAME = [
  ["ΣΥΝΤΑΓΜΑ", "Σύνταγμα", "συνταγμα", "ΣΥΝΤΑΓΜΑ", "syntagma", "Syntagma", "sintagma"],
  ["ΟΜΟΝΟΙΑ", "Ομόνοια", "ομονοια", "omonia", "omonoia", "Omonoia"],
  ["ΧΑΛΑΝΔΡΙ", "Χαλάνδρι", "χαλανδρι", "Xalandri", "Halandri", "Chalandri"],
  ["ΑΙΓΑΛΕΩ", "Αιγάλεω", "Aigaleo", "Egaleo"],
  ["ΚΑΛΛΙΘΕΑ", "Καλλιθέα", "Kallithea", "Kalithea"],
  ["ΕΥΑΓΓΕΛΙΣΜΟΣ", "Ευαγγελισμός", "Evangelismos", "Evaggelismos"],
  ["ΑΜΠΕΛΟΚΗΠΟΙ", "Αμπελόκηποι", "Ampelokipoi", "Ampelokipi"],
  ["ΜΟΝΑΣΤΗΡΑΚΙ", "Μοναστηράκι", "Monastiraki"],
  ["ΠΕΙΡΑΙΑΣ", "Πειραιάς", "Peiraias", "Pireas"],
  ["ΜΑΡΟΥΣΙ", "Μαρούσι", "Marousi", "Maroussi"],
  ["ΤΖΙΤΖΙΦΙΕΣ", "Τζιτζιφιές", "τζιτζιφιες", "tzitzifies"],
];
for (const [name, ...typed] of SAME) {
  const missW = typed.filter(t => !hears(W, name, t)), missA = typed.filter(t => !hears(A, name, t));
  ok(`${name}: every spelling finds it, in the Worker and in the app`, !missW.length && !missA.length,
    missW.length || missA.length ? `missed: worker ${missW.join(", ") || "—"}; app ${missA.join(", ") || "—"}` : "");
}
ok("a part of the name is enough — what the box holds while you are still typing",
  hears(A, "ΕΥΑΓΓΕΛΙΣΜΟΣ", "evang") && hears(A, "ΤΖΙΤΖΙΦΙΕΣ", "τζιτζ") && hears(A, "ΑΙΓΑΛΕΩ", "aiga"));
/* Every letter of the way there, not only the finished word: the box is
   searched on each keystroke, and a name that vanishes at "Συν" and comes
   back at "Συντ" (ντ is one sound, "d") reads as a broken search. */
const typedKeys = vm.runInContext("typedKeys", app);
const finds = (name, q) => { const k = A.key(name); return typedKeys(q).some(x => k.includes(x)); };
const stalls = [];
for (const [name, ...spellings] of SAME) for (const sp of spellings)
  for (let n = 2; n <= sp.length; n++) if (!finds(name, sp.slice(0, n))) stalls.push(`${sp.slice(0, n)}… (${name})`);
ok("typed one letter at a time, every spelling above finds its name at every letter", !stalls.length,
  stalls.join(", "));
/* Many-to-one only helps if it stops somewhere. */
ok("...and different places stay different",
  !hears(A, "ΣΥΝΤΑΓΜΑ", "omonia") && !hears(A, "ΚΑΛΛΙΘΕΑ", "kifisia") && !hears(A, "ΠΕΙΡΑΙΑΣ", "peristeri")
  && !hears(A, "ΜΑΡΟΥΣΙ", "Μαρκόπουλο"));
ok("house numbers survive the key, in both copies",
  A.key("Πατησίων 76") === "patision 76" && W.key("Πατησίων 76") === "patision 76", A.key("Πατησίων 76"));

console.log("\n— the app and the Worker agree —");
/* Table by table first: an input list only covers the letters in it. */
for (const [w, a] of [["SOUND_PAIRS", "SND2"], ["SOUND_ONE", "SND1"], ["DIGRAPHS", "GL2"], ["SINGLES", "GL1"]]) {
  const tw = JSON.stringify(vm.runInContext(w, worker)), ta = JSON.stringify(vm.runInContext(a, app));
  ok(`${w} in worker.js is ${a} in index.html`, tw === ta, tw === ta ? "" : `${tw}\n      vs ${ta}`);
}
const INPUTS = SAME.flat().concat([
  "Λεωφόρος Κηφισίας 120", "λεωφ. Αλεξάνδρας", "Αγίας Παρασκευής 40, Χαλάνδρι", "Φιλοτίμου 12",
  "ΟΜΟΝΟΙΑ - MENANΔΡΟΥ", "14η ΝΤΑΜΑΡΙΑ", "Ag. Paraskevi", "Nea Smyrni", "PSYCHIKO", "Hxx  ou",
  "Ψυχικό", "Ξενία", "Ευριπίδου 8α", "", "   ", "123", "Α/Σ ΚΗΦΙΣΟΥ", "ΓΚΥΖΗ", "μπαμπάς", "ντομάτα",
]);
const diff = INPUTS.filter(s => JSON.stringify(W.keys(s)) !== JSON.stringify(A.keys(s)) || W.key(s) !== A.key(s));
ok(`${INPUTS.length} spellings reduce to the same keys on both sides`, !diff.length,
  diff.map(s => `${JSON.stringify(s)}: worker ${JSON.stringify(W.keys(s))} app ${JSON.stringify(A.keys(s))}`).join("; "));
/* The two are written differently — the app's is regular expressions,
   because it keys every stop in Athens the moment the index arrives — so
   they are also compared on every one of those names. */
const allNames = [...new Set(JSON.parse(readFileSync(path.join(PUB, "stops-index.json"), "utf8")).stops.map(s => s[1]))];
const apart = allNames.filter(n => W.key(n) !== A.key(n));
ok(`...and so does every stop name in the index (${allNames.length})`, !apart.length,
  apart.slice(0, 5).map(n => `${n}: worker ${W.key(n)} app ${A.key(n)}`).join("; "));

console.log("\n— every stop in Athens, by name —");
const body = readFileSync(path.join(PUB, "stops-index.json"), "utf8");
const idx = JSON.parse(body);
const S = idx.stops || [];
ok("the index is version 1 and says where it came from",
  idx.v === 1 && /^\d{4}-\d{2}-\d{2}$/.test(idx.built) && !!idx.source, `${idx.v} ${idx.built} ${idx.source}`);
ok("it holds the whole network, not a sample", S.length >= 7000, String(S.length));
ok("every code is a number, as the live arrivals API takes it, and none twice",
  S.every(s => /^\d+$/.test(s[0])) && new Set(S.map(s => s[0])).size === S.length);
ok("every stop is inside Attica",
  S.every(s => s[2] > 37.5 && s[2] < 38.6 && s[3] > 22.9 && s[3] < 24.4));
ok("every name is there, trimmed, spaced once", S.every(s => s[1] && s[1] === s[1].replace(/\s+/g, " ").trim()));
ok("in code order, so a diff after a rebuild shows what changed",
  S.every((s, i) => !i || Number(S[i - 1][0]) < Number(s[0])));
const syn = S.find(s => s[0] === "10341");
ok("a stop people know is where it should be",
  !!syn && syn[1] === "ΣΥΝΤΑΓΜΑ" && Math.abs(syn[2] - 37.9745) < 0.001 && Math.abs(syn[3] - 23.734) < 0.001,
  JSON.stringify(syn));
ok("small enough for a phone: under 400 KB before compression", body.length < 400 * 1024,
  `${Math.round(body.length / 1024)} KB`);
const url = (html.match(/const STOP_INDEX_URL="([^"]*)"/) || [])[1];
ok("the app asks for exactly this build of the file", url === indexUrl(body),
  url === indexUrl(body) ? "" : `${url} — run: node tools/build-stop-index.mjs <osy_gtfs.zip>, which sets it`);
ok("...which the browser may keep for a week, because the URL changes when the file does",
  /\/stops-index\.json\s*\n\s*Cache-Control: public, max-age=604800/.test(readFileSync(path.join(PUB, "_headers"), "utf8")));

console.log("\n— the tool that builds it —");
const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""",3\n\n4,,"multi\nline"\nlast,row,no-newline');
ok("CSV: quoted commas, doubled quotes, CRLF, blank lines, a last line with no newline",
  JSON.stringify(rows) === JSON.stringify([["a", "b", "c"], ["x, y", 'say "hi"', "3"],
    ["4", "", "multi\nline"], ["last", "row", "no-newline"]]), JSON.stringify(rows));
const built = buildIndex("\ufeffstop_lat,stop_id,stop_lon,stop_name,stop_code\n"
  + '37.97451234,10341,23.73404,"ΣΥΝΤΑΓΜΑ",10341\n'
  + "37.9,-2,23.7,ΠΛΑΚΑ ΤΕΣΤ,-2\n"          // a placeholder code, not a stop
  + "0,555,0,ΠΟΥΘΕΝΑ,555\n"                 // no position
  + '37.95,9,23.7,"  ΠΛΑΤΕΙΑ   ΚΑΛΛΙΘΕΑΣ ",9\n'
  + "37.96,77,23.71,,77\n");                // no name
ok("columns are found by name, in whatever order the feed puts them",
  built.length === 2 && built[1][0] === "10341" && built[1][1] === "ΣΥΝΤΑΓΜΑ", JSON.stringify(built));
ok("placeholder codes, stops with no position and stops with no name are left out",
  !built.some(s => ["-2", "555", "77"].includes(s[0])), JSON.stringify(built));
ok("names are trimmed and spaced once", built[0][1] === "ΠΛΑΤΕΙΑ ΚΑΛΛΙΘΕΑΣ", built[0][1]);
ok("positions are rounded to a metre", built[1][2] === 37.97451, String(built[1][2]));
ok("codes sort as numbers: 9 before 10341", built[0][0] === "9");

/* A zip made by hand, one entry stored and one deflated inside a folder —
   the two forms data.gov.gr's archives have come in. */
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, text, deflate } of entries) {
    const raw = Buffer.from(text, "utf8"), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const STOPS_TXT = "stop_id,stop_name,stop_lat,stop_lon\n10341,ΣΥΝΤΑΓΜΑ,37.97451,23.73404\n";
const z = zip([{ name: "agency.txt", text: "agency_id\nOSY\n" },
  { name: "gtfs/stops.txt", text: STOPS_TXT.repeat(50), deflate: true }]);
ok("a stored entry is read as it is", readZipEntry(z, "agency.txt").toString() === "agency_id\nOSY\n");
ok("a deflated entry inside a folder is found by its file name and inflated",
  readZipEntry(z, "stops.txt").toString() === STOPS_TXT.repeat(50));
const throws = f => { try { f(); return false; } catch (_) { return true; } };
ok("a missing entry, or a file that is not a zip, is an error rather than an empty index",
  throws(() => readZipEntry(z, "trips.txt")) && throws(() => readZipEntry(Buffer.from(STOPS_TXT), "stops.txt")));
ok("the URL is the file's hash: the same file, the same URL; one stop changed, a new one",
  indexUrl("abc") === indexUrl("abc") && indexUrl("abc") !== indexUrl("abd")
  && /^\.\/stops-index\.json\?v=[0-9a-f]{8}$/.test(indexUrl("abc")));

console.log("\n— in the app —");
/* Somewhere in Neos Kosmos: Syntagma is 2 km away and Tzitzifies 3 —
   neither is on the board, which is the point. */
const LAT = 37.9600, LNG = 23.7280;
const NOW = Math.floor(Date.now() / 1000);
const board = [{ code: "9001", name_el: "ΦΡΑΝΤΖΗ", name_en: "FRANTZI", lat: LAT, lng: LNG, dist: 30,
  detail: true, lines: [{ id: "040", el: "040", en: "040" }],
  routes: [{ code: "r1", id: "040", el: "ΠΕΙΡΑΙΑΣ", en: "PIRAEUS" }], arrivals: [{ code: "r1", veh: "V1", min: 4 }] }];
const STATION = { id: "m-syn", name: "Σύνταγμα", name_en: "Syntagma", lines: ["2", "3"], lat: 37.9755, lng: 23.7353 };
let metro = [STATION], indexHits = 0, indexFails = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const J = o => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/health") return J({ ok: true, version: "test" });
  if (u.pathname === "/nearby") return J({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops: board, reports: [] });
  if (u.pathname === "/metro") return J(metro);
  if (u.pathname === "/geocode") return J([]);
  if (u.pathname === "/stops/search") return J({ stops: [] });
  if (u.pathname === "/stops-index.json") {
    indexHits++;
    if (indexFails > 0) { indexFails--; res.writeHead(503); return res.end("busy"); }
    res.writeHead(200, { "Content-Type": "application/json" }); return res.end(body);
  }
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..") && path.extname(f)) {
    res.writeHead(200, { "Content-Type": path.extname(f) === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  J([]);
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: mustFindBrowser() });

async function open(lang = "el") {
  const c = await browser.newContext({ viewport: { width: 390, height: 840 },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.route("**://*.cartocdn.com/**", r => r.abort());
  await c.route("**://tile.openstreetmap.org/**", r => r.abort());
  await c.addInitScript(([l, tf]) => {
    try { localStorage.setItem("lang", l); localStorage.setItem("tourSeen", tf); } catch (_) {}
  }, [lang, TOUR_FLAG]);
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && state.stops && state.stops.length > 0, null, { timeout: 8000 })
    .catch(() => {});
  return { page, ctx: c, errs };
}
const pickRows = p => p.evaluate(() => [...document.querySelectorAll("#jpp-res .res")].map(b => b.textContent.trim()));
/* Type into the A→B picker and wait for the list to settle on an answer. */
async function pick(p, q, want) {
  await p.fill("#jpp-q", q);
  await p.waitForFunction(re => [...document.querySelectorAll("#jpp-res .res")].some(b => new RegExp(re).test(b.textContent)),
    want.source, { timeout: 4000 }).catch(() => {});
  await p.waitForTimeout(250);
  return pickRows(p);
}
const named = (r, re) => r.filter(x => re.test(x));

{
  indexHits = 0;
  const v = await open("el");
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  let r = await pick(v.page, "συνταγμα", /Σύνταγμα/);
  ok("A→B: a station typed with no accent is found", r.some(x => /^Ⓜ Σύνταγμα/.test(x)), r.join(" | "));
  ok("...and the eight ΣΥΝΤΑΓΜΑ bus stops around it are not listed again under the station",
    named(r, /^🚏 ΣΥΝΤΑΓΜΑ( ·|$)/).length === 0, r.join(" | "));
  r = await pick(v.page, "τζιτζιφιες", /ΤΖΙΤΖΙΦΙΕΣ/);
  ok("a stop across town, on no board, is found by its own name", named(r, /^🚏 ΤΖΙΤΖΙΦΙΕΣ/).length > 0, r.join(" | "));
  ok("...its three stops, a short walk apart, are one place to go to", named(r, /^🚏 ΤΖΙΤΖΙΦΙΕΣ/).length === 1,
    r.join(" | "));
  ok("...with how far it is", /^🚏 ΤΖΙΤΖΙΦΙΕΣ · \d+(\.\d)? ?k?m$/.test(named(r, /^🚏 ΤΖΙΤΖΙΦΙΕΣ/)[0] || ""),
    named(r, /ΤΖΙΤΖΙΦΙΕΣ/).join(" | "));
  r = await pick(v.page, "tzitzifies", /ΤΖΙΤΖΙΦΙΕΣ/);
  ok("...and in Greeklish", named(r, /^🚏 ΤΖΙΤΖΙΦΙΕΣ/).length === 1, r.join(" | "));
  r = await pick(v.page, "omonoia", /ΟΜΟΝΟΙΑ/);
  ok("Greeklish with the diphthong spelled out finds ΟΜΟΝΟΙΑ, once", named(r, /^🚏 ΟΜΟΝΟΙΑ( ·|$)/).length === 1,
    r.join(" | "));
  const picked = await v.page.evaluate(() => {
    const b = [...document.querySelectorAll("#jpp-res .res")].find(x => /^🚏 ΟΜΟΝΟΙΑ( ·|$)/.test(x.textContent.trim()));
    b.click();
    return jp.to && { kind: jp.to.kind, lat: jp.to.lat, lng: jp.to.lng, label: jp.to.label };
  });
  ok("choosing it makes it the destination, at a real OMONOIA stop",
    !!picked && picked.kind === "stop" && picked.label === "ΟΜΟΝΟΙΑ"
    && S.some(s => s[1] === "ΟΜΟΝΟΙΑ" && s[2] === picked.lat && s[3] === picked.lng), JSON.stringify(picked));

  await v.page.evaluate(() => closeJourney());
  await v.page.click("#findbtn");
  await v.page.waitForTimeout(200);
  await v.page.fill("#lnq", "Τζιτζιφιές");
  await v.page.evaluate(() => doLineSearch());
  await v.page.waitForFunction(() => document.querySelectorAll("#lnres .res").length > 0, null, { timeout: 4000 })
    .catch(() => {});
  const found = await v.page.evaluate(() => [...document.querySelectorAll("#lnres .res")].map(b => b.textContent.trim()));
  ok("the search finds it too — each of its stops, since each has its own arrivals",
    named(found, /🚏 ΤΖΙΤΖΙΦΙΕΣ · /).length === 3, found.join(" | "));
  await v.page.evaluate(() => [...document.querySelectorAll("#lnres .res")].find(b => /ΤΖΙΤΖΙΦΙΕΣ/.test(b.textContent)).click());
  await v.page.waitForTimeout(300);
  const card = await v.page.evaluate(() => ({ on: document.getElementById("stopcard").classList.contains("on"),
    text: document.getElementById("stopcard").textContent }));
  ok("...and a stop found that way opens like any other", card.on && /ΤΖΙΤΖΙΦΙΕΣ/.test(card.text));
  ok("the index was fetched once for all of that", indexHits === 1, `${indexHits} requests`);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  metro = [];
  const v = await open("en");
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  const r = await pick(v.page, "syntagma", /ΣΥΝΤΑΓΜΑ/);
  ok("with no station to stand for them, the eight ΣΥΝΤΑΓΜΑ stops are one row",
    named(r, /^🚏 ΣΥΝΤΑΓΜΑ( ·|$)/).length === 1, r.join(" | "));
  ok("...while a stop with a different name nearby keeps its own",
    named(r, /^🚏 ΠΛ\. ΣΥΝΤΑΓΜΑΤΟΣ/).length === 1, r.join(" | "));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
  metro = [STATION];
}
{
  /* The index is a file on the same server as the app, so it fails when
     the app is having a bad minute — and must not stay failed. */
  indexHits = 0; indexFails = 1;
  const v = await open("el");
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(400);
  let r = await pick(v.page, "συνταγμα", /Σύνταγμα/);
  ok("the index failing to load leaves the rest of the picker working", r.some(x => /^Ⓜ Σύνταγμα/.test(x)),
    r.join(" | "));
  await v.page.evaluate(() => closeJourneyPick());
  await v.page.evaluate(() => openJourneyPick("to"));
  r = await pick(v.page, "τζιτζιφιες", /ΤΖΙΤΖΙΦΙΕΣ/);
  ok("...and the next search asks for it again, and has it", named(r, /^🚏 ΤΖΙΤΖΙΦΙΕΣ/).length === 1
    && indexHits === 2, `${indexHits} requests; ${r.join(" | ")}`);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
