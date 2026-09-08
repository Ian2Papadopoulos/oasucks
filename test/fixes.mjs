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
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const J = o => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/nearby") return J({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] });
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
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function open({ geo = true } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 800 },
    permissions: geo ? ["geolocation"] : [],
    geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(() => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", "1"); } catch (_) {}
  });
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

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
