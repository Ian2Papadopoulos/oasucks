/* The journey planner's routing engine, run against a synthetic network so
   every number in the answer can be checked by hand. worker.js is loaded
   into a vm with its two fetchers swapped for fixtures, so a run touches no
   network and no OASA quota.

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

/* ------------------------------ the network ------------------------------
   Far enough north of Kifissia that no real metro station is within walking
   distance, or the bus cases quietly become bus+metro — correct behaviour,
   but not what they are testing. */
const LAT0 = 38.1400, LNG0 = 23.8600, STEP = 0.0036;   // ~400 m
const avenue = n => Array.from({ length: n }, (_, i) => ({
  StopCode: `A${i}`, StopDescr: `ΟΔΟΣ ${i}`, StopDescrEng: `AVENUE ${i}`,
  StopLat: LAT0 + i * STEP, StopLng: LNG0 }));
const express = n => Array.from({ length: n }, (_, i) => ({
  StopCode: `B${i}`, StopDescr: `ΤΑΧΕΙΑ ${i}`, StopDescrEng: `EXPRESS ${i}`,
  StopLat: LAT0 + i * 2 * STEP, StopLng: LNG0 + 0.0102 }));
// a cross-street meeting the avenue at its 6th stop, 80 m off it: close
// enough to walk, far enough to be a real interchange
const cross = n => Array.from({ length: n }, (_, i) => ({
  StopCode: `C${i}`, StopDescr: `ΕΓΚΑΡΣΙΑ ${i}`, StopDescrEng: `CROSS ${i}`,
  StopLat: LAT0 + 6 * STEP + 0.0007, StopLng: LNG0 + i * 0.0046 }));
const A = avenue(12), B = express(6), C = cross(7);
const allStops = [...A, ...B, ...C];

const ROUTES_AT = {};
A.forEach(s => { ROUTES_AT[s.StopCode] = [{ code: "R-A", id: "608", el: "ΒΟΡΡΑΣ", en: "NORTH" }]; });
B.forEach(s => { ROUTES_AT[s.StopCode] = [{ code: "R-B", id: "X95", el: "ΤΑΧΕΙΑ", en: "EXPRESS" }]; });
C.forEach(s => { ROUTES_AT[s.StopCode] = [{ code: "R-C", id: "021", el: "ΑΝΑΤΟΛΗ", en: "EAST" }]; });

let ARRIVALS = {};
let calls = [];

const hav = (a1, o1, a2, o2) => {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dA = r(a2 - a1), dO = r(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const src = readFileSync(path.join(REPO, "worker.js"), "utf8")
  .replace(/^export default/m, "const __handler =");
const ctx = {
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, Request, Response, Headers,
  TextEncoder, TextDecoder, btoa, atob, WeakMap, Symbol, Error, TypeError, RegExp,
  Uint8Array, ArrayBuffer, DataView, encodeURIComponent, decodeURIComponent,
  AbortController: class { constructor() { this.signal = null; } abort() {} },
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: { default: { async match() {}, async put() {} } },
  // the walk router is a plain fetch, unlike the OASA calls; tests set
  // __walkReply to stand in for OpenRouteService
  fetch: async () => { throw new Error("no network in the harness"); },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
ctx.__fx = {
  closest: (la, ln) => allStops.map(s => ({ s, d: hav(la, ln, s.StopLat, s.StopLng) }))
    .sort((x, y) => x.d - y.d).slice(0, 8).map(x => x.s),
  routeStops: c => ({ "R-A": A, "R-B": B, "R-C": C })[c] || null,
  arrivals: c => (ARRIVALS[c] || []).map(x => ({ route_code: x.route, btime2: String(x.min) })),
  stopRoutes: c => ROUTES_AT[c] ? { routes: ROUTES_AT[c], lines: ROUTES_AT[c] } : null,
};
ctx.__log = m => calls.push(m);
ctx.__walkReply = null;
vm.runInContext(`
  fetch = async (url, opts) => {
    __log("walkRouter");
    if (!__walkReply) throw new Error("router down");
    return { ok: true, json: async () => __walkReply };
  };
`, ctx);
vm.runInContext(`
  getJSON = async (u) => {
    const q = new URL(u).searchParams, act = q.get("act");
    __log(act + ":" + (q.get("p1") || ""));
    if (act === "getClosestStops") return __fx.closest(+q.get("p1"), +q.get("p2"));
    if (act === "webGetStops") return __fx.routeStops(q.get("p1"));
    if (act === "getStopArrivals") return __fx.arrivals(q.get("p1"));
    return [];
  };
  fetchStopRoutes = async (code) => { __log("webRoutesForStop:" + code); return __fx.stopRoutes(code); };
`, ctx);

const plan = (from, to, whenIso) => {
  calls = [];
  return vm.runInContext(
    `planJourney(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${new Date(whenIso).getTime()})`, ctx);
};
const legTypes = p => p.legs.map(l => l.mode).join(">");
const ride = p => p.legs.find(l => l.mode !== "walk");

/* Athens is UTC+3 in August, so 09:00 local is 06:00Z. The planner reads
   the clock in Europe/Athens itself. */
const WED_0900 = "2026-08-12T06:00:00Z";
const WED_0300 = "2026-08-12T00:00:00Z";
const SUN_1200 = "2026-08-16T09:00:00Z";

console.log("\n— the metro graph agrees with itself —");
{
  const lens = vm.runInContext(`Object.entries(METRO_LINES).map(([k,v])=>k+"="+v.length).join(" ")`, ctx);
  ok("three lines, the right lengths", lens === "1=24 2=20 3=27", lens);
  ok("every id in a sequence is a station we know",
     vm.runInContext(`(()=>{const ids=new Set(METRO_STATIONS.map(s=>s.id));
       return Object.values(METRO_LINES).flat().filter(x=>!ids.has(x)).length===0;})()`, ctx));
  ok("every station sits on a line",
     vm.runInContext(`(()=>{const on=new Set(Object.values(METRO_LINES).flat());
       return METRO_STATIONS.filter(s=>!on.has(s.id)).length===0;})()`, ctx));
  ok("...and each one's declared lines match the sequences",
     vm.runInContext(`(()=>{for(const s of METRO_STATIONS){
       const real=Object.keys(METRO_LINES).filter(L=>METRO_LINES[L].includes(s.id)).sort().join();
       if(real!==[...s.lines].sort().join()) return false;} return true;})()`, ctx));
}

console.log("\n— it walks when walking is the answer —");
{
  const best = (await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + STEP, lng: LNG0 }, WED_0900)).itineraries[0];
  ok("a 400 m hop is one walking leg", legTypes(best) === "walk", legTypes(best));
  ok("...and nothing was guessed, so it reads live", best.basis === "live", best.basis);
}

console.log("\n— it rides when riding is faster —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  const best = (await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900)).itineraries[0];
  ok("a 3.6 km trip uses the bus", /bus/.test(legTypes(best)), legTypes(best));
  const r = ride(best);
  ok("...the route that serves that street", r && r.line === "608", r && r.line);
  ok("...boarding at the near end", r && /AVENUE 0|ΟΔΟΣ 0/.test(r.from.el + r.from.en), JSON.stringify(r && r.from));
  ok("...alighting at the far end", r && /AVENUE 9|ΟΔΟΣ 9/.test(r.to.el + r.to.en), JSON.stringify(r && r.to));
  ok("...for nine stops", r && r.stops === 9, String(r && r.stops));
}

console.log("\n— a live ETA is used, and named as one —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 4 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 - 0.0002 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  const r = ride(p.itineraries[0]);
  ok("the first boarding is live", r && r.basis === "live", r && r.basis);
  ok("...waiting what the ETA said, less the walk to the stop",
     r && Math.abs(r.wait - (4 - p.itineraries[0].legs[0].min)) < 0.6,
     r && `wait ${r.wait}, walk ${p.itineraries[0].legs[0].min}`);
}

console.log("\n— past the horizon it falls back, and says so —");
{
  ARRIVALS = {};
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  const r = ride(p.itineraries[0]);
  ok("the boarding is not called live", r && r.basis !== "live", r && r.basis);
  ok("...and the itinerary is flagged", p.itineraries[0].basis !== "live", p.itineraries[0].basis);
  ARRIVALS = { A0: [{ route: "R-A", min: 240 }] };   // four hours out
  const q = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  ok("an ETA beyond the horizon is not treated as live", ride(q.itineraries[0]).basis !== "live",
     ride(q.itineraries[0]).basis);
}

console.log("\n— the metro —");
{
  const p = await plan({ lat: 37.9481, lng: 23.6430 }, { lat: 37.9364, lng: 23.9445 }, WED_0900);
  const best = p.itineraries[0], m = best.legs.find(l => l.mode === "metro");
  ok("Piraeus to the airport finds a train", !!m, legTypes(best));
  ok("...on line 3", m && m.line === "3", m && m.line);
  ok("...running most of it", m && m.stops >= 20, String(m && m.stops));
  ok("...ending at the airport", m && /Airport|Αεροδρόμιο/.test(m.to.el + m.to.en), JSON.stringify(m && m.to));
  ok("crossing onto the airport branch costs its own, longer headway",
     m && m.branchWait > 12, `branch wait ${m && m.branchWait}`);
  ok("metro timings are declared estimates", /estimated|mixed/.test(best.basis), best.basis);
}

console.log("\n— nothing runs at three in the morning —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  const p = await plan({ lat: 37.9481, lng: 23.6430 }, { lat: 37.9364, lng: 23.9445 }, WED_0300);
  ok("no train is offered", !p.itineraries.some(i => /metro/.test(legTypes(i))),
     p.itineraries.map(legTypes).join(" | "));
  ok("...and the answer says why, rather than 'no route'",
     p.service && p.service.metro === false && p.service.bus === false,
     JSON.stringify({ service: p.service, reason: p.reason }));
}

console.log("\n— time of day changes the answer —");
{
  ARRIVALS = {};
  const rideMin = p => (p.legs.find(l => l.mode === "bus") || {}).rideMin;
  const peak = (await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900)).itineraries[0];
  const sun = (await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, SUN_1200)).itineraries[0];
  ok("the same ride is slower in weekday traffic than on a Sunday",
     rideMin(peak) > rideMin(sun),
     `peak ${rideMin(peak).toFixed(1)} vs Sunday ${rideMin(sun).toFixed(1)}`);
}

console.log("\n— it picks the faster of two ways —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 1 }], B0: [{ route: "R-B", min: 1 }] };
  const p = await plan({ lat: LAT0 + 0.0002, lng: LNG0 + 0.0051 },
                       { lat: LAT0 + 10 * STEP, lng: LNG0 + 0.0051 }, WED_0900);
  const r = ride(p.itineraries[0]);
  ok("the express wins when both are a minute away", r && r.line === "X95",
     r && `${r.line}, ${r.stops} stops, ${p.itineraries[0].totalMin} min`);
}

console.log("\n— it changes vehicles when it has to —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 2 }] };
  const best = (await plan({ lat: LAT0, lng: LNG0 },
    { lat: LAT0 + 6 * STEP + 0.0007, lng: LNG0 + 6 * 0.0046 }, WED_0900)).itineraries[0];
  const rides = best.legs.filter(l => l.mode !== "walk");
  ok("two vehicles", rides.length === 2, legTypes(best));
  ok("...the avenue then the cross-street",
     rides.length === 2 && rides[0].line === "608" && rides[1].line === "021",
     rides.map(r => r.line).join(">"));
  ok("...changing where the two actually meet",
     /AVENUE 6|ΟΔΟΣ 6/.test(rides[0].to.el + rides[0].to.en), rides[0].to.en);
  ok("...counted as one change", best.changes === 1, String(best.changes));
  ok("the first boarding is live and the second is not",
     rides[0].basis === "live" && rides[1].basis !== "live",
     rides.map(r => r.basis).join(","));
}

console.log("\n— it fits in a Worker —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  ok("the subrequest count is reported", typeof p.subrequests === "number", String(p.subrequests));
  ok("...and stays under the free-tier ceiling of 50", p.subrequests < 50, String(p.subrequests));
  ok("...matching what was actually fetched", Math.abs(calls.length - p.subrequests) <= 4,
     `counted ${calls.length}, reported ${p.subrequests}`);
}

console.log("\n— reading a timetable out of whatever OASA sends —");
{
  const parse = v => vm.runInContext(`parseTimes(${JSON.stringify(v)}, [], 0)`, ctx);
  ok('"07:35" is half past seven', parse(["07:35"])[0] === 455, String(parse(["07:35"])));
  ok('"7:35" too, unpadded', parse(["7:35"])[0] === 455, String(parse(["7:35"])));
  ok('"07:35:00" too, with seconds', parse(["07:35:00"])[0] === 455, String(parse(["07:35:00"])));
  ok("a bare number under a time-ish key is minutes past midnight",
     parse({ start_time: 455 })[0] === 455, String(parse({ start_time: 455 })));
  ok("...but a bare number on its own is not believed",
     parse([455]).length === 0, String(parse([455])));
  ok("24:10 is a trip after midnight, not an error",
     parse(["24:10"])[0] === 1450, String(parse(["24:10"])));
  ok("it digs through nesting", parse({ go: [{ t: "06:00" }, { t: "06:20" }] }).length === 2,
     String(parse({ go: [{ t: "06:00" }, { t: "06:20" }] })));
  ok("a line number is not a departure, however time-shaped it looks",
     parse({ line_id: "608" }).length === 0, String(parse({ line_id: "608" })));
  ok("nor is 25:99", parse(["25:99"]).length === 0, String(parse(["25:99"])));
  ok("nor free text", parse(["ΚΑΘΗΜΕΡΙΝΗ"]).length === 0, String(parse(["ΚΑΘΗΜΕΡΙΝΗ"])));
  ok("garbage in, nothing out rather than a wrong time",
     parse([{ a: null }, [[["x"]]]]).length === 0);
}

console.log("\n— a connection past the horizon uses the timetable —");
{
  // no live data anywhere, and the second leg boards ~40 min out
  ARRIVALS = { A0: [{ route: "R-A", min: 2 }] };
  vm.runInContext(`schedMem.clear();`, ctx);
  // OASA answers with a weekday schedule of departures every 20 minutes
  ctx.__fx.sched = true;
  vm.runInContext(`
    const _g = getJSON;
    getJSON = async (u) => {
      const q = new URL(u).searchParams, act = q.get("act");
      if (act === "getScheduleDaysMasterline") {
        __log("sched-days:" + q.get("p1"));
        return [{ sdc_code: "1", sdc_descr: "ΚΑΘΗΜΕΡΙΝΗ" }, { sdc_code: "2", sdc_descr: "ΣΑΒΒΑΤΟ" }];
      }
      if (act === "getSchedLinesMasterline") {
        __log("sched:" + q.get("p1"));
        const go = [];
        for (let h = 5; h < 24; h++) for (const m of [0, 20, 40]) go.push(String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"));
        return { go, come: [] };
      }
      return _g(u);
    };
  `, ctx);
  const best = (await plan({ lat: LAT0, lng: LNG0 },
    { lat: LAT0 + 6 * STEP + 0.0007, lng: LNG0 + 6 * 0.0046 }, WED_0900)).itineraries[0];
  const rides = best.legs.filter(l => l.mode !== "walk");
  ok("the far boarding is timetabled, not guessed",
     rides.length === 2 && rides[1].basis === "timetable",
     rides.map(r => r.mode + ":" + r.basis).join(" "));
  ok("...and the schedule was actually fetched",
     calls.some(c => c.startsWith("sched:")), calls.filter(c => /sched/.test(c)).join(" "));
  ok("...for the weekday day-type", calls.some(c => c.startsWith("sched-days:")));
  ok("the wait it produces is a real gap, not half a headway",
     rides[1].wait >= 0 && rides[1].wait <= 25, String(rides[1].wait));
  ok("the itinerary now reads as mixed, since one leg is live",
     best.basis === "mixed", best.basis);
  ok("a second plan reuses the cached schedule",
     await (async () => {
       const before = calls.filter(c => c.startsWith("sched:")).length;
       await plan({ lat: LAT0, lng: LNG0 },
         { lat: LAT0 + 6 * STEP + 0.0007, lng: LNG0 + 6 * 0.0046 }, WED_0900);
       return calls.filter(c => c.startsWith("sched:")).length === 0;
     })(), "cached");
}

console.log("\n— when no timetable can be read —");
{
  vm.runInContext(`schedMem.clear();
    const _g2 = getJSON;
    getJSON = async (u) => {
      const q = new URL(u).searchParams, act = q.get("act");
      if (act === "getScheduleDaysMasterline") return [{ sdc_code: "1", sdc_descr: "ΚΑΘΗΜΕΡΙΝΗ" }];
      if (act === "getSchedLinesMasterline") return { note: "no data" };
      return _g2(u);
    };`, ctx);
  ARRIVALS = { A0: [{ route: "R-A", min: 2 }] };
  const best = (await plan({ lat: LAT0, lng: LNG0 },
    { lat: LAT0 + 6 * STEP + 0.0007, lng: LNG0 + 6 * 0.0046 }, WED_0900)).itineraries[0];
  const far = best.legs.filter(l => l.mode !== "walk")[1];
  ok("it says estimated rather than claiming a timetable",
     far && far.basis === "estimated", far && far.basis);
}

console.log("\n— walking, when a router is available —");
{
  vm.runInContext(`schedMem.clear();`, ctx);
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  // a route twice as long as the straight line, with a bend in it
  ctx.__walkReply = { features: [{
    properties: { summary: { distance: 900, duration: 780 } },
    geometry: { coordinates: [[LNG0, LAT0], [LNG0 + 0.002, LAT0 + 0.001], [LNG0, LAT0 + 0.002]] } }] };
  const withKey = await vm.runInContext(
    `planJourney({lat:${LAT0},lng:${LNG0}}, {lat:${LAT0 + 9 * STEP},lng:${LNG0}}, ${new Date(WED_0900).getTime()}, {ORS_KEY:"k"})`, ctx);
  const w = withKey.itineraries[0].legs.find(l => l.mode === "walk");
  ok("walking legs are routed for real", w && w.basis === "routed", w && w.basis);
  ok("...taking the router's distance", w && w.metres === 900, String(w && w.metres));
  ok("...its duration", w && Math.abs(w.min - 13) < 0.2, String(w && w.min));
  ok("...and its shape to draw", w && w.path.length === 3, String(w && w.path.length));
  ok("the answer says routing was available", withKey.walkRouting === true);

  ctx.__walkReply = null;                    // router down
  const noRouter = await vm.runInContext(
    `planJourney({lat:${LAT0},lng:${LNG0}}, {lat:${LAT0 + 9 * STEP},lng:${LNG0}}, ${new Date(WED_0900).getTime()}, {ORS_KEY:"k"})`, ctx);
  const w2 = noRouter.itineraries[0].legs.find(l => l.mode === "walk");
  ok("a router that fails leaves the estimate standing, not a hole",
     w2 && w2.basis === "estimated" && isFinite(w2.min), w2 && `${w2.basis} ${w2.min}`);

  const noKey = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  ok("with no key configured it does not even try",
     noKey.walkRouting === false &&
     noKey.itineraries[0].legs.filter(l => l.mode === "walk").every(l => l.basis === "estimated"));
}

console.log("\n— the walking estimate bends with distance —");
{
  const wm = m => vm.runInContext(`walkMinutes(${m})`, ctx);
  const factor = m => (wm(m) * 80) / m;
  ok("a fifty-metre hop detours much more than a kilometre",
     factor(50) > factor(1000) + 0.25,
     `50m x${factor(50).toFixed(2)}, 1000m x${factor(1000).toFixed(2)}`);
  ok("...and it is monotonic, not a step",
     factor(200) > factor(500) && factor(500) > factor(900),
     [200,500,900].map(m=>factor(m).toFixed(2)).join(" > "));
  ok("nothing walks faster than a person",
     factor(2000) >= 1.2, factor(2000).toFixed(2));
}

console.log("\n— tram and trolley are told apart from buses —");
{
  const mode = o => vm.runInContext(`vehicleMode(${JSON.stringify(o)})`, ctx);
  ok("a tram route reads as tram", mode({ el: "ΤΡΑΜ ΠΡΟΣ ΒΟΥΛΑ", en: "TRAM TO VOULA" }) === "tram");
  ok("a trolley reads as trolley", mode({ el: "ΤΡΟΛΛΕΙ 11", en: "TROLLEY 11" }) === "trolley");
  ok("anything else stays a bus", mode({ el: "608 ΠΡΟΣ ΚΕΝΤΡΟ", en: "608 TO CENTRE" }) === "bus");
  ok("...including nothing at all", mode({}) === "bus");
}

console.log("\n— every leg carries what the UI needs —");
{
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  const best = (await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900)).itineraries[0];
  ok("a mode and a duration on each", best.legs.every(l => l.mode && isFinite(l.min)));
  ok("walking legs carry their distance", best.legs.filter(l => l.mode === "walk").every(l => isFinite(l.metres)));
  ok("riding legs carry a line, both ends and a basis",
     best.legs.filter(l => l.mode !== "walk").every(l => l.line && l.from && l.to && l.basis));
  ok("every leg carries geometry to draw",
     best.legs.every(l => Array.isArray(l.path) && l.path.length >= 2),
     JSON.stringify(best.legs.map(l => (l.path || []).length)));
  ok("the total is the sum of the legs",
     Math.abs(best.legs.reduce((a, l) => a + l.min, 0) - best.totalMin) < 1.5,
     `${best.legs.reduce((a, l) => a + l.min, 0).toFixed(1)} vs ${best.totalMin}`);
  ok("changes match the vehicles used",
     best.changes === best.legs.filter(l => l.mode !== "walk").length - 1);
}

/* "Walk 34 minutes" is the one answer a rider cannot check against
   anything. It has to say whether it won because the next bus is 40
   minutes away, because nothing is running, or because the planner found
   no way to ride — those call for three different reactions. */
console.log("\n— a walking option says why it is there —");
const walkOf = p => p.itineraries.find(i => i.legs.every(l => l.mode === "walk"));
{
  // 1.2 km — a 15-ish minute walk — against a bus that is 28 minutes out
  ARRIVALS = { A0: [{ route: "R-A", min: 28 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 3 * STEP, lng: LNG0 }, WED_0900);
  const w = walkOf(p);
  ok("walking wins when the bus is half an hour out", !!w, p.itineraries.map(legTypes).join(" | "));
  ok("...and says it beat something", w && w.why && w.why.code === "beats",
     JSON.stringify(w && w.why));
  ok("...naming the line it beat", w && w.why.line === "608", w && w.why.line);
  /* The note must describe the option actually on screen, not the stop the
     test had in mind: the search is free to board somewhere else. */
  const alt = p.itineraries.find(i => i.legs.some(l => l.mode !== "walk"));
  const board = alt && alt.legs.find(l => l.mode !== "walk");
  ok("...and the wait that lost it, as shown on that very option",
     w && board && Math.round(board.wait) === w.why.waitMin,
     `note says ${w && w.why.waitMin}′, the option says ${board && Math.round(board.wait)}′`);
  ok("...and its total, likewise", w && alt && w.why.viaMin === alt.totalMin,
     `${w && w.why.viaMin}′ vs ${alt && alt.totalMin}′`);
  ok("...which is slower than walking, or it would not have lost",
     w && w.why.viaMin >= w.totalMin,
     `${w && w.why.viaMin}′ by bus vs ${w && w.totalMin}′ on foot`);
  ok("the option it beat is still offered, for anyone who cannot walk it",
     p.itineraries.some(i => i.legs.some(l => l.mode !== "walk")),
     p.itineraries.map(i => i.kind + ":" + legTypes(i)).join(" | "));
  ok("...and that one costs no extra requests", p.subrequests <= 40, String(p.subrequests));
}
{
  // 2 km — around 25 minutes on foot — against a bus that is due now
  ARRIVALS = { A0: [{ route: "R-A", min: 1 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 5 * STEP, lng: LNG0 }, WED_0900);
  const w = walkOf(p), best = p.itineraries[0];
  ok("riding wins when the bus is due", best.legs.some(l => l.mode !== "walk"), legTypes(best));
  ok("a walk far slower than riding is not offered as an alternative", !w,
     "three slots, and padding one of them pushes a real route off the list");
}
{
  // riding only a little quicker: walking is a genuine choice, so keep it
  ARRIVALS = { A0: [{ route: "R-A", min: 8 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 2 * STEP, lng: LNG0 }, WED_0900);
  const w = walkOf(p);
  ok("a walk within a few minutes of riding is kept", !!w,
     p.itineraries.map(i => `${i.kind}:${i.totalMin}′`).join(" | "));
  ok("...and admits it is the slower one when it is",
     !w || !w.why || ["beats", "also"].includes(w.why.code), JSON.stringify(w && w.why));
}
{
  ARRIVALS = {};
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 2 * STEP, lng: LNG0 }, WED_0300);
  const w = walkOf(p);
  ok("at 03:00 the walk is offered because nothing is running",
     w && w.why && w.why.code === "closed", JSON.stringify(w && w.why));
}
{
  // a kilometre out into the fields: nothing within walking distance
  ARRIVALS = {};
  const p = await plan({ lat: LAT0 - 0.05, lng: LNG0 - 0.05 },
                       { lat: LAT0 - 0.05, lng: LNG0 - 0.047 }, WED_0900);
  const w = walkOf(p);
  ok("with no stop near the start, the walk says so rather than nothing",
     w && w.why && w.why.code === "nostopsfrom", JSON.stringify(w && w.why));
}
{
  ARRIVALS = {};
  const p = await plan({ lat: LAT0 - 0.4, lng: LNG0 - 0.4 },
                       { lat: LAT0 - 0.4, lng: LNG0 + 0.4 }, WED_0900);
  ok("an empty answer distinguishes 'no stop here' from 'no route'",
     ["nostopsfrom", "nostopsto", "noconnection", "closed"].includes(p.reason),
     p.reason);
}
{
  ARRIVALS = { A0: [{ route: "R-A", min: 3 }] };
  const p = await plan({ lat: LAT0, lng: LNG0 }, { lat: LAT0 + 9 * STEP, lng: LNG0 }, WED_0900);
  ok("a riding itinerary carries no walking excuse", p.itineraries.every(i => !i.why),
     "the note belongs on the walk-only option and nowhere else");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
