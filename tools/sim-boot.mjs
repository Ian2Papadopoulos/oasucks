/* The first ten seconds of a cold start, in a real browser, with a real
 * geolocation delay and every request timestamped.
 *
 *     CHROME_PATH=/path/to/chromium node tools/sim-boot.mjs
 *     GPS_DELAY_MS=8000 LASTPOS_AGE_MIN=240 node tools/sim-boot.mjs
 *
 * Why this exists: "it opens on Syntagma and takes a couple of refreshes
 * to find me" is a claim about a three-second window, and no amount of
 * reading the source settles it. This prints what actually happens —
 * which request went out, with which coordinates, and what the board said
 * at each half second. It found three separate bugs the first time it ran.
 *
 * GPS_DELAY_MS    how long the radio takes to answer (default 3000)
 * LASTPOS_AGE_MIN age of the remembered fix, in minutes (default: none)
 */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const PUB = new URL("../public", import.meta.url).pathname;
const REAL = { lat: 38.0121, lng: 23.7550 };          // Ν. Ψυχικό, far from Syntagma
const SYNTAGMA = { lat: 37.9755, lng: 23.7348 };
const GPS_DELAY_MS = Number(process.env.GPS_DELAY_MS || 3000);
const LASTPOS_AGE_MIN = process.env.LASTPOS_AGE_MIN;   // unset = none stored

const hits = [];
const t0 = Date.now();
const mark = (what) => hits.push({ ms: Date.now() - t0, what });

const stopsAt = (lat, lng, label) => Array.from({ length: 11 }, (_, i) => ({
  code: `${label}${i}`, name_el: `${label} ${i}`, name_en: `${label} ${i}`,
  lat: lat + i * 0.0004, lng, dist: 40 + i * 30, detail: true,
  lines: [{ id: "022", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "022", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V" + i, min: 3 + i }],
}));

const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  const J = o => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  if (u.pathname === "/nearby") {
    const lat = +u.searchParams.get("lat"), lng = +u.searchParams.get("lng");
    const near = Math.abs(lat - REAL.lat) < 0.01;
    mark(`/nearby  lat=${lat.toFixed(4)}  → ${near ? "REAL LOCATION" : "SYNTAGMA FALLBACK"}`);
    return J({ origin: { lat, lng }, radius: 600, generated: Math.floor(Date.now() / 1000),
      hidden: 0, stops: stopsAt(lat, lng, near ? "PSYCHIKO" : "SYNTAGMA"), reports: [],
      upstream: { ok: true } });
  }
  if (u.pathname === "/health") return J({ ok: true, version: "sim" });
  if (u.pathname === "/pulse") { r.writeHead(200); return r.end("{}"); }
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    r.writeHead(200, { "Content-Type": e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return r.end(readFileSync(f));
  }
  J([]);
});
await new Promise(r => srv.listen(0, r));
const PORT = srv.address().port;

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
/* No position at all until the delay — a cold radio, which is what the
   first launch of the morning actually is. Playwright answers
   getCurrentPosition with POSITION_UNAVAILABLE while none is set. */
const ctx = await b.newContext({ viewport: { width: 390, height: 840 },
  permissions: ["geolocation"] });
await ctx.addInitScript(([age]) => {
  try {
    localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", "3");
    if (age) localStorage.setItem("lastPos",
      JSON.stringify({ lat: 38.0121, lng: 23.7550, ts: Date.now() - age * 60000 }));
  } catch (_) {}
}, [LASTPOS_AGE_MIN ? Number(LASTPOS_AGE_MIN) : 0]);

const page = await ctx.newPage();
page.on("pageerror", e => mark("PAGE ERROR: " + e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

// GPS arrives after a delay, as a cold radio does
setTimeout(() => ctx.setGeolocation({ latitude: REAL.lat, longitude: REAL.lng, accuracy: 12 })
  .then(() => mark("GPS fix available")), GPS_DELAY_MS);

for (let i = 0; i <= 20; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    where: (document.getElementById("locwhere") || {}).textContent,
    first: (document.querySelector("#list .stop .stop-hd") || {}).textContent || "",
    cards: document.querySelectorAll("#list .stop").length,
    skel: document.querySelectorAll("#list .skel").length,
  }));
  hits.push({ ms: Date.now() - t0, what: `   board: "${(s.first || "").trim().slice(0, 22)}" · ${s.cards} cards, ${s.skel} skeleton rows · header "${s.where}"` });
}

console.log(`\n=== cold start, GPS ${GPS_DELAY_MS}ms, lastPos ${LASTPOS_AGE_MIN ? LASTPOS_AGE_MIN + "min old" : "none"} ===\n`);
let prev = "";
for (const h of hits) {
  if (h.what.startsWith("   board")) { if (h.what === prev) continue; prev = h.what; }
  console.log(`${String(h.ms).padStart(6)}ms  ${h.what}`);
}
await b.close(); srv.close();
