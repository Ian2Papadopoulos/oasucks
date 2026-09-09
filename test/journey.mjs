/* The journey planner as a rider meets it: pick two ends, read the options,
   open one. The Worker's answer is stubbed — the routing itself has its own
   suite in plan.mjs — so this is about what the screen says, and especially
   about whether it is honest regarding where each number came from. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_FLAG } from "./_tour.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const NOW = Math.floor(Date.now() / 1000);
const P = (lat, lng) => [lat, lng];

const stops = [{ code: "9001", name_el: "ΠΛΑΤΕΙΑ", name_en: "SQUARE", lat: 37.976, lng: 23.73,
  dist: 60, detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V1", min: 5 }] }];

let planCalls = [];
/* One itinerary using all four modes and all three bases, which is the
   combination the disclosures have to get right. */
let planBody = {
  departAt: Date.now(), service: { metro: true, bus: true }, subrequests: 18,
  walkRouting: false,
  itineraries: [
    { kind: "best", totalMin: 52, changes: 2, vehicles: 3, basis: "mixed", legs: [
      { mode: "walk", min: 5, metres: 380, basis: "estimated",
        to: { el: "ΠΛΑΤΕΙΑ", en: "SQUARE" }, path: [P(37.9700, 23.7250), P(37.9760, 23.7300)] },
      { mode: "bus", line: "608", routeCode: "r1", headsign: { el: "ΚΕΝΤΡΟ", en: "CENTRE" },
        wait: 4, rideMin: 11, min: 15, stops: 6, basis: "live",
        from: { el: "ΠΛΑΤΕΙΑ", en: "SQUARE" }, to: { el: "ΟΜΟΝΟΙΑ", en: "OMONIA" },
        path: [P(37.9760, 23.7300), P(37.9843, 23.7281)] },
      { mode: "walk", min: 2, metres: 140, basis: "estimated",
        to: { el: "Ομόνοια", en: "Omonia" }, path: [P(37.9843, 23.7281), P(37.9845, 23.7285)] },
      { mode: "metro", line: "2", wait: 4, rideMin: 6, min: 10, stops: 3, basis: "estimated",
        from: { el: "Ομόνοια", en: "Omonia" }, to: { el: "Σύνταγμα", en: "Syntagma" },
        path: [P(37.9845, 23.7285), P(37.9755, 23.7353)] },
      { mode: "tram", line: "6", headsign: { el: "ΒΟΥΛΑ", en: "VOULA" },
        wait: 18, rideMin: 0, min: 18, stops: 4, basis: "timetable",
        from: { el: "Σύνταγμα", en: "Syntagma" }, to: { el: "ΦΙΞ", en: "FIX" },
        path: [P(37.9755, 23.7353), P(37.9642, 23.7265)] },
      { mode: "walk", min: 2, metres: 150, basis: "estimated", to: null,
        path: [P(37.9642, 23.7265), P(37.9630, 23.7250)] },
    ] },
    { kind: "fewer", totalMin: 61, changes: 0, vehicles: 1, basis: "live", legs: [
      { mode: "walk", min: 7, metres: 520, basis: "routed",
        to: { el: "ΠΛΑΤΕΙΑ", en: "SQUARE" }, path: [P(37.9700, 23.7250), P(37.9760, 23.7300)] },
      { mode: "trolley", line: "11", routeCode: "r2", headsign: { el: "ΠΑΓΚΡΑΤΙ", en: "PAGRATI" },
        wait: 6, rideMin: 42, min: 48, stops: 19, basis: "live",
        from: { el: "ΠΛΑΤΕΙΑ", en: "SQUARE" }, to: { el: "ΤΕΡΜΑ", en: "TERMA" },
        path: [P(37.9760, 23.7300), P(37.9630, 23.7250)] },
      { mode: "walk", min: 6, metres: 430, basis: "routed", to: null,
        path: [P(37.9630, 23.7250), P(37.9620, 23.7240)] },
    ] },
  ],
};

const json = (r, o) => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/plan") { planCalls.push(u.search); return json(res, planBody); }
  if (u.pathname === "/nearby") return json(res, { origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] });
  if (u.pathname === "/metro") return json(res, [
    { id: "m-syntagma", name: "Σύνταγμα", name_en: "Syntagma", lines: ["2", "3"], lat: 37.9755, lng: 23.7353 }]);
  if (u.pathname === "/geocode") return json(res, [
    { lat: "37.9500", lon: "23.7100", address: { road: "Λεωφόρος Συγγρού", suburb: "Νέος Κόσμος" } }]);
  if (u.pathname === "/api" || u.pathname === "/reports") return json(res, []);
  const f = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    res.writeHead(200, { "Content-Type": e === ".css" ? "text/css" : e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  res.writeHead(404); res.end("{}");
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true,
  isMobile: true, permissions: ["geolocation"],
  geolocation: { latitude: 37.970, longitude: 23.725, accuracy: 20 } });
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=", "base64");
await ctx.route("**://*.cartocdn.com/**", r => r.fulfill({ contentType: "image/png", body: PIXEL }));
await ctx.route("**://tile.openstreetmap.org/**", r => r.fulfill({ contentType: "image/png", body: PIXEL }));
const page = await ctx.newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e)));
await page.addInitScript(tf => { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf);
  localStorage.setItem("subId", "jp-0001"); }, TOUR_FLAG);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1400);

console.log("\n— getting to it —");
await page.click("#menubtn"); await page.waitForTimeout(250);
/* Journey moved out of the ☰ menu and into the header, next to reports,
   alerts and the hamburger, because two taps behind a hamburger is where a
   feature goes to be undiscovered. */
ok("the journey is a top-level control, not a menu entry",
   await page.locator("#planbtn").isVisible()
   && await page.evaluate(() => !document.getElementById("m-plan")));
ok("...and it is the first of the header buttons, before reports",
   await page.evaluate(() => {
     const b = [...document.querySelectorAll(".brand .iconbtn")].map(x => x.id);
     return b[0] === "planbtn" && b.indexOf("reportbtn") === 1;
   }));
await page.click("#planbtn"); await page.waitForTimeout(400);
ok("the panel opens", await page.locator("#jp").evaluate(e => e.classList.contains("on")));
ok("it starts from where you are",
   /my location/i.test(await page.locator("#jp-from-t").innerText()),
   await page.locator("#jp-from-t").innerText());
ok("...and will not plan until it has both ends", await page.locator("#jp-go").isDisabled());

console.log("\n— picking the other end —");
await page.click("#jp-to"); await page.waitForTimeout(400);
await page.fill("#jpp-q", "Syn"); await page.waitForTimeout(600);
ok("metro stations match with no request at all",
   (await page.locator("#jpp-res .res").allInnerTexts()).some(x => /Syntagma/i.test(x)),
   (await page.locator("#jpp-res .res").allInnerTexts()).join(" | "));
await page.fill("#jpp-q", "Syngrou avenue"); await page.waitForTimeout(1200);
await page.locator("#jpp-res .res").filter({ hasText: /Συγγρού|Syngrou/ }).first().click();
await page.waitForTimeout(400);
ok("choosing one fills the field and closes the picker",
   /Συγγρού|Syngrou/i.test(await page.locator("#jp-to-t").innerText()) &&
   !(await page.evaluate(() => document.querySelector("#jppick").classList.contains("on"))));

console.log("\n— the options —");
planCalls = [];
await page.click("#jp-go"); await page.waitForTimeout(1200);
ok("it asked the Worker once, with both ends", planCalls.length === 1 &&
   /from=[\d.]+,[\d.]+/.test(planCalls[0]) && /to=[\d.]+,[\d.]+/.test(planCalls[0]), planCalls[0]);
const cards = page.locator("#jp-out .itin");
ok("both itineraries are shown", (await cards.count()) === 2, `${await cards.count()}`);
ok("the fastest leads", /52/.test(await cards.nth(0).innerText()));
ok("...and says how many changes", /2 changes/i.test(await cards.nth(0).innerText()));
ok("the panel carries the caveat once, not per row",
   (await page.locator("#jp-out .jp-note").count()) === 1);

console.log("\n— every mode gets its own chip —");
{
  const c = cards.nth(0);
  ok("a metro chip", (await c.locator(".hop.metro").count()) === 1);
  ok("a tram chip", (await c.locator(".hop.tram").count()) === 1);
  ok("a bus chip", (await c.locator(".hop.bus").count()) === 1);
  ok("...and walking chips between them", (await c.locator(".hop.walk").count()) === 3);
  ok("the trolley on the other option is its own kind too",
     (await cards.nth(1).locator(".hop.trolley").count()) === 1);
  ok("no ride is left unlabelled",
     (await page.locator("#jp-out .hop:not(.walk):not(.bus):not(.tram):not(.trolley):not(.metro)").count()) === 0);
}

console.log("\n— it says where each number came from —");
await cards.nth(0).click();
await page.waitForTimeout(900);
ok("the detail view opens", await page.locator("#jpr").evaluate(e => e.classList.contains("on")));
const steps = (await page.locator("#jpr-strip .jp-step").allInnerTexts()).join(" || ");
ok("every leg is written out", (await page.locator("#jpr-strip .jp-step").count()) === 6,
   String(await page.locator("#jpr-strip .jp-step").count()));
ok("a live boarding says live", /Live arrivals/i.test(steps));
ok("a timetabled one says it came from the timetable", /From the timetable/i.test(steps), steps.slice(0, 200));
ok("...and the metro says estimated", /Estimated/i.test(steps));
ok("rides name their mode, not just a number",
   /Bus/.test(steps) && /Tram/.test(steps) && /Metro/.test(steps), steps.slice(0, 300));
{
  const notes = await page.locator("#jpr-strip .jp-note").allInnerTexts();
  ok("three caveats, one per thing actually guessed at", notes.length === 3, `${notes.length}`);
  ok("...the timetable one names the reason", /no vehicle has been dispatched/i.test(notes.join(" ")));
  ok("...the metro one says the feed carries no trains", /carries no trains/i.test(notes.join(" ")));
  ok("...and walking is admitted as estimated", /Walking times are estimated/i.test(notes.join(" ")),
     notes.join(" | ").slice(0, 200));
}
await page.screenshot({ path: process.env.SHOT || "/tmp/jp-detail.png" }).catch(() => {});

console.log("\n— and it is drawn —");
{
  const drawn = await page.evaluate(() => {
    const o = { dashed: 0, solid: 0, markers: 0 };
    jp.layer.eachLayer(l => {
      if (l.getLatLngs) { l.options.dashArray ? o.dashed++ : o.solid++; } else o.markers++;
    });
    return o;
  });
  ok("walking legs are drawn dashed", drawn.dashed === 3, JSON.stringify(drawn));
  ok("riding legs are drawn solid", drawn.solid >= 6, JSON.stringify(drawn));
  ok("the ends are marked", drawn.markers >= 2, JSON.stringify(drawn));
  ok("the map fits the whole journey", await page.evaluate(() => {
    const b = jp.map.getBounds();
    return b.contains([37.9700, 23.7250]) && b.contains([37.9630, 23.7250]);
  }));
}

console.log("\n— a fully routed, fully live option claims less —");
await page.click("#jpr-x"); await page.waitForTimeout(300);
await cards.nth(1).click(); await page.waitForTimeout(800);
{
  const notes = await page.locator("#jpr-strip .jp-note").allInnerTexts();
  ok("no caveats when nothing was guessed", notes.length === 0, notes.join(" | "));
  ok("...and it says so up front", /live/i.test(await page.locator("#jpr-sub").innerText()),
     await page.locator("#jpr-sub").innerText());
}
await page.click("#jpr-x"); await page.waitForTimeout(300);

console.log("\n— when there is nothing to offer —");
planBody = { itineraries: [], reason: "closed", service: { metro: false, bus: false } };
await page.click("#jp-go"); await page.waitForTimeout(900);
ok("a closed network says so, not 'no route'",
   /not running|neither/i.test(await page.locator("#jp-out").innerText()),
   await page.locator("#jp-out").innerText());
planBody = { itineraries: [], reason: "noroute", service: { metro: true, bus: true } };
await page.click("#jp-go"); await page.waitForTimeout(900);
ok("...and a genuine miss says that instead",
   /no route/i.test(await page.locator("#jp-out").innerText()),
   await page.locator("#jp-out").innerText());

console.log("\n— Greek —");
await page.click("#jp-x"); await page.waitForTimeout(300);
await page.evaluate(() => switchLang());
await page.waitForTimeout(500);
ok("the control is labelled in Greek for a screen reader",
   /Διαδρομή/.test(await page.locator("#planbtn").getAttribute("aria-label") || ""),
   await page.locator("#planbtn").getAttribute("aria-label"));
await page.click("#planbtn"); await page.waitForTimeout(400);
// uppercase Greek drops its accents, so match either form
ok("...and the button", /Εύρεση|ΕΥΡΕΣΗ/.test(await page.locator("#jp-go").innerText()),
   await page.locator("#jp-go").innerText());

ok("no page errors", errs.length === 0, errs.join(" | "));
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
