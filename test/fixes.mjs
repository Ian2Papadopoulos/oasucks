/* Four bugs a user hit in the wild, each with a test that would have
   caught it.

   The common thread is that all four failed *quietly*. A dropped house
   number looked like a search that didn't understand you. A straight line
   across the blocks looked like a walking route. A blocked permission
   looked like a dead button. None of them threw, none of them logged, and
   none of the existing suites noticed — which is the argument for pinning
   the behaviour rather than the absence of an exception. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { TOUR_FLAG } from "./_tour.mjs";
import { mustFindBrowser } from "../tools/browser.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const NOW = Math.floor(Date.now() / 1000);
const LAT = 37.976, LNG = 23.73;
const stops = [{ code: "500", name_el: "ΚΟΝΤΑ", name_en: "NEAR", lat: LAT, lng: LNG, dist: 40,
  detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V1", min: 4 }] }];

/* A two-leg plan whose walking legs are deliberately NOT routed, so the
   client has something to go and fill in. */
const straight = (a, b) => [[a.lat, a.lng], [b.lat, b.lng]];
const A = { lat: LAT, lng: LNG }, B = { lat: LAT + 0.004, lng: LNG }, C = { lat: LAT + 0.01, lng: LNG };
const PLAN = {
  departAt: Date.now(), walkRouting: true, service: { bus: true, metro: true },
  itineraries: [{
    kind: "best", totalMin: 20, changes: 0, basis: "live",
    legs: [
      { mode: "walk", min: 5, metres: 400, startMin: 0, basis: "estimated",
        to: { el: "ΣΤΑΣΗ", en: "STOP" }, path: straight(A, B) },
      { mode: "bus", line: "608", stops: 4, wait: 3, rideMin: 8, min: 11, startMin: 5,
        basis: "live", from: { el: "Α", en: "A" }, to: { el: "Β", en: "B" },
        headsign: { el: "ΚΕΝΤΡΟ", en: "CENTRE" }, path: straight(B, C) },
      { mode: "walk", min: 4, metres: 300, startMin: 16, basis: "estimated",
        to: { el: "ΤΕΛΟΣ", en: "END" }, path: straight(C, { lat: C.lat + 0.002, lng: LNG }) },
    ],
  }],
};
// a dog-leg: what a real pavement looks like, and unmistakably not a line
const ROUTED = { min: 6.2, metres: 470, basis: "routed",
  path: [[LAT, LNG], [LAT, LNG + 0.003], [LAT + 0.004, LNG + 0.003], [LAT + 0.004, LNG]] };

let walkCalls = [], walkStatus = 200;
/* Switches the two tests below flip to make one request fail exactly once. */
let healthFails = 0, healthHits = 0, nearbyFails = 0, oasaDown = false, oasaStale = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const J = o => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  // the mode probe: is there a Worker on this origin
  if (u.pathname === "/health") {
    healthHits++;
    if (healthFails > 0) { healthFails--; res.writeHead(503); return res.end("{}"); }
    return J({ ok: true, version: "test" });
  }
  if (u.pathname === "/nearby") {
    if (nearbyFails > 0) { nearbyFails--; res.writeHead(503); return res.end("{}"); }
    if (oasaStale) { return J({ origin: {}, radius: 600, generated: NOW - 260, hidden: 0,
      stops, reports: [], stale: true, upstream: "down" }); }
    if (oasaDown) { res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ origin: {}, radius: 600, generated: NOW, hidden: 0,
        stops: [], reports: [], upstream: "down" })); }
    return J({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] });
  }
  if (u.pathname === "/plan") return J(JSON.parse(JSON.stringify(PLAN)));
  if (u.pathname === "/walk") {
    walkCalls.push(u.search);
    if (walkStatus !== 200) { res.writeHead(walkStatus, { "Content-Type": "application/json" });
      return res.end('{"error":"nope"}'); }
    return J(ROUTED);
  }
  if (u.pathname === "/geocode") return J([{ lat: "37.98", lon: "23.73",
    display_name: "12, Φιλοτίμου, Αμπελόκηποι, Αθήνα",
    address: { house_number: "12", road: "Φιλοτίμου", suburb: "Αμπελόκηποι", city: "Αθήνα" },
    source: "osm" }]);
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    res.writeHead(200, { "Content-Type": e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  J([]);
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: mustFindBrowser() });

async function open({ geo = true } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 800 },
    permissions: geo ? ["geolocation"] : [],
    geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(tf => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf); } catch (_) {}
  }, TOUR_FLAG);
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1300);
  return { page, ctx: c, errs };
}

/* ------------------------- 1. house numbers ------------------------- */
console.log("\n— a house number survives into the label —");
{
  const v = await open();
  const label = await v.page.evaluate(() => placeLabel({
    address: { house_number: "12", road: "Φιλοτίμου", suburb: "Αμπελόκηποι" } }));
  ok("the number is shown, not dropped", /12/.test(label), label);
  ok("...after the street, as Greek addresses are written",
    /Φιλοτίμου 12/.test(label), label);
  ok("...with the area still there", /Αμπελόκηποι/.test(label), label);

  const already = await v.page.evaluate(() => placeLabel({
    address: { house_number: "12", road: "Φιλοτίμου 12", suburb: "Αμπελόκηποι" } }));
  ok("a geocoder that already folded it in is not doubled up",
    (already.match(/12/g) || []).length === 1, already);

  const bare = await v.page.evaluate(() => placeLabel({
    address: { road: "Φιλοτίμου", suburb: "Αμπελόκηποι" } }));
  ok("a street with no number is unchanged", bare === "Φιλοτίμου, Αμπελόκηποι", bare);

  const poi = await v.page.evaluate(() => placeLabel({
    address: { amenity: "Μουσείο Μπενάκη", suburb: "Κολωνάκι" } }));
  ok("a venue is unaffected", /Μπενάκη/.test(poi), poi);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open();
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.fill("#jpp-q", "Φιλοτίμου 12");
  await v.page.waitForTimeout(1400);
  const rows = await v.page.evaluate(() =>
    [...document.querySelectorAll("#jpp-res .res")].map(b => b.textContent.trim()));
  ok("the picker shows the numbered address, end to end",
    rows.some(r => /Φιλοτίμου 12/.test(r)), rows.join(" | ") || "(no rows)");
  await v.ctx.close();
}

/* ---------------------- 2. real walking geometry --------------------- */
console.log("\n— an opened itinerary gets its real walking shape —");
{
  walkCalls = []; walkStatus = 200;
  const v = await open();
  await v.page.evaluate(() => {
    jp.from = { kind: "me", lat: 37.976, lng: 23.73 };
    jp.to = { kind: "addr", lat: 37.99, lng: 23.73, label: "X" };
    return runJourney();
  });
  await v.page.waitForTimeout(600);
  await v.page.evaluate(() => openItinerary(jp.res.itineraries[0]));
  await v.page.waitForTimeout(1200);

  ok("both estimated walking legs were routed", walkCalls.length === 2,
    `${walkCalls.length} calls — the planner only routes the winner, so opening any option must fill the rest`);
  const legs = await v.page.evaluate(() => jp.current.legs.map(l => ({ m: l.mode, b: l.basis, n: (l.path || []).length })));
  ok("...and they are no longer straight lines",
    legs.filter(l => l.m === "walk").every(l => l.n > 2),
    JSON.stringify(legs));
  ok("...and say so", legs.filter(l => l.m === "walk").every(l => l.b === "routed"),
    JSON.stringify(legs));
  ok("the riding leg was left alone", walkCalls.every(c => !/23\.73,37/.test(c)));
  ok("the caveat about estimated walking is gone from the notes",
    !(await v.page.evaluate(() => $("#jpr-strip").innerText)).match(/straight-line/i));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  walkCalls = []; walkStatus = 501;                 // no router configured
  const v = await open();
  await v.page.evaluate(() => {
    jp.from = { kind: "me", lat: 37.976, lng: 23.73 };
    jp.to = { kind: "addr", lat: 37.99, lng: 23.73, label: "X" };
    return runJourney();
  });
  await v.page.waitForTimeout(600);
  await v.page.evaluate(() => openItinerary(jp.res.itineraries[0]));
  await v.page.waitForTimeout(1200);
  ok("a router that is not configured is asked once, then left alone",
    walkCalls.length === 1, `${walkCalls.length} calls`);
  ok("...and the itinerary still renders",
    await v.page.evaluate(() => $("#jpr").classList.contains("on")));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
  walkStatus = 200;
}
{
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("the endpoint caches, because a pavement is not news",
    /WALK_CACHE = 7 \* 86400/.test(w));
  ok("...and refuses cleanly with no key rather than 500ing",
    /no walking router configured" \}, 501\)/.test(w));
  ok("/health reports whether the router is configured at all",
    /ors: !!env\.ORS_KEY/.test(w),
    "the same key drives house numbers and walking shapes");
}

/* --------------------- 3. blocked location --------------------- */
console.log("\n— location blocked, and the app says so —");
{
  const v = await open({ geo: false });
  await v.page.waitForTimeout(700);
  const st = await v.page.evaluate(() => ({
    shown: !document.getElementById("geoblock").hidden,
    sheet: document.getElementById("sheetbg").classList.contains("on"),
    text: document.getElementById("geoblock").innerText,
  }));
  ok("a refusal is explained, not swallowed", st.shown, JSON.stringify(st).slice(0, 90));
  ok("...on the sheet, where the alternatives are", st.sheet);
  ok("...saying the app cannot ask again", /can't ask for permission again/i.test(st.text));
  ok("...and where to unblock it", /Site settings|Permissions/i.test(st.text));
  ok("...with a way to retry", /Try again/i.test(st.text));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open({ geo: false });
  await v.page.waitForTimeout(700);
  // the button that used to do nothing at all
  await v.page.evaluate(() => { document.getElementById("geoblock").classList.remove("pulse"); });
  await v.page.click("#gps");
  await v.page.waitForTimeout(400);
  const reacted = await v.page.evaluate(() => {
    const b = document.getElementById("geoblock");
    return !b.hidden && b.classList.contains("pulse");
  });
  ok("tapping 'use my location' visibly reacts instead of doing nothing", reacted,
    "the original bug: a dead button and an unexplained sheet");
  await v.ctx.close();
}
{
  const v = await open({ geo: false });
  await v.page.waitForTimeout(700);
  await v.page.click("#gb-retry");
  await v.page.waitForTimeout(500);
  const msg = await v.page.evaluate(() => document.body.innerText);
  ok("retrying while still blocked says so rather than failing silently",
    /Still blocked/i.test(msg), "a retry that looks identical to no-op is the same bug again");
  await v.ctx.close();
}
{
  // permission granted from the start: no panel, and it is never shown
  const v = await open({ geo: true });
  await v.page.waitForTimeout(900);
  ok("with permission granted the panel stays out of the way",
    await v.page.evaluate(() => document.getElementById("geoblock").hidden));
  await v.ctx.close();
}
{
  const v = await open({ geo: false });
  await v.page.waitForTimeout(700);
  // grant it the way a person would: in browser settings, mid-session
  await v.ctx.grantPermissions(["geolocation"]);
  await v.page.waitForTimeout(1500);
  const healed = await v.page.evaluate(() => document.getElementById("geoblock").hidden);
  ok("granting it later heals the app without a reload", healed,
    "nobody thinks to restart a web app, so it has to notice by itself");
  await v.ctx.close();
}

/* ------------------------- 4. https headers ------------------------- */
console.log("\n— served as a secure origin —");
{
  const h = readFileSync(path.join(PUB, "_headers"), "utf8");
  // the directives only — the comments discuss what was left out
  const rules = h.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  ok("HSTS is set", /Strict-Transport-Security: max-age=\d+/.test(rules));
  ok("...without includeSubDomains or preload, which are near-irreversible",
    !/includeSubDomains|preload/.test(rules),
    rules.match(/Strict-Transport-Security:.*/)?.[0]);
  ok("content types are not sniffed", /X-Content-Type-Options: nosniff/.test(h));
  ok("the app cannot be framed", /X-Frame-Options: DENY/.test(h));
  ok("paths are not leaked to tile and geocoding hosts",
    /Referrer-Policy: strict-origin-when-cross-origin/.test(h));
  ok("only the app itself may ask for location",
    /Permissions-Policy: geolocation=\(self\)/.test(h));
  ok("the file explains that the redirect is the actual fix",
    /Always Use HTTPS/.test(h), "HSTS does nothing on a first visit");
}
{
  /* Mixed content is the other way a padlock breaks, and it is the one a
     code change can cause. Nothing the browser fetches may be http://. */
  for (const f of ["index.html", "legal.html", "sw.js", "manifest.webmanifest"]) {
    const src = readFileSync(path.join(PUB, f), "utf8");
    const bad = (src.match(/["'(]http:\/\/[^"')\s]+/g) || [])
      .filter(u => !/w3\.org\/\d{4}\/svg/.test(u));     // an XML namespace, not a fetch
    ok(`${f} fetches nothing over plain http`, bad.length === 0, bad.join(" "));
  }
}

/* The morning the board came up empty on a fast connection, and the
   morning after that when it showed loading placeholders forever. Both
   were the same root cause — a boot that could not proceed until one
   request succeeded — and the second was worse because the fix for the
   first hid the error behind an animation. */
console.log("\n— a bad minute must not take the app down —");
{
  healthFails = 99;                     // /health never answers at all
  const v = await open({ geo: true });
  await v.page.waitForTimeout(2500);
  const st = await v.page.evaluate(() => ({
    mode: MODE, stops: state.stops.length,
    rows: document.querySelectorAll("#list .stop:not(.skel-card)").length,
  }));
  ok("the board fills even with /health dead, because nothing waits on it",
    st.mode === "same" && st.stops > 0 && st.rows > 0, JSON.stringify(st));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
  healthFails = 0;
}
{
  nearbyFails = 1;                      // one blip, then fine
  const v = await open({ geo: true });
  await v.page.waitForTimeout(3000);
  ok("a failed first sweep retries itself rather than waiting for a tap",
    await v.page.evaluate(() =>
      document.querySelectorAll("#list .stop:not(.skel-card)").length > 0),
    "one blip used to leave an empty board and a button");
  await v.ctx.close();
  nearbyFails = 0;
}
{
  const v = await open({ geo: true });
  await v.page.waitForTimeout(2000);
  /* Deterministic rather than a race: put the board into each of its three
     empty states and read what it says. They must not look alike. */
  const says = await v.page.evaluate(() => {
    const l = document.querySelector("#list"), out = {};
    state.stops = [];
    bootFail = null; bootDone = false; renderList();
    out.waiting = { txt: l.innerText.trim(), skel: l.querySelectorAll(".skel").length };
    bootDone = true; renderList();
    out.empty = { txt: l.innerText.trim(), skel: l.querySelectorAll(".skel").length };
    bootFail = "The server answered with an error (503)."; renderList();
    out.failed = { txt: l.innerText.trim(), btn: l.querySelectorAll("button").length };
    return out;
  });
  ok("waiting shows placeholders, not a claim about the street",
    says.waiting.skel > 0 && !/No arrivals/i.test(says.waiting.txt),
    `${says.waiting.skel} placeholders`);
  ok("...an answered-but-empty street says so plainly",
    /No arrivals/i.test(says.empty.txt) && says.empty.skel === 0, says.empty.txt);
  ok("...and a failure names itself, with a way out",
    /503/.test(says.failed.txt) && says.failed.btn === 1, says.failed.txt);
  /* The bug in the fix: the error used to be written straight into the
     list, so the next repaint — a GPS fix, a refresh tick — put the
     loading animation back over it and the app said "loading" forever. */
  const survives = await v.page.evaluate(() => {
    renderView(); renderView();
    return /503/.test(document.querySelector("#list").innerText);
  });
  ok("...which a later repaint cannot quietly paint over", survives,
    "this is exactly how v64 turned a visible failure into an invisible one");
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

/* The morning it actually happened. /health fine, /nearby fine, and OASA
   itself timing out behind them — so the sweep came back with an empty
   list and a 200, and the board announced "no arrivals in the next few
   minutes": a confident claim about the street, made on no information. */
console.log("\n— when OASA is the thing that is down —");
{
  oasaDown = true;
  const v = await open({ geo: true });
  await v.page.waitForTimeout(2600);
  const txt = await v.page.evaluate(() =>
    (document.querySelector("#list") || {}).innerText || "");
  ok("the board says OASA is not answering", /OASA is not responding/i.test(txt),
    txt.replace(/\n/g, " ").slice(0, 70));
  ok("...and does not blame the rider's connection",
    !/your connection/i.test(txt.replace(/Nothing wrong with your connection[^.]*\./i, "")),
    "it says the opposite, on purpose");
  ok("...and never claims the street is empty", !/No arrivals/i.test(txt));
  ok("...offering a way to try again", await v.page.evaluate(() =>
    document.querySelectorAll("#list .msg button").length === 1));
  /* One retry, not the full ladder — the Worker already told us. */
  ok("...without sitting on placeholders for five seconds first",
    await v.page.evaluate(() => bootFail !== null),
    "a definite answer is not a blip to wait out");
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
  oasaDown = false;
}

/* A board from four minutes ago beats an error. The stops have not moved
   and the lines have not changed; only the minutes are old, and the app
   already knows how to say so. */
console.log("\n— the last good board, honestly dated —");
{
  oasaStale = true;
  const v = await open({ geo: true });
  await v.page.waitForTimeout(2500);
  const st = await v.page.evaluate(() => ({
    rows: document.querySelectorAll("#list .stop:not(.skel-card)").length,
    fresh: (document.getElementById("fresh") || {}).textContent || "",
    red: (document.getElementById("fresh") || {}).classList
      ? document.getElementById("fresh").classList.contains("stale") : false,
    fail: bootFail,
  }));
  ok("the stops are still on screen", st.rows > 0, `${st.rows} rows`);
  ok("...instead of an error", st.fail === null);
  /* The age comes from when the sweep was generated, not from when we
     received it — otherwise a four-minute-old board would claim to be
     seconds fresh, which is the one lie that matters here. */
  const mins = Number((st.fresh.match(/(\d+)\s*m/) || [])[1] || 0);
  ok("...dated from when it was true, not when it arrived", mins >= 3,
    `"${st.fresh}" — dating it from arrival would have read "just now"`);
  ok("...and flagged as stale, in red", st.red, `"${st.fresh}"`);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
  oasaStale = false;
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
