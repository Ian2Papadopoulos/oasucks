/* CARTO started requiring a key in August 2026 and stamps every tile with
   "API KEY REQUIRED" without one. This checks both paths: a key set, and
   no key at all. Tile hosts are stubbed, so nothing leaves the machine. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { TOUR_FLAG } from "./_tour.mjs";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const NOW = Math.floor(Date.now() / 1000);
const LAT = 37.9760, LNG = 23.7300;

/* Build a copy of public/ with TILE_KEY forced to whatever this run wants,
   so the real file is never edited and a key already set in it cannot make
   the keyless case silently pass. */
function withKey(key) {
  const dir = mkdtempSync(path.join(tmpdir(), "tiles-"));
  cpSync(SRC, dir, { recursive: true });
  const f = path.join(dir, "index.html");
  const src = readFileSync(f, "utf8");
  const pat = /const TILE_KEY\s*=\s*"[^"]*";/;
  if (!pat.test(src)) throw new Error("TILE_KEY declaration not found in index.html");
  writeFileSync(f, src.replace(pat, `const TILE_KEY=${JSON.stringify(key)};`));
  return dir;
}

const stops = [{ code: "500", name_el: "ΚΟΝΤΑ", name_en: "NEAR", lat: LAT, lng: LNG, dist: 40,
  detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V1", min: 4 }] }];

let ROOT = SRC;
const json = (r, o) => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // the mode probe: is there a Worker on this origin
  if (u.pathname === "/health") return json(res, { ok: true, version: "test" });
  if (u.pathname === "/nearby") return json(res, { origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] });
  if (u.pathname === "/api" || u.pathname === "/reports" || u.pathname === "/metro") return json(res, []);
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

async function run(key) {
  ROOT = withKey(key === null ? "" : key);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true,
    isMobile: true, permissions: ["geolocation"],
    geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  const tiles = [];
  // never actually reach a tile CDN: record the URL and answer with a pixel
  const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=", "base64");
  await ctx.route("**://*.cartocdn.com/**", r => { tiles.push(r.request().url()); r.fulfill({ contentType: "image/png", body: PIXEL }); });
  await ctx.route("**://tile.openstreetmap.org/**", r => { tiles.push(r.request().url()); r.fulfill({ contentType: "image/png", body: PIXEL }); });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", e => errs.push(String(e)));
  await page.addInitScript(tf => { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf);
    localStorage.setItem("subId", "tile-1"); localStorage.setItem("dark", "0"); }, TOUR_FLAG);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => setView("map"));
  await page.waitForTimeout(1400);
  return { ctx, page, tiles, errs };
}

console.log("\n— with a key —");
{
  const { ctx, page, tiles, errs } = await run("abc123KEY");
  ok("tiles come from CARTO", tiles.length > 0 && tiles.every(u => /cartocdn/.test(u)),
     `${tiles.length} tiles, e.g. ${tiles[0]}`);
  ok("...every one carrying the key", tiles.every(u => /[?&]key=abc123KEY/.test(u)), tiles[0]);
  ok("...the light style while light", tiles.some(u => /light_all/.test(u)), tiles[0]);
  ok("...and no OSM tiles were touched", !tiles.some(u => /openstreetmap\.org/.test(u)));
  ok("attribution credits CARTO",
     /CARTO/.test(await page.locator(".leaflet-control-attribution").first().innerText()),
     await page.locator(".leaflet-control-attribution").first().innerText());
  ok("no desaturating filter is applied",
     (await page.locator("#map .leaflet-tile-container.tiles-plain, #map .tiles-plain").count()) === 0);
  const before = tiles.length;
  await page.click("#basemap"); await page.waitForTimeout(1200);
  const dark = tiles.slice(before);
  ok("the toggle switches to CARTO's dark style",
     dark.length > 0 && dark.every(u => /dark_all/.test(u)), dark[0] || "no tiles");
  ok("...still with the key", dark.every(u => /[?&]key=abc123KEY/.test(u)), dark[0] || "");
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

console.log("\n— with no key, nothing is watermarked —");
{
  const { ctx, page, tiles, errs } = await run(null);
  ok("CARTO is not called at all", !tiles.some(u => /cartocdn/.test(u)),
     tiles.filter(u => /cartocdn/.test(u))[0] || "none");
  ok("...tiles come from OpenStreetMap instead", tiles.length > 0 && tiles.every(u => /tile\.openstreetmap\.org/.test(u)),
     `${tiles.length} tiles, e.g. ${tiles[0]}`);
  ok("...with no key parameter to leak", !tiles.some(u => /key=/.test(u)));
  ok("...and no @2x request OSM would not serve", !tiles.some(u => /@2x/.test(u)),
     tiles.find(u => /@2x/.test(u)) || "");
  ok("attribution credits OpenStreetMap, not CARTO", await page.evaluate(() => {
    const t = document.querySelector(".leaflet-control-attribution").innerText;
    return /OpenStreetMap/.test(t) && !/CARTO/.test(t);
  }), await page.locator(".leaflet-control-attribution").first().innerText());
  ok("the tiles are desaturated to match the app",
     (await page.locator("#map .tiles-plain").count()) >= 1);
  ok("...and it is a real filter, not just a class",
     await page.evaluate(() => {
       const el = document.querySelector("#map .tiles-plain");
       return /grayscale/.test(getComputedStyle(el).filter);
     }), await page.evaluate(() => {
       const el = document.querySelector("#map .tiles-plain");
       return el ? getComputedStyle(el).filter : "no element";
     }));
  ok("dark mode inverts them instead of asking OSM for a dark style", await (async () => {
    await page.click("#basemap"); await page.waitForTimeout(900);
    return page.evaluate(() => {
      const el = document.querySelector("#map .tiles-plain");
      return document.body.classList.contains("tiles-dark") &&
             /invert/.test(getComputedStyle(el).filter);
    });
  })(), await page.evaluate(() => {
    const el = document.querySelector("#map .tiles-plain");
    return el ? getComputedStyle(el).filter : "no element";
  }));
  ok("...and still no CARTO request after the toggle", !tiles.some(u => /cartocdn/.test(u)));
  ok("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* addTiles() replaced four separate tile-layer constructions, so every map
   in the app has to be opened, not just the main one. */
console.log("\n— the app's other maps —");
{
  const { ctx, page, tiles, errs } = await run("abc123KEY");
  const hosts = () => new Set(tiles.map(u => new URL(u).host.replace(/^[a-d]\./, "")));

  await page.evaluate(() => setView("list"));
  await page.waitForTimeout(400);
  const beforePrev = tiles.length;
  await page.evaluate(() => {
    const s = state.stops[0];
    openRoutePreview(s, String(s.arrivals[0].code), s.arrivals[0].min);
  });
  await page.waitForTimeout(1500);
  ok("the route preview draws tiles", tiles.length > beforePrev,
     `${tiles.length - beforePrev} tiles`);
  ok("...from CARTO, with the key",
     tiles.slice(beforePrev).every(u => /cartocdn/.test(u) && /key=abc123KEY/.test(u)),
     tiles[beforePrev]);
  await page.evaluate(() => closeRP());
  await page.waitForTimeout(300);

  const beforeRep = tiles.length;
  await page.click("#reportbtn");
  await page.waitForTimeout(1800);
  ok("the live-reports map draws tiles", tiles.length > beforeRep,
     `${tiles.length - beforeRep} tiles`);
  ok("...also keyed", tiles.slice(beforeRep).every(u => /key=abc123KEY/.test(u)),
     tiles[beforeRep] || "none");

  ok("no map anywhere fell back to OSM while a key was set",
     ![...hosts()].includes("tile.openstreetmap.org"), [...hosts()].join(", "));
  ok("no page errors across all three maps", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

console.log("\n— a key pasted the way people actually paste it —");
{
  for (const form of ["?key=XYZ", "key=XYZ", "  XYZ  "]) {
    const { ctx, tiles } = await run(form);
    ok(`"${form}" is understood`, tiles.length > 0 && tiles.every(u => /[?&]key=XYZ(&|$)/.test(u)),
       tiles[0] || "no tiles");
    await ctx.close();
  }
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
