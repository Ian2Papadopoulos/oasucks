/**
 * OASAx — Cloudflare Worker backend
 * Copyright (C) 2026 OASAx contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version. It is distributed WITHOUT ANY WARRANTY;
 * see the LICENSE file, or <https://www.gnu.org/licenses/>.
 * ------------------------------------------------------------------
 *  GET  /api?act=...            → OASA telematics proxy (CORS, 8s timeout, retry)
 *  GET  /geocode?q=...          → address search; accepts greeklish ("filotimou")
 *  GET  /reverse?lat=&lon=      → coordinates → address
 *  GET  /push/key               → VAPID public key (for the browser to subscribe)
 *  POST /push/subscribe         → store a push subscription, returns its id
 *  POST /push/test              → send a test notification (no UI; kept for
 *                                  debugging via curl)
 *  GET  /rules?sub=ID           → list alert rules
 *  POST /rules                  → create/update an alert rule
 *  POST /rules/delete           → delete an alert rule
 *  GET  /health                 → liveness; +admin token = usage summary
 *  GET  /stops/search?q=        → find stops by place/stop name
 *  GET  /alerts/windows         → when alerts need the cron (admin)
 *  POST /admin/reports/purge    → wipe reports / history rows (admin)
 *  POST /stops/dead             → verify+record a stop that has no lines
 *  GET  /reports?by=ID          → active community flags on buses and stations
 *  POST /reports                → file (or renew) a report
 *  POST /reports/delete         → withdraw a report (reporter-only)
 *  GET  /metro                  → static Athens metro station list
 *  GET  /plan?from=&to=         → A-to-B itineraries (walk / bus / metro)
 *  GET  /lines                  → every OASA line (id, code, description)
 *  GET  /live?lat=&lng=         → live vehicle positions around a point
 *  GET  /scan?lat=&lng=         → batched "which bus am I on?" candidates
 *  cron (every minute)          → check live arrivals, fire push alerts
 *
 * Alerts need a KV namespace bound as ALERTS and VAPID secrets; without
 * them the app still works fully, alerts just report "not configured".
 */

const APP_VERSION = "v61";
const OASA = "https://telematics.oasa.gr/api/";
const NOMINATIM = "https://nominatim.openstreetmap.org/";
const UA = "StopArrivals/1.0 (personal transit PWA)";
const TIMEOUT_MS = 8000;
const OASA_CACHE = 12;
const GEO_CACHE = 86400;
// Bias geocoding toward Attica (left,top,right,bottom)
const VIEWBOX = "23.40,38.40,24.10,37.70";

// act → edge cache seconds. Live positions/arrivals must stay fresh;
// route geometry and stop lists never change, so cache them for a day.
const ACT_TTL = {
  getStopArrivals: 12,
  getBusLocation: 12,
  getClosestStops: 3600,
  webRoutesForStop: 86400,
  webGetStops: 86400,
  webRouteDetails: 86400,
  getRouteName: 86400,
  getStopNameAndXY: 86400,
  webGetRoutes: 86400,
  getRoutesForLine: 86400,
  webGetLines: 86400,
};
const ALLOWED_ACTS = new Set(Object.keys(ACT_TTL));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

/* ======================= abuse controls =========================== *
 * Per-IP, in-memory, fixed-window rate limiting. It lives in the
 * isolate (one per colo, recycled often), so it is NOT globally exact —
 * but it cheaply blunts the realistic threat: a single script hammering
 * the write / fan-out endpoints from one address. It costs zero storage
 * and can't itself be exhausted. For hard, global guarantees layer
 * Cloudflare's WAF rate-limiting rules on top (dashboard → Security).
 * ------------------------------------------------------------------ */
const RL = new Map();                        // "bucket:ip" -> { n, reset }
function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "unknown";
}
function rateLimit(ip, bucket, limit, windowSec) {
  const now = Date.now();
  if (RL.size > 5000) {                      // opportunistic sweep, bounded memory
    for (const [k, v] of RL) if (v.reset < now) RL.delete(k);
    if (RL.size > 8000) RL.clear();
  }
  const key = bucket + ":" + ip;
  let e = RL.get(key);
  if (!e || e.reset < now) { e = { n: 0, reset: now + windowSec * 1000 }; RL.set(key, e); }
  e.n++;
  return e.n <= limit;
}
function tooMany() { return json({ error: "rate limited, slow down" }, 429); }

/* Tracking mutations are admin actions, not public ones. They're allowed
 * only when the ADMIN_TOKEN secret is set AND the caller presents it
 * (header X-Admin-Token, or ?token=). No secret configured → denied. */
function adminOK(req, env) {
  const want = env && env.ADMIN_TOKEN;
  if (!want) return false;
  const got = req.headers.get("X-Admin-Token") ||
    new URL(req.url).searchParams.get("token") || "";
  // constant-ish comparison; tokens are short and this isn't timing-critical
  return got.length === want.length && got === want;
}

/* ===================== generic fetch helpers ====================== */

/* `opts` exists for the one caller that must not make a rider wait: a
   best-effort lookup on the type-ahead path wants a short fuse and no
   second attempt, because failing fast still leaves a usable answer on
   screen and 2 × 8s does not. */
async function timedFetch(urlStr, cacheTtl, opts) {
  const ms = (opts && opts.timeoutMs) || TIMEOUT_MS;
  const tries = (opts && opts.tries) || 2;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(urlStr, {
        method: "GET",
        headers: { "User-Agent": UA, "Accept": "application/json, */*" },
        signal: ctrl.signal,
        cf: { cacheTtl, cacheEverything: true },
      });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr;
}

async function proxy(targetUrl, cacheSeconds, skipCache) {
  const cache = caches.default;
  const key = new Request(targetUrl, { method: "GET" });
  if (!skipCache) {
    const hit = await cache.match(key);
    if (hit) return withCors(hit);
  }
  let up;
  try {
    up = await timedFetch(targetUrl, cacheSeconds);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return json({ error: /abort/i.test(msg) ? "upstream timeout" : "upstream unreachable" }, 502);
  }
  const body = await up.text();
  const res = new Response(body, {
    status: up.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${cacheSeconds}`,
      ...CORS,
    },
  });
  if (up.ok && !skipCache) await cache.put(key, res.clone());
  return res;
}

async function getJSON(urlStr, cacheTtl, opts) {
  try {
    const r = await timedFetch(urlStr, cacheTtl, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* ======================= greeklish → greek ======================== */
/* "filotimou" → "φιλοτιμου", "Panormou" → "πανορμου".               */

// Note: "ps"/"ks" only map to ψ/ξ when they aren't split across a syllable
// boundary (kipseli = κυψέλη, but "ps" in e.g. "kaps-" stays split). We keep
// them, and rely on the alternate candidates below when a guess misses.
const DIGRAPHS = [
  ["th","θ"],["ch","χ"],["kh","χ"],["ps","ψ"],["ks","ξ"],["ou","ου"],
  ["ai","αι"],["ei","ει"],["oi","οι"],["au","αυ"],["eu","ευ"],
  ["mp","μπ"],["nt","ντ"],["gk","γκ"],["gg","γγ"],["ts","τσ"],["tz","τζ"],
];
const SINGLES = {
  a:"α", b:"β", c:"κ", d:"δ", e:"ε", f:"φ", g:"γ", h:"η", i:"ι", j:"ζ",
  k:"κ", l:"λ", m:"μ", n:"ν", o:"ο", p:"π", q:"κ", r:"ρ", s:"σ", t:"τ",
  u:"υ", v:"β", w:"ω", x:"ξ", y:"υ", z:"ζ",
};

function toGreek(input) {
  const s = input.toLowerCase();
  let out = "";
  for (let i = 0; i < s.length; ) {
    const two = s.slice(i, i + 2);
    const dg = DIGRAPHS.find(d => d[0] === two);
    if (dg) { out += dg[1]; i += 2; continue; }
    const ch = s[i];
    out += SINGLES[ch] != null ? SINGLES[ch] : ch;
    i += 1;
  }
  // final sigma
  return out.replace(/σ(?=$|[^\u0370-\u03ff\u1f00-\u1fff])/g, "ς");
}

function isLatin(s) { return /[a-z]/i.test(s) && !/[\u0370-\u03ff]/.test(s); }

/* Greeklish is lossy: one latin spelling maps to several valid Greek ones
 * (i → ι/η/υ, o → ο/ω, e → ε/αι). We try the most likely spelling first and
 * fall back through the common alternates until Nominatim finds something. */
function geocodeCandidates(q) {
  const out = [];
  const push = v => { if (v && !out.includes(v)) out.push(v); };
  if (isLatin(q)) {
    const g = toGreek(q);
    push(g);
    push(g.replace(/ι/g, "υ"));   // kipseli → κυψελη
    push(g.replace(/ι/g, "η"));   // -is endings → -ης
    push(g.replace(/ο/g, "ω"));
    push(q);                       // some OSM entries carry latin names
  } else {
    push(q);
  }
  return out.slice(0, 4);
}

function nominatimSearchUrl(q, lang) {
  const n = new URL(NOMINATIM + "search");
  n.searchParams.set("format", "jsonv2");
  n.searchParams.set("q", q);
  n.searchParams.set("limit", "6");
  n.searchParams.set("countrycodes", "gr");
  n.searchParams.set("viewbox", VIEWBOX);
  n.searchParams.set("addressdetails", "1");
  n.searchParams.set("accept-language", lang);
  return n.toString();
}

/* Nominatim's STRUCTURED form, for a query that names a building.
 *
 * Free-form search treats "Φιλοτίμου 12" as a bag of words and will
 * happily rank the street itself, or a café on it, above the address —
 * which is why some streets resolved to a house number and others did
 * not, with nothing obviously different about them. The structured form
 * says which token is the street, so the geocoder stops guessing.
 *
 * `bounded=1` is safe here in a way it is not for free-form search: an
 * address query that leaves Attica is wrong anyway, and the box is what
 * keeps a same-named street in Thessaloniki out of the list. */
function nominatimAddressUrl(street, lang) {
  const n = new URL(NOMINATIM + "search");
  n.searchParams.set("format", "jsonv2");
  n.searchParams.set("street", street);          // "12 Φιλοτίμου" — number first
  n.searchParams.set("countrycodes", "gr");
  n.searchParams.set("viewbox", VIEWBOX);
  n.searchParams.set("bounded", "1");
  n.searchParams.set("limit", "6");
  n.searchParams.set("addressdetails", "1");
  n.searchParams.set("accept-language", lang);
  return n.toString();
}

/* "Φιλοτίμου 12" and "12 Φιλοτίμου" both mean the same building, and
 * Nominatim's structured `street` wants the number first. Pull the number
 * out wherever it sits and rebuild it in the order the API expects. */
function splitAddress(q) {
  const s = String(q || "").trim();
  const m = s.match(HOUSE_NO);
  if (!m) return null;
  const num = m[0].trim();
  const name = s.replace(HOUSE_NO, " ").replace(/\s+/g, " ").trim();
  return name ? { num, name, street: `${num} ${name}` } : null;
}

/* ------------------------- address search --------------------------- *
 * Two geocoders, tried in this order:
 *
 *   1. OpenRouteService (Pelias) /geocode/autocomplete — built for
 *      type-ahead. It matches PARTIAL tokens, so "synt" already finds
 *      Syntagma; it takes a focus point, so what is near you sorts to
 *      the top; and it carries Greek street addresses down to the house
 *      number. Needs ORS_KEY, the same secret the walking router uses.
 *   2. Nominatim /search — no key, but it wants a near-complete query
 *      and ranks by nothing you can steer. This stays the fallback, and
 *      is what an install without a key still gets.
 *
 * Both are flattened into the same rows so the app never learns which
 * one answered: { lat, lon, display_name, address, matched, source }.
 * The `address` shape is Nominatim's, because the app's label builder
 * was written against it — Pelias fields are mapped onto it below.
 * ------------------------------------------------------------------- */
const ORS_GEO = "https://api.openrouteservice.org/geocode/autocomplete";
/* Pelias splits the job in two, and using the wrong half is why
 * "Φιλοτίμου 12" used to come back as the street with no number.
 * `/autocomplete` is tuned for prefixes and deliberately does not run the
 * full address parser; `/search` does, and resolves a house number onto
 * the right point along the street. So: the moment the query looks like a
 * complete address, switch endpoints. */
const ORS_GEO_FULL = "https://api.openrouteservice.org/geocode/search";
/* A house number is a short standalone run of digits, optionally with a
 * Greek or latin letter suffix (12Α, 12A) or a range (12-14). A postcode
 * (5 digits) or a bus line ("608") is not one, and neither is a number
 * that is part of a name — "Πλατεία 25ης Μαρτίου". */
const HOUSE_NO = /(^|\s)\d{1,3}([\-–]\d{1,3})?[A-Za-zΑ-Ωα-ω]?(\s|$)/;
function looksAddressed(q) {
  const s = String(q || "").trim();
  // a bare number on its own is not an address, it is someone still typing
  return HOUSE_NO.test(s) && /[A-Za-zΑ-Ωα-ωἀ-῿]{3}/.test(s);
}
/* Same window as VIEWBOX, spelled out because Pelias wants corners
 * rather than Nominatim's left,top,right,bottom string. */
const ATTICA = { minLon: 23.40, minLat: 37.70, maxLon: 24.10, maxLat: 38.40 };
/* Everything a rider might name as an origin or a destination. Left
 * unrestricted, Pelias also returns regions and countries, which are
 * useless here — you cannot walk to "Greece". */
const ORS_LAYERS = "address,venue,street,neighbourhood,borough,locality,localadmin";

function orsGeoUrl(q, lang, focus) {
  const full = looksAddressed(q);
  const u = new URL(full ? ORS_GEO_FULL : ORS_GEO);
  u.searchParams.set("text", q);
  u.searchParams.set("size", "8");
  u.searchParams.set("lang", lang === "en" ? "en" : "el");
  /* With a house number, an exact address is what was asked for — let the
   * neighbourhood and locality rows fall away rather than pushing the one
   * useful hit down the list. */
  u.searchParams.set("layers", full ? "address,street" : ORS_LAYERS);
  u.searchParams.set("boundary.country", "GRC");
  u.searchParams.set("boundary.rect.min_lon", String(ATTICA.minLon));
  u.searchParams.set("boundary.rect.min_lat", String(ATTICA.minLat));
  u.searchParams.set("boundary.rect.max_lon", String(ATTICA.maxLon));
  u.searchParams.set("boundary.rect.max_lat", String(ATTICA.maxLat));
  /* Two decimals — about a kilometre. This only nudges the ranking, so
   * more precision buys nothing and costs cache hits: everyone searching
   * from the same neighbourhood should share one cached answer. */
  if (focus) {
    u.searchParams.set("focus.point.lat", focus.lat.toFixed(2));
    u.searchParams.set("focus.point.lon", focus.lng.toFixed(2));
  }
  return u.toString();
}

/* Pelias → the app's rows. `name` on an address layer already reads
 * "Φιλοτίμου 12", so prefer it over the bare street: losing the house
 * number is exactly what made the old labels useless. */
function orsRow(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && f.geometry.coordinates) || [];
  const lon = Number(c[0]), lat = Number(c[1]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const road = p.layer === "address" && p.name ? p.name : (p.street || null);
  return {
    lat: String(lat), lon: String(lon),
    display_name: p.label || p.name || "",
    /* What KIND of thing this is, said by the geocoder rather than
     * guessed from the fields. The app needs it to know whether a row is
     * a point or a whole road: a road is held in OpenStreetMap as several
     * ways with several midpoints, so its duplicates have to be found by
     * name, while everything else is one place at one position. */
    precision: p.layer === "address" ? "address" : p.layer === "street" ? "street" : "point",
    address: {
      road,
      neighbourhood: p.neighbourhood || null,
      suburb: p.borough || null,
      city: p.locality || p.localadmin || null,
      amenity: p.layer === "venue" ? (p.name || null) : null,
    },
    source: "ors",
  };
}

/* The key goes in a header, not the query, so the URL stays safe to use
 * as a cache key — otherwise the secret would end up inside Cloudflare's
 * cache index for every search anyone ever runs. */
async function orsGeocode(q, lang, focus, env) {
  const key = env && env.ORS_KEY;
  if (!key) return null;
  const target = orsGeoUrl(q, lang, focus);
  const cache = caches.default;
  const ck = new Request(target, { method: "GET" });
  const hit = await cache.match(ck);
  if (hit) { try { return await hit.json(); } catch (_) { /* fall through */ } }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let rows = null;
  try {
    const res = await fetch(target, {
      headers: { "Authorization": key, "Accept": "application/json", "User-Agent": UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const feats = j && Array.isArray(j.features) ? j.features : [];
    rows = feats.map(orsRow).filter(Boolean);
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
  if (rows && rows.length) {
    await cache.put(ck, new Response(JSON.stringify(rows), {
      headers: { "Content-Type": "application/json; charset=utf-8",
                 "Cache-Control": `public, max-age=${GEO_CACHE}` },
    }));
  }
  return rows;
}

/* ------------- house numbers OpenStreetMap does not have ------------- *
 * A great many Athens streets carry no `addr:housenumber` at all, and no
 * geocoder can return a number that was never surveyed. What most of those
 * streets DO carry is a handful of numbered points — a pharmacy at 14, a
 * school at 32 — and a road geometry running between them. That is enough
 * to say roughly where number 22 is: project the known numbers onto the
 * road, and read the requested one off the line between them.
 *
 * This is an estimate and it is labelled as one. It lands within a block,
 * which is the resolution a bus journey actually needs — the walking leg
 * absorbs the rest — and it beats the alternative, which was handing back
 * the midpoint of a two-kilometre road.
 *
 * Overpass is the only free source for "every numbered point on this
 * street", so it is asked at most three times per search, only after every
 * geocoder has already missed, and the answer is cached for a week. If it
 * is slow or down, the street row it would have replaced is still there.
 * ------------------------------------------------------------------- */
const OVERPASS = "https://overpass-api.de/api/interpreter";
const INTERP = {
  radiusM: 350,      // how far around the matched point to look for the road
  anchorM: 60,       // a numbered point further than this belongs to another street
  maxStreets: 3,     // distinct roads we will spend an Overpass call on
  maxSpan: 60,       // give up if the nearest known numbers are this far off
  cache: 7 * 86400,  // a house number is not news
  timeoutMs: 3500,   // someone is typing; a slow answer is worse than none
};

function overpassUrl(name, lat, lng, r) {
  // the name goes inside a quoted Overpass string; quotes and backslashes out
  const n = String(name).replace(/["\\]/g, " ").trim();
  const q = `[out:json][timeout:20];`
    + `way(around:${r},${lat},${lng})[highway][name="${n}"];out geom;`
    + `nwr(around:${r},${lat},${lng})["addr:housenumber"]["addr:street"="${n}"];out center;`;
  return OVERPASS + "?data=" + encodeURIComponent(q);
}

/* "12", "12Α", "12-14" → 12. A number we cannot read is not an anchor. */
function houseNum(s) {
  const m = /^\s*(\d{1,4})/.exec(String(s || ""));
  return m ? Number(m[1]) : null;
}

/* Metres, flat, around one latitude. Athens is small enough that the
   error over a single street is far below the error in the estimate. */
function planar(lat0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return { x: p => p.lon * kx, y: p => p.lat * ky };
}

/* A long road is several OSM ways with independent directions, and
   interpolating along the wrong one puts number 22 in the next
   neighbourhood. Chain them end to end, flipping as needed; anything that
   will not join is a side branch and is dropped. */
function joinWays(ways) {
  const segs = ways.map(w => (w.geometry || []).map(g => ({ lat: g.lat, lon: g.lon })))
    .filter(s => s.length > 1);
  if (!segs.length) return [];
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  let line = segs.shift(), moved = true;
  while (segs.length && moved) {
    moved = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i], head = line[0], tail = line[line.length - 1];
      if (same(tail, s[0])) line = line.concat(s.slice(1));
      else if (same(tail, s[s.length - 1])) line = line.concat(s.slice(0, -1).reverse());
      else if (same(head, s[s.length - 1])) line = s.slice(0, -1).concat(line);
      else if (same(head, s[0])) line = s.slice(1).reverse().concat(line);
      else continue;
      segs.splice(i, 1); moved = true; break;
    }
  }
  return line;
}

function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++)
    c.push(c[i - 1] + hav(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  return c;
}

/* How far along the road a point sits, and how far off it — the second
   number is what tells us the point belongs to some other street. */
function projectAlong(pts, cum, pr, p) {
  let best = { off: Infinity, along: 0 };
  const qx = pr.x(p), qy = pr.y(p);
  for (let i = 1; i < pts.length; i++) {
    const ax = pr.x(pts[i - 1]), ay = pr.y(pts[i - 1]);
    const vx = pr.x(pts[i]) - ax, vy = pr.y(pts[i]) - ay;
    const L2 = vx * vx + vy * vy;
    let t = L2 ? ((qx - ax) * vx + (qy - ay) * vy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(qx - (ax + t * vx), qy - (ay + t * vy));
    if (off < best.off) best = { off, along: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
  }
  return best;
}

function pointAt(pts, cum, along) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, along));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = (cum[i] - cum[i - 1]) || 1;
  const t = (d - cum[i - 1]) / seg;
  return { lat: pts[i - 1].lat + t * (pts[i].lat - pts[i - 1].lat),
           lon: pts[i - 1].lon + t * (pts[i].lon - pts[i - 1].lon) };
}

/* Odd and even run up opposite pavements together, so when one side has
   enough anchors of its own it is the better ruler — mixing the sides
   doubles the number of steps per metre and skews the estimate. */
function alongFor(anchors, want) {
  const side = anchors.filter(a => a.n % 2 === want % 2);
  const use = (side.length >= 2 ? side : anchors).slice().sort((a, b) => a.n - b.n);
  if (!use.length) return null;

  const exact = use.find(a => a.n === want);
  if (exact) return { along: exact.along, exact: true };
  if (use.length < 2) return null;

  let lo = null, hi = null;
  for (const a of use) {
    if (a.n < want && (!lo || a.n > lo.n)) lo = a;
    if (a.n > want && (!hi || a.n < hi.n)) hi = a;
  }
  if (lo && hi) {
    if (hi.n - lo.n > INTERP.maxSpan) return null;
    const t = (want - lo.n) / (hi.n - lo.n);
    return { along: lo.along + t * (hi.along - lo.along), exact: false };
  }
  /* Past both ends of what anyone has mapped: carry on at the rate the
     nearest two numbers set, but only just past them. Extrapolating 200
     numbers off the end of the evidence is guessing, not estimating. */
  const near = want < use[0].n ? [use[0], use[1]] : [use[use.length - 1], use[use.length - 2]];
  if (Math.abs(want - near[0].n) > INTERP.maxSpan) return null;
  const dn = near[0].n - near[1].n;
  if (!dn) return null;
  const rate = (near[0].along - near[1].along) / dn;
  return { along: near[0].along + (want - near[0].n) * rate, exact: false };
}

/* One street row in, the same row with a house number in it out — or null
   when the road has nothing to measure against. */
async function interpolateStreet(row, want) {
  const lat = Number(row.lat), lon = Number(row.lon);
  const a = row.address || {};
  const name = a.road || a.pedestrian || a.footway || a.path
    || String(row.display_name || "").split(",")[0].trim();
  if (!name || !isFinite(lat) || !isFinite(lon)) return null;

  const data = await getJSON(overpassUrl(name, lat, lon, INTERP.radiusM), INTERP.cache,
    { timeoutMs: INTERP.timeoutMs, tries: 1 });
  const els = (data && Array.isArray(data.elements)) ? data.elements : null;
  if (!els || !els.length) return null;

  const line = joinWays(els.filter(e => e.type === "way" && e.geometry && e.tags && e.tags.highway));
  if (line.length < 2) return null;
  const cum = cumulative(line), pr = planar(lat);

  const anchors = [];
  for (const e of els) {
    const n = e.tags ? houseNum(e.tags["addr:housenumber"]) : null;
    if (n === null) continue;
    const p = e.type === "node" ? { lat: e.lat, lon: e.lon } : e.center;
    if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
    const pj = projectAlong(line, cum, pr, p);
    if (pj.off > INTERP.anchorM) continue;
    anchors.push({ n, along: pj.along });
  }
  const hit = alongFor(anchors, want);
  if (!hit) return null;

  const at = pointAt(line, cum, hit.along);
  const rest = String(row.display_name || "").split(",").slice(1).join(",").trim();
  return {
    lat: String(at.lat), lon: String(at.lon),
    display_name: rest ? `${name} ${want}, ${rest}` : `${name} ${want}`,
    address: { ...a, road: name, house_number: String(want) },
    matched: row.matched, source: hit.exact ? "osm" : "interp",
    precision: hit.exact ? "address" : "interpolated",
  };
}

/* Same-named streets in different neighbourhoods are separate answers and
   each deserves its own estimate, so this runs per row rather than once —
   but only for the first few distinct roads, and all at the same time. */
async function fillHouseNumbers(rows, want) {
  if (!Number.isFinite(want)) return rows;
  const seen = new Set(), picks = [];
  for (const r of rows) {
    const la = Number(r.lat), ln = Number(r.lon);
    if (!isFinite(la) || !isFinite(ln)) continue;
    const k = la.toFixed(3) + "," + ln.toFixed(3);
    if (seen.has(k)) continue;
    seen.add(k); picks.push(r);
    if (picks.length >= INTERP.maxStreets) break;
  }
  if (!picks.length) return rows;
  const done = await Promise.all(picks.map(r =>
    interpolateStreet(r, want).catch(() => null)));
  const swap = new Map();
  picks.forEach((r, i) => { if (done[i]) swap.set(r, done[i]); });
  return swap.size ? rows.map(r => swap.get(r) || r) : rows;
}

async function handleGeocode(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const lang = url.searchParams.get("lang") || "el";
  /* Read as strings first: Number(null) is 0, and a missing position
   * would otherwise focus the search on the Gulf of Guinea. */
  const slat = url.searchParams.get("lat"), slng = url.searchParams.get("lng");
  const flat = Number(slat), flng = Number(slng);
  const focus = (slat && slng && isFinite(flat) && isFinite(flng))
    ? { lat: flat, lng: flng } : null;

  /* Latin input is ambiguous against a Greek gazetteer, so we try the
   * query as typed first — Pelias does index the English names — and
   * only then the transliteration. Two shots, not four: every miss is
   * a request off the daily quota. */
  /* When a house number was asked for, a building beats a street — but a
   * street still beats NOTHING, which is what rejecting it outright gave
   * (v50's regression). OpenStreetMap simply has no `addr:housenumber` on
   * a great many Athens roads: that is a gap in the map, not a bug to
   * code around, and the honest handling is to answer with the street and
   * say that is what it is. `wantedNumber` rides along so the app can
   * label those rows rather than passing them off as the address. */
  const wantsNumber = looksAddressed(q);
  const hasNumber = r => /\d/.test((r.address && r.address.road) || "")
    || !!(r.address && r.address.house_number);
  const tag = rows => rows.map(r => ({ ...r, wantedNumber: wantsNumber }));
  let street = null;                       // best street-level answer, if any

  if (env && env.ORS_KEY) {
    const tries = isLatin(q) ? [q, toGreek(q)] : [q];
    for (const cand of tries) {
      const rows = await orsGeocode(cand, lang, focus, env);
      if (!rows || !rows.length) continue;
      const exact = wantsNumber ? rows.filter(hasNumber) : rows;
      if (exact.length) return json(tag(exact.map(r => ({ ...r, matched: cand }))));
      if (!street) street = rows.map(r => ({ ...r, matched: cand }));
    }
  }

  const osmRows = (data, cand) => data.map(d => ({
    lat: d.lat, lon: d.lon, display_name: d.display_name,
    address: d.address || null, matched: cand, source: "osm",
    // Nominatim says so in class/category: highway = a road, not a point
    precision: (d.address && d.address.house_number) ? "address"
      : /highway/.test(String(d.class || d.category || "")) ? "street" : "point",
  }));

  /* A query naming a building gets the structured form first, in every
   * spelling. Free-form search ranks the street, or a shop on it, above
   * the address often enough that "some streets work and some don't" was
   * the reported symptom — the difference was never the street. */
  const addr = wantsNumber ? splitAddress(q) : null;
  if (addr) {
    for (const cand of geocodeCandidates(q)) {
      const c = splitAddress(cand) || addr;
      const data = await getJSON(nominatimAddressUrl(c.street, lang), GEO_CACHE);
      if (!Array.isArray(data) || !data.length) continue;
      // a building is the answer; a street is the consolation, kept aside
      const hits = data.filter(d => d.address && d.address.house_number);
      if (hits.length) return json(tag(osmRows(hits, cand)));
      if (!street) street = osmRows(data, cand);
    }
  }

  for (const cand of geocodeCandidates(q)) {
    const data = await getJSON(nominatimSearchUrl(cand, lang), GEO_CACHE);
    if (!Array.isArray(data) || !data.length) continue;
    const hits = wantsNumber ? data.filter(d => d.address && d.address.house_number) : data;
    if (hits.length) return json(tag(osmRows(hits, cand)));
    if (!street) street = osmRows(data, cand);
  }

  /* No building anywhere. Before falling back to the whole road, try to
     place the number along it from whatever numbers the street does carry;
     rows that cannot be estimated stay as they were. The street, honestly
     labelled, still beats an empty list. */
  if (!street) return json([]);
  if (wantsNumber) {
    const a = splitAddress(q);
    const want = a ? houseNum(a.num) : null;
    if (want !== null) return json(tag(await fillHouseNumbers(street, want)));
  }
  return json(tag(street));
}

/* =========================== web push ============================= */

const enc = new TextEncoder();

function b64uToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function bytesToB64u(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cat(...arrs) {
  const n = arrs.reduce((t, a) => t + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8);
  return new Uint8Array(bits);
}

// RFC 8291 / RFC 8188 aes128gcm body
async function encryptPush(sub, plaintext) {
  const ua = b64uToBytes(sub.keys.p256dh);
  const auth = b64uToBytes(sub.keys.auth);

  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, eph.privateKey, 256));

  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = cat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last record
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, body));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function vapidAuth(endpoint, env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    d: env.VAPID_PRIVATE_KEY,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: env.VAPID_SUBJECT || "mailto:noreply@example.com",
  })));
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + payload)));
  return `vapid t=${header}.${payload}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendPush(sub, payloadObj, env) {
  const body = await encryptPush(sub, JSON.stringify(payloadObj));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "900",
      "Authorization": await vapidAuth(sub.endpoint, env),
    },
    body,
  });
  return res.status;
}

function pushReady(env) {
  return !!(env && env.ALERTS && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/* KV list operations are capped at 1,000/day on the free plan, and the cron
 * runs 1,440 times a day — so listing rules every minute exhausted the quota
 * and alerts died. All rules now live in ONE key, read with a plain get
 * (100,000/day). Zero list operations in normal running. */
const RULES_KEY = "rules:index";

async function readRules(env) {
  const idx = await env.ALERTS.get(RULES_KEY, "json");
  if (Array.isArray(idx)) return idx;
  // One-time migration from the old rule:<id> keys (a single list, once ever).
  // If that list fails — e.g. the daily quota is exhausted — return empty but
  // do NOT persist it, or we'd wipe existing rules. It retries next time.
  const out = [];
  let ok = false;
  try {
    const listed = await env.ALERTS.list({ prefix: "rule:" });
    for (const k of listed.keys) {
      const r = await env.ALERTS.get(k.name, "json");
      if (r) out.push(r);
    }
    ok = true;
  } catch (_) { /* quota exhausted or KV unavailable */ }
  if (ok) await env.ALERTS.put(RULES_KEY, JSON.stringify(out));
  return out;
}
async function writeRules(env, rules) {
  await env.ALERTS.put(RULES_KEY, JSON.stringify(rules));
}

/* ====================== alert rule evaluation ===================== */

function athensNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: days[p.weekday], minutes: (+p.hour) * 60 + (+p.minute) };
}
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/* ---------------- alert windows (cron work-avoidance) --------------- *
 * The cron fires on a fixed schedule, but most of those minutes have no
 * alert window anywhere near them. windowsOf() distils the rules into
 * {days, from, to, lead} tuples so a run can bail out before touching
 * OASA, and cronFor() turns the same tuples into the narrowest cron
 * expressions that still cover every rule — which is how the schedule
 * itself gets trimmed (see /alerts/windows and applySchedule).
 * ------------------------------------------------------------------- */
function windowsOf(rules) {
  return (rules || [])
    .filter(r => r && r.enabled !== false && Array.isArray(r.days) && r.days.length)
    .map(r => ({
      days: r.days.slice().sort(),
      from: hhmmToMin(r.from), to: hhmmToMin(r.to),
      lead: Math.max(...(r.leads || [10])),
    }))
    .filter(w => w.from != null && w.to != null);
}
function windowDue(windows, now) {
  return windows.some(w => w.days.includes(now.day) &&
    now.minutes >= w.from - w.lead - 1 && now.minutes <= w.to);
}
/* Athens local minutes → UTC hours, expanded to whole hours (cron's
 * finest useful granularity here) and merged per weekday set. */
/* The daily maintenance minute, in UTC. Everything else this function
   emits depends on the rules that exist right now — but the run that
   RE-WIDENS the schedule when a new rule appears happens at 04:00 Athens,
   so if that hour is ever left out the schedule can narrow and then never
   grow back. It has to be in every schedule we write, unconditionally. */
function maintenanceCron() {
  const h = ((4 - athensUtcOffsetHours()) % 24 + 24) % 24;
  return `0-1 ${h} * * *`;
}
function cronFor(windows) {
  const maint = maintenanceCron();
  // No rules is not "no cron": something has to be alive to notice the
  // first rule someone writes tomorrow.
  if (!windows.length) return [maint];
  const offset = athensUtcOffsetHours();
  const byDay = new Map();                        // utcDay -> Set(utcHour)
  for (const w of windows) {
    const startMin = Math.max(0, w.from - w.lead - 1);
    for (const d of w.days) {
      for (let m = startMin; m <= w.to; m += 60) markHour(byDay, d, m, offset);
      markHour(byDay, d, w.to, offset);           // always include the closing hour
    }
  }
  // group days that share the same hour set, so we emit few expressions
  const groups = new Map();
  for (const [day, hours] of byDay) {
    const key = [...hours].sort((a, b) => a - b).join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(day);
  }
  const out = [];
  for (const [hours, days] of groups) {
    out.push(`* ${hours} * * ${days.sort((a, b) => a - b).join(",")}`);
  }
  out.push(maint);
  return out;
}
// rough "how many times will this fire per day" for the summary
function estimateRuns(crons) {
  let n = 0;
  for (const c of crons) {
    const [, hours, , , days] = c.split(" ");
    const h = hours === "*" ? 24 : hours.split(",").length;
    const d = days === "*" ? 7 : days.split(",").length;
    n += h * 60 * d / 7;
  }
  return Math.round(n);
}
function markHour(byDay, day, minutes, offset) {
  let utcMin = minutes - offset * 60;
  let utcDay = day;
  if (utcMin < 0) { utcMin += 1440; utcDay = (utcDay + 6) % 7; }
  else if (utcMin >= 1440) { utcMin -= 1440; utcDay = (utcDay + 1) % 7; }
  if (!byDay.has(utcDay)) byDay.set(utcDay, new Set());
  byDay.get(utcDay).add(Math.floor(utcMin / 60));
}
function athensUtcOffsetHours() {
  // +2 in winter, +3 in summer — ask Intl rather than hard-coding DST rules
  const d = new Date();
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const ath = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Athens" }));
  return Math.round((ath - utc) / 3600000);
}

async function runAlerts(env) {
  if (!pushReady(env)) return;
  const now = athensNow();

  const rules = (await readRules(env)).filter(r => r && r.enabled !== false);
  if (!rules.length) return;

  // Only rules whose window is near enough to matter right now.
  const active = rules.filter(r => {
    if (!Array.isArray(r.days) || !r.days.includes(now.day)) return false;
    const from = hhmmToMin(r.from), to = hhmmToMin(r.to);
    if (from == null || to == null) return false;
    const maxLead = Math.max(...(r.leads || [10]));
    return now.minutes >= from - maxLead - 1 && now.minutes <= to;
  });
  if (!active.length) return;

  // One arrivals fetch per distinct stop.
  const byStop = {};
  for (const r of active) (byStop[r.stopCode] ||= []).push(r);

  for (const [stopCode, stopRules] of Object.entries(byStop)) {
    const arrivals = await getJSON(`${OASA}?act=getStopArrivals&p1=${encodeURIComponent(stopCode)}`, 0);
    if (!Array.isArray(arrivals)) continue;

    for (const rule of stopRules) {
      const from = hhmmToMin(rule.from), to = hhmmToMin(rule.to);
      const leads = (rule.leads || [10, 5]).slice().sort((a, b) => b - a);
      const codes = (rule.routeCodes || []).map(String);

      for (const a of arrivals) {
        const rc = String(a.route_code ?? a.RouteCode ?? "");
        if (codes.length && !codes.includes(rc)) continue;
        const min = parseInt(a.btime2 ?? a.btime ?? "", 10);
        if (!isFinite(min)) continue;

        // Does this bus reach the stop inside the user's window?
        const eta = now.minutes + min;
        if (eta < from - 1 || eta > to) continue;

        const applicable = leads.filter(L => min <= L);
        if (!applicable.length) continue;

        const veh = String(a.veh_code ?? a.VEH_NO ?? rc);
        const unsent = [];
        for (const L of applicable) {
          const k = `sent:${rule.id}:${veh}:${L}`;
          if (!(await env.ALERTS.get(k))) unsent.push([k, L]);
        }
        if (!unsent.length) continue;

        const etaClock = (() => {
          const t = (eta % (24 * 60) + 24 * 60) % (24 * 60);
          return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
        })();

        // Which lead is actually firing: the tightest one still unsent.
        // It goes in the TAG, because a notification reusing an existing
        // tag REPLACES it — and phones commonly do that update silently.
        // With one tag per rule+vehicle only the first of a 15/10/5 set
        // ever rang; per-lead tags make each one its own notification.
        const firingLead = Math.min(...unsent.map(([, L]) => L));
        try {
          const sub = await env.ALERTS.get(`sub:${rule.sub}`, "json");
          if (sub) {
            await sendPush(sub, {
              title: `${rule.lineId || "Λεωφορείο"} σε ${min}′`,
              body: `${rule.stopName || ""}${rule.routeName ? " · " + rule.routeName : ""} — άφιξη ~${etaClock}`,
              tag: `${rule.id}:${veh}:${firingLead}`,
              lead: firingLead,
              url: "./",
            }, env);
            await setMeta(env, "alert_last", Math.floor(Date.now() / 1000));
            try { await bumpUsage(env, ["alert"]); } catch (_) {}
          }
        } catch (_) { /* keep going */ }

        for (const [k] of unsent) {
          await env.ALERTS.put(k, "1", { expirationTtl: 3600 });
        }
      }
    }
  }
}

/* ==================== vehicle tracking (D1) ======================= *
 * Instead of logging raw GPS pings (huge, mostly redundant), the cron
 * snaps each vehicle to its nearest stop and records ONE row when a bus
 * actually reaches a new stop. That single event stream feeds all three
 * analyses: headway regularity, bunching, and missing/ghost trips.
 * ------------------------------------------------------------------ */
const TRACK = {
  snapM: 150,        // how close a vehicle must be to count as "at" a stop
  maxRoutes: 8,      // cap tracked routes so we stay inside free-tier writes
  retentionDays: 45,
  minGapS: 45,       // debounce: ignore re-triggers faster than this
  bunchMin: 2,       // gap <= 2 min counts as bunching
  gapFactor: 2.5,    // gap >= 2.5x median counts as missing service
  gapMinMin: 12,
};

function hav(a1, o1, a2, o2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dA = r(a2 - a1), dO = r(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function dbReady(env) { return !!(env && env.DB); }

let schemaDone = false;
async function initSchema(env) {
  if (schemaDone) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS tracked_route(route_code TEXT PRIMARY KEY, line_id TEXT,
       line_code TEXT, descr TEXT, added_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS route_stops(route_code TEXT PRIMARY KEY, stops_json TEXT,
       updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS veh_state(veh TEXT, route_code TEXT, seq INTEGER, ts INTEGER,
       PRIMARY KEY(veh, route_code))`,
    `CREATE TABLE IF NOT EXISTS stop_event(id INTEGER PRIMARY KEY AUTOINCREMENT, route_code TEXT,
       line_id TEXT, veh TEXT, stop_code TEXT, seq INTEGER, ts INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ix_ev_route_ts ON stop_event(route_code, ts)`,
    `CREATE INDEX IF NOT EXISTS ix_ev_stop ON stop_event(route_code, stop_code, ts)`,
    `CREATE TABLE IF NOT EXISTS sched_dep(line_code TEXT, dir TEXT, hhmm INTEGER,
       PRIMARY KEY(line_code, dir, hhmm))`,
    `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
    // Append-only history of every community report ever filed (the KV
    // side only keeps ACTIVE flags). This is what future statistics —
    // "which line gets the most breakdown reports" — will read from.
    `CREATE TABLE IF NOT EXISTS report_log(id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts INTEGER, kind TEXT, type TEXT, target_id TEXT, target_name TEXT,
       line_id TEXT, route_code TEXT, renewed INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ix_rl_ts ON report_log(ts)`,
    `CREATE INDEX IF NOT EXISTS ix_rl_target ON report_log(kind, target_id, ts)`,
    // How busy the app is, and nothing else. One row per day per kind,
    // holding a number. See the note above `bumpUsage`.
    `CREATE TABLE IF NOT EXISTS usage(day TEXT, kind TEXT, n INTEGER,
       PRIMARY KEY(day, kind))`,
  ];
  await env.DB.batch(stmts.map(s => env.DB.prepare(s)));
  schemaDone = true;
}

/* ======================== how busy it is ========================== *
 * A counter, deliberately not analytics.
 *
 * What is stored is one integer per day per kind — "2026-09-07, open,
 * 412". No identifier of any sort touches the row: no IP, no device
 * token, no user agent, no session, no coordinates, nothing hashed that
 * could stand in for a person. That is a real constraint, not a framing
 * one, and it has a consequence worth stating plainly at the top of the
 * file that implements it: **this cannot count people.** Two opens by
 * one rider and one open each by two riders are the same number here,
 * and no amount of later querying will separate them. It answers "is
 * anyone using this, and is that going up" — which is the question — and
 * refuses to answer "who".
 *
 * `open` counts cold boots. `open_app` counts the subset launched from a
 * home-screen icon rather than a browser tab, which is the closest thing
 * to an install figure that does not require tracking anybody: an
 * installed app that is never opened is not counted, which is arguably
 * the more useful number anyway. `install` counts the browser's own
 * `appinstalled` event, so it is new installs on the day they happen.
 *
 * Lives in D1, not KV: a counter that writes on every app open would eat
 * the 1 000/day KV write ceiling by lunchtime, while D1's is 100 000.
 * Without a D1 binding the endpoint accepts the beacon and drops it, so
 * an install without a database is not broken, just uncounted.
 * ------------------------------------------------------------------ */
/* "cron" is every minute the scheduler woke us; "alert" is every push
   actually handed to a push service. Together they answer the question the
   app could not answer before: is this thing running, and has it ever
   delivered anything? */
const USAGE_KINDS = new Set(["open", "open_app", "install", "cron", "alert"]);
function dayKey(ms) {
  // Athens, so "yesterday" means what a person in Athens means by it
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric",
    month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
async function bumpUsage(env, kinds) {
  if (!dbReady(env)) return false;
  await initSchema(env);
  const day = dayKey(Date.now());
  await env.DB.batch(kinds.map(k => env.DB
    .prepare(`INSERT INTO usage(day, kind, n) VALUES(?, ?, 1)
              ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`)
    .bind(day, k)));
  return true;
}
/* One row, overwritten. D1 allows 100k writes a day and the cron is 1,440
   of them at most, so a heartbeat is affordable where a KV write (1,000 a
   day, shared with every filed report) would not be. */
async function setMeta(env, k, v) {
  if (!dbReady(env)) return;
  try {
    await initSchema(env);
    await env.DB.prepare(
      "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .bind(k, String(v)).run();
  } catch (_) { /* a heartbeat must never break the run it is timing */ }
}
async function getMeta(env, k) {
  if (!dbReady(env)) return null;
  try {
    await initSchema(env);
    const r = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first();
    return r ? r.v : null;
  } catch (_) { return null; }
}

async function readUsage(env, days) {
  if (!dbReady(env)) return null;
  await initSchema(env);
  const since = dayKey(Date.now() - (days - 1) * 86400e3);
  const rows = (await env.DB.prepare(
    `SELECT day, kind, n FROM usage WHERE day >= ? ORDER BY day DESC`)
    .bind(since).all()).results || [];
  const byDay = {};
  for (const r of rows) (byDay[r.day] = byDay[r.day] || {})[r.kind] = r.n;
  const total = {};
  for (const r of rows) total[r.kind] = (total[r.kind] || 0) + r.n;
  return { since, days, total, byDay };
}

async function stopsForRoute(env, routeCode) {
  const row = await env.DB.prepare("SELECT stops_json, updated_at FROM route_stops WHERE route_code=?")
    .bind(routeCode).first();
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  if (row && row.updated_at > weekAgo) { try { return JSON.parse(row.stops_json); } catch { } }
  const raw = await getJSON(`${OASA}?act=webGetStops&p1=${encodeURIComponent(routeCode)}`, 86400);
  const stops = (Array.isArray(raw) ? raw : []).map(x => ({
    code: String(x.StopCode ?? x.StopID ?? ""),
    name: x.StopDescr ?? "",
    lat: Number(x.StopLat ?? x.StopY),
    lng: Number(x.StopLng ?? x.StopX),
  })).filter(s => s.code && isFinite(s.lat) && isFinite(s.lng));
  if (stops.length) {
    await env.DB.prepare(`INSERT INTO route_stops(route_code, stops_json, updated_at) VALUES(?,?,?)
      ON CONFLICT(route_code) DO UPDATE SET stops_json=excluded.stops_json, updated_at=excluded.updated_at`)
      .bind(routeCode, JSON.stringify(stops), Math.floor(Date.now() / 1000)).run();
  }
  return stops;
}

async function sampleVehicles(env) {
  if (!dbReady(env)) return { sampled: 0, events: 0 };
  await initSchema(env);
  const { results: routes } = await env.DB.prepare(
    "SELECT route_code, line_id FROM tracked_route LIMIT ?").bind(TRACK.maxRoutes).all();
  if (!routes || !routes.length) return { sampled: 0, events: 0 };

  const now = Math.floor(Date.now() / 1000);
  let events = 0;

  for (const r of routes) {
    const stops = await stopsForRoute(env, r.route_code);
    if (!stops.length) continue;
    const buses = await getJSON(
      `${OASA}?act=getBusLocation&p1=${encodeURIComponent(r.route_code)}`, 0);
    if (!Array.isArray(buses) || !buses.length) continue;

    const { results: st } = await env.DB.prepare(
      "SELECT veh, seq, ts FROM veh_state WHERE route_code=?").bind(r.route_code).all();
    const state = {};
    (st || []).forEach(x => { state[String(x.veh)] = { seq: x.seq, ts: x.ts }; });

    const batch = [];
    for (const b of buses) {
      const veh = String(b.VEH_NO ?? b.veh_no ?? b.VEH_CODE ?? "");
      const la = Number(b.CS_LAT ?? b.cs_lat), ln = Number(b.CS_LNG ?? b.cs_lng);
      if (!veh || !isFinite(la) || !isFinite(ln)) continue;

      let bi = -1, bd = Infinity;
      for (let i = 0; i < stops.length; i++) {
        const d = hav(la, ln, stops[i].lat, stops[i].lng);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0 || bd > TRACK.snapM) continue;

      const prev = state[veh];
      if (prev && prev.seq === bi) continue;                 // still at same stop
      if (prev && now - prev.ts < TRACK.minGapS) continue;   // debounce

      batch.push(env.DB.prepare(
        `INSERT INTO stop_event(route_code, line_id, veh, stop_code, seq, ts) VALUES(?,?,?,?,?,?)`)
        .bind(r.route_code, r.line_id, veh, stops[bi].code, bi, now));
      batch.push(env.DB.prepare(
        `INSERT INTO veh_state(veh, route_code, seq, ts) VALUES(?,?,?,?)
         ON CONFLICT(veh, route_code) DO UPDATE SET seq=excluded.seq, ts=excluded.ts`)
        .bind(veh, r.route_code, bi, now));
      events++;
    }
    if (batch.length) await env.DB.batch(batch);
  }
  return { sampled: routes.length, events };
}

/* --------------------------- analytics ----------------------------- */
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Turn a sorted list of arrival timestamps at ONE stop into service quality numbers.
function analyseHeadways(tsList) {
  const ts = tsList.slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const g = (ts[i] - ts[i - 1]) / 60;
    if (g > 0 && g < 240) gaps.push(g);   // ignore overnight breaks
  }
  if (gaps.length < 2) return { samples: ts.length, gaps: gaps.length, enough: false };
  const med = median(gaps);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  const bunched = gaps.filter(g => g <= TRACK.bunchMin).length;
  const missing = gaps.filter(g => g >= Math.max(TRACK.gapMinMin, med * TRACK.gapFactor)).length;
  // "regular" = gap within +/-50% of the typical gap
  const regular = gaps.filter(g => g >= med * 0.5 && g <= med * 1.5).length;
  // Median gap lies on a bunched line (two buses together drag it toward zero),
  // so also report the gap ignoring bunched pairs...
  const spread = gaps.filter(g => g > TRACK.bunchMin);
  const typical = spread.length ? median(spread) : med;
  // ...and the wait a passenger actually experiences arriving at random:
  //   E[wait] = E[gap^2] / (2*E[gap])  — irregular service punishes this hard.
  const sumG = gaps.reduce((a, b) => a + b, 0);
  const sumG2 = gaps.reduce((a, b) => a + b * b, 0);
  const expectedWait = sumG > 0 ? sumG2 / (2 * sumG) : null;
  return {
    enough: true, samples: ts.length, gaps: gaps.length,
    medianGap: Math.round(med * 10) / 10,
    typicalGap: Math.round(typical * 10) / 10,
    expectedWait: expectedWait == null ? null : Math.round(expectedWait * 10) / 10,
    meanGap: Math.round(mean * 10) / 10,
    cv: Math.round((sd / mean) * 100) / 100,
    bunched, bunchRate: Math.round(bunched / gaps.length * 100),
    missing, missingRate: Math.round(missing / gaps.length * 100),
    regularity: Math.round(regular / gaps.length * 100),
    worstGap: Math.round(Math.max(...gaps)),
    shortestGap: Math.round(Math.min(...gaps) * 10) / 10,
  };
}

async function routeStats(env, routeCode, days) {
  await initSchema(env);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const info = await env.DB.prepare(
    "SELECT route_code, line_id, descr FROM tracked_route WHERE route_code=?").bind(routeCode).first();

  const busiest = await env.DB.prepare(
    `SELECT stop_code, COUNT(*) n FROM stop_event WHERE route_code=? AND ts>?
     GROUP BY stop_code ORDER BY n DESC LIMIT 1`).bind(routeCode, since).first();
  if (!busiest) return { route: info, days, enough: false, total: 0 };

  const { results: evs } = await env.DB.prepare(
    `SELECT ts, veh FROM stop_event WHERE route_code=? AND stop_code=? AND ts>? ORDER BY ts`)
    .bind(routeCode, busiest.stop_code, since).all();

  const total = await env.DB.prepare(
    "SELECT COUNT(*) n, COUNT(DISTINCT veh) v, MIN(ts) a, MAX(ts) b FROM stop_event WHERE route_code=? AND ts>?")
    .bind(routeCode, since).first();

  const stats = analyseHeadways((evs || []).map(e => e.ts));

  // events per hour of day, for the little activity chart
  const { results: hourly } = await env.DB.prepare(
    `SELECT CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) h, COUNT(*) n
     FROM stop_event WHERE route_code=? AND ts>? GROUP BY h ORDER BY h`)
    .bind(routeCode, since).all();

  return {
    route: info, days, measuredAt: busiest.stop_code, ...stats,
    total: total ? total.n : 0, vehicles: total ? total.v : 0,
    firstSeen: total ? total.a : null, lastSeen: total ? total.b : null,
    hourly: hourly || [],
  };
}

// Bunching incidents: two buses of the same route hitting the same stop within N minutes.
async function bunchingIncidents(env, routeCode, days, limit) {
  await initSchema(env);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await env.DB.prepare(
    `SELECT a.stop_code, a.ts t1, b.ts t2, a.veh v1, b.veh v2
     FROM stop_event a JOIN stop_event b
       ON a.route_code=b.route_code AND a.stop_code=b.stop_code
      AND b.ts > a.ts AND b.ts - a.ts <= ? AND a.veh <> b.veh
     WHERE a.route_code=? AND a.ts>?
     ORDER BY a.ts DESC LIMIT ?`)
    .bind(TRACK.bunchMin * 60, routeCode, since, limit || 40).all();
  return (results || []).map(r => ({
    stop: r.stop_code, gapSec: r.t2 - r.t1, at: r.t1, vehicles: [r.v1, r.v2],
  }));
}

// Missing service: unusually long holes at the busiest stop, during service hours.
async function missingService(env, routeCode, days, limit) {
  await initSchema(env);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const busiest = await env.DB.prepare(
    `SELECT stop_code FROM stop_event WHERE route_code=? AND ts>?
     GROUP BY stop_code ORDER BY COUNT(*) DESC LIMIT 1`).bind(routeCode, since).first();
  if (!busiest) return [];
  const { results } = await env.DB.prepare(
    `SELECT ts FROM stop_event WHERE route_code=? AND stop_code=? AND ts>? ORDER BY ts`)
    .bind(routeCode, busiest.stop_code, since).all();
  const ts = (results || []).map(r => r.ts);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const g = (ts[i] - ts[i - 1]) / 60;
    if (g > 0 && g < 240) gaps.push({ from: ts[i - 1], to: ts[i], min: g });
  }
  const med = median(gaps.map(g => g.min));
  if (med == null) return [];
  const thresh = Math.max(TRACK.gapMinMin, med * TRACK.gapFactor);
  return gaps.filter(g => g.min >= thresh)
    .sort((a, b) => b.min - a.min).slice(0, limit || 25)
    .map(g => ({ stop: busiest.stop_code, from: g.from, to: g.to,
      minutes: Math.round(g.min), typical: Math.round(med * 10) / 10 }));
}

// Pull the published timetable so ghost trips can be judged against it.
function scheduleTimes(arr) {
  const out = new Set();
  for (const row of arr || []) {
    for (const k of Object.keys(row)) {
      if (!/^sde_start/i.test(k)) continue;
      const v = row[k];
      if (typeof v !== "string") continue;
      const m = /(\d{1,2}):(\d{2})(?::\d{2})?/.exec(v);
      if (m) out.add((+m[1]) * 60 + (+m[2]));
    }
  }
  return [...out].sort((a, b) => a - b);
}
async function syncSchedules(env) {
  if (!dbReady(env)) return 0;
  await initSchema(env);
  const { results: routes } = await env.DB.prepare(
    "SELECT DISTINCT line_code FROM tracked_route WHERE line_code IS NOT NULL AND line_code<>''").all();
  let n = 0;
  for (const r of routes || []) {
    // NOTE: this endpoint takes line_code=, not p1=
    const data = await getJSON(`${OASA}?act=getDailySchedule&line_code=${encodeURIComponent(r.line_code)}`, 3600);
    if (!data) continue;
    const batch = [];
    for (const dir of ["go", "come"]) {
      for (const hhmm of scheduleTimes(data[dir])) {
        batch.push(env.DB.prepare(
          "INSERT OR IGNORE INTO sched_dep(line_code, dir, hhmm) VALUES(?,?,?)")
          .bind(r.line_code, dir, hhmm));
        n++;
      }
    }
    if (batch.length) await env.DB.batch(batch);
  }
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sched_synced',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(String(Math.floor(Date.now() / 1000))).run();
  return n;
}

/* Retention, not just housekeeping. report_log holds no coordinates and
 * no reporter id, but it is still a record of what people reported and
 * when, so it gets a stated lifetime like everything else — see
 * PRIVACY.md, which quotes these two numbers. */
const REPORT_LOG_DAYS = 90;
async function pruneOld(env) {
  if (!dbReady(env)) return;
  await initSchema(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM stop_event WHERE ts < ?")
    .bind(now - TRACK.retentionDays * 86400).run();
  await env.DB.prepare("DELETE FROM report_log WHERE ts < ?")
    .bind(now - REPORT_LOG_DAYS * 86400).run();
}

/* ===================== batch "nearby" endpoint ==================== *
 * One request instead of ~9. The client used to fetch nearby stops,
 * then a routes call and an arrivals call per stop — all from a phone,
 * each a separate round trip. Doing the fan-out here means one request
 * from the browser, and the fan-out runs edge->OASA where it's fast and
 * already cached. Responses are cached ~12s on a coarse location key so
 * users standing near each other share one result.
 * ------------------------------------------------------------------ */
function samplePts(lat, lng, r) {
  // getClosestStops has no radius parameter — it just returns the nearest few.
  // To cover a wider area we query several offset points and merge the results.
  if (r <= 400) return [[lat, lng]];
  const d = r * 0.6, dLat = d / 111320, dLng = d / (111320 * Math.cos(lat * Math.PI / 180));
  const pts = [[lat, lng],
    [lat + dLat, lng], [lat - dLat, lng], [lat, lng + dLng], [lat, lng - dLng]];
  if (r > 650) {                       // add diagonals for the widest settings
    const k = 0.71;
    pts.push([lat + dLat * k, lng + dLng * k], [lat + dLat * k, lng - dLng * k],
             [lat - dLat * k, lng + dLng * k], [lat - dLat * k, lng - dLng * k]);
  }
  return pts;
}
async function pool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const j = i++; try { await tasks[j](); } catch (_) { } }
  }));
}
function pickField(o, ...keys) {
  for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
  return null;
}

/* Some stops are decommissioned or seasonal and no line serves them any more.
 * We only learn that by fetching a stop's route list, and doing that for every
 * marker would blow the 50-subrequest cap. So each request probes a few unknown
 * stops, remembers the answer, and filters out the ones known to be dead.
 * Knowledge is shared across users via KV and re-checked after two weeks, so a
 * seasonal stop comes back on its own. Without KV it still works per-isolate. */
const STOPLINES_KEY = "stops:lines";
const STOPLINES_TTL = 14 * 86400;
let slMem = null, slDirty = false;

async function loadStopLines(env) {
  if (slMem) return slMem;
  slMem = new Map();
  if (env && env.ALERTS) {
    try {
      const o = await env.ALERTS.get(STOPLINES_KEY, "json");
      if (o && typeof o === "object") for (const k in o) slMem.set(k, o[k]);
    } catch (_) { }
  }
  return slMem;
}
async function saveStopLines(env) {
  if (!slDirty || !env || !env.ALERTS) return;
  slDirty = false;
  const o = {};
  for (const [k, v] of slMem) o[k] = v;
  try { await env.ALERTS.put(STOPLINES_KEY, JSON.stringify(o)); } catch (_) { }
}
function slGet(map, code, now) {
  const e = map.get(code);
  if (!e || (now - (e.t || 0)) > STOPLINES_TTL) return null;   // unknown or stale
  return e.n;                                                   // line count
}
function slSet(map, code, n, now) { map.set(code, { n, t: now }); slDirty = true; }

// Fetch a stop's routes; returns null if the call failed (so we don't record
// a transient failure as "this stop is dead").
async function fetchStopRoutes(code) {
  const raw = await getJSON(
    `${OASA}?act=webRoutesForStop&p1=${encodeURIComponent(code)}`, ACT_TTL.webRoutesForStop);
  if (!Array.isArray(raw)) return null;
  const routes = [], lines = [], seen = new Set();
  for (const r of raw) {
    const rc = pickField(r, "RouteCode", "route_code"); if (rc == null) continue;
    const id = pickField(r, "LineID", "line_id", "LineCode", "line_code");
    const el = pickField(r, "RouteDescr", "route_descr", "LineDescr", "line_descr");
    const en = pickField(r, "RouteDescrEng", "route_descr_eng", "LineDescrEng", "line_descr_eng");
    routes.push({ code: String(rc), id: String(id || rc), el, en });
    const key = String(id || rc);
    if (id && !seen.has(key)) { seen.add(key); lines.push({ id: String(id), el, en }); }
  }
  lines.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return { routes, lines };
}

async function handleNearby(url, env, ctx) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng required" }, 400);
  const radius = Math.min(2000, Math.max(200, +(url.searchParams.get("radius") || 600)));
  const limit = Math.min(16, Math.max(1, +(url.searchParams.get("limit") || 14)));
  const markers = Math.min(150, Math.max(limit, +(url.searchParams.get("markers") || 60)));
  // Map pins show the stop name now, so line metadata is only needed for the
  // stops the list renders. Everything else lazy-loads when its popup opens.
  const withRoutes = limit;

  /* Favourites pinned outside the nearby set used to cost the client one
     request each, every sweep: three far favourites quadrupled a session's
     traffic. They ride along here instead.
     They are deliberately NOT part of the cache key. Everyone standing on
     one corner shares the expensive half of this response, and folding a
     personal list into that key would fragment the cache per user and cost
     far more than it saves. So the cached body stays public, and the
     favourites are resolved per request and merged on the way out. */
  const favCodes = String(url.searchParams.get("favs") || "")
    .split(",").map(x => x.trim()).filter(Boolean).slice(0, 8);

  // ~110m cache granularity, so a whole street corner shares one response
  const ck = `https://nearby/?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}&r=${radius}&l=${limit}&m=${markers}`;
  const cache = caches.default;
  const hit = await cache.match(new Request(ck));
  if (hit) {
    if (!favCodes.length) return withCors(hit);
    let body = null;
    try { body = await hit.json(); } catch (_) { }
    if (!body) return withCors(hit);
    body.favs = await farFavourites(favCodes, body.stops, lat, lng);
    return json(body);
  }

  const lists = await Promise.all(samplePts(lat, lng, radius).map(p =>
    getJSON(`${OASA}?act=getClosestStops&p1=${p[0]}&p2=${p[1]}`, ACT_TTL.getClosestStops)));

  const seen = {};
  for (const arr of lists) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const code = String(pickField(s, "StopCode", "StopID", "stop_code") || "");
      if (code && !seen[code]) seen[code] = s;
    }
  }
  let stops = Object.values(seen).map(s => {
    const la = Number(pickField(s, "StopLat", "StopY", "stop_lat"));
    const ln = Number(pickField(s, "StopLng", "StopX", "stop_lng"));
    return {
      code: String(pickField(s, "StopCode", "StopID", "stop_code") || ""),
      name_el: pickField(s, "StopDescr", "StopDescrEng") || "",
      name_en: pickField(s, "StopDescrEng", "StopDescr") || "",
      street: pickField(s, "StopStreet", "StopStreetEng") || "",
      lat: la, lng: ln,
      // the API's own "distance" isn't metres — compute the real thing
      dist: (isFinite(la) && isFinite(ln)) ? hav(lat, lng, la, ln) : Infinity,
      lines: [], routes: [], arrivals: [], detail: false,
    };
  }).filter(s => s.code && isFinite(s.dist) && s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, markers);

  // Resolve line info: always for the stops the list shows, then probe as many
  // unknown ones as the subrequest budget allows.
  const now = Math.floor(Date.now() / 1000);
  const known = await loadStopLines(env);
  // stop-lists + arrivals, plus up to two calls for each far favourite
  const used = samplePts(lat, lng, radius).length + limit + favCodes.length * 2;
  let probeBudget = Math.max(0, 44 - used - withRoutes);

  const mustLoad = stops.slice(0, withRoutes);
  await pool(mustLoad.map(s => async () => {
    const r = await fetchStopRoutes(s.code);
    if (!r) return;
    s.routes = r.routes; s.lines = r.lines; s.resolved = true;
    slSet(known, s.code, r.lines.length, now);
  }), 6);

  const probes = [];
  for (const s of stops) {
    if (s.resolved) continue;
    const n = slGet(known, s.code, now);
    if (n != null) { s.lineCount = n; continue; }               // already known
    if (probes.length < probeBudget) probes.push(s);
  }
  await pool(probes.map(s => async () => {
    const r = await fetchStopRoutes(s.code);
    if (!r) return;
    s.routes = r.routes; s.lines = r.lines; s.resolved = true;
    s.lineCount = r.lines.length;
    slSet(known, s.code, r.lines.length, now);
  }), 6);

  // Drop stops we know no line serves any more. Unknown ones stay visible —
  // better to show a stop we haven't checked than to hide a real one.
  const before = stops.length;
  stops = stops.filter(s => {
    const n = s.resolved ? s.lines.length : (s.lineCount != null ? s.lineCount : null);
    return n === null || n > 0;
  });
  const hidden = before - stops.length;
  if (ctx && slDirty) ctx.waitUntil(saveStopLines(env));

  // live arrivals only for the stops actually shown in the list
  await pool(stops.slice(0, limit).map(s => async () => {
    const raw = await getJSON(
      `${OASA}?act=getStopArrivals&p1=${encodeURIComponent(s.code)}`, ACT_TTL.getStopArrivals);
    s.arrivals = (Array.isArray(raw) ? raw : [])
      .map(a => ({
        code: String(pickField(a, "route_code", "RouteCode") || ""),
        veh: String(pickField(a, "veh_code", "VEH_NO", "veh_no") || ""),
        min: parseInt(pickField(a, "btime2", "btime", "stop_time") || "", 10),
      }))
      .filter(a => isFinite(a.min))
      .sort((x, y) => x.min - y.min);
    s.detail = true;
  }), 6);

  for (const s of stops) { delete s.resolved; delete s.lineCount; }

  // Piggy-back the active community flags so the app can badge and
  // annotate rows without a second request. Public view only — the
  // response is edge-cached and shared, so no `mine` marking here.
  let reports = [];
  if (env && env.ALERTS) {
    try {
      reports = publicList(await readReports(env, now), "");
    } catch (_) { }
  }

  const res = new Response(JSON.stringify({
    origin: { lat, lng }, radius, generated: now, hidden, stops, reports,
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ACT_TTL.getStopArrivals}`,
      ...CORS,
    },
  });
  await cache.put(new Request(ck), res.clone());
  if (!favCodes.length) return res;
  // the shared body goes in the cache; the personal one goes back to you
  const body = JSON.parse(await res.clone().text());
  body.favs = await farFavourites(favCodes, stops, lat, lng);
  return json(body);
}

/* A favourite the nearby sweep did not return — your home stop while you
 * are at work. Same shape as an entry in `stops`, so the client can drop
 * it straight into place. Only the genuinely missing ones are fetched; a
 * favourite you happen to be standing next to is already in the list. */
async function farFavourites(codes, stops, lat, lng) {
  const have = new Set((stops || []).map(s => String(s.code)));
  const missing = codes.filter(c => !have.has(String(c)));
  if (!missing.length) return [];
  const out = [];
  await pool(missing.map(code => async () => {
    const r = await fetchStopRoutes(code);
    if (!r) return;
    const raw = await getJSON(
      `${OASA}?act=getStopArrivals&p1=${encodeURIComponent(code)}`, ACT_TTL.getStopArrivals);
    const arrivals = (Array.isArray(raw) ? raw : [])
      .map(a => ({
        code: String(pickField(a, "route_code", "RouteCode") || ""),
        veh: String(pickField(a, "veh_code", "VEH_NO", "VEH_CODE") || ""),
        min: parseInt(pickField(a, "btime2", "btime", "stop_time") || "999", 10),
      }))
      .filter(a => isFinite(a.min))
      .sort((x, y) => x.min - y.min);
    out.push({ code: String(code), routes: r.routes, lines: r.lines, arrivals, detail: true });
  }), 4);
  return out;
}

/* ====================== user reports (KV) ========================= *
 * Community flags attached to a specific bus or metro station. The types
 * and their categories are defined just below; how long each one lives is
 * the TTL table further down, since a broken lift outlasts a member of
 * staff who has moved on.
 *
 * Rules:
 *   - re-reporting the same target+type renews the flag
 *   - a report can be withdrawn ONLY by the reporter who filed it
 *     (or it simply expires). Reporter ids ("by") are random
 *     client-side tokens and are never echoed back — GET /reports only
 *     marks the caller's own rows with mine:true — so nobody can forge
 *     someone else's withdrawal.
 *
 * Storage mirrors the alert rules: everything lives in ONE KV key,
 * read with a plain get and pruned on every touch — zero list ops.
 * ------------------------------------------------------------------ */
const REPORTS_KEY = "reports:index";
/* What may be flagged, and with what. A rider reports from inside a
 * surface vehicle — bus or trolley, both the "bus" kind here — or
 * standing at a metro station. Those are the two TARGET kinds.
 *
 * There is no category split. Every flag is one colour and reads as one
 * thing: something a rider on the network would want to know before they
 * get there. Sorting them into "problems" and "operational" made people
 * decode a palette before reading a word that was already on the screen.
 *
 * Entries stay factual and staff-agnostic. "OASA staff on this line" is
 * service information of the same kind as "this bus has no air
 * conditioning". The app reports situations, not people — there is no
 * free text, no photo, no description, and nothing identifying an
 * individual. Mirrored in the app's TYPES_BY_KIND; keep the two in sync. */
const REPORT_TYPES = {
  bus:   new Set(["breakdown", "crowded", "noac", "security", "staff"]),
  metro: new Set(["lift", "escalator", "nowheel", "crowded", "security", "staff"]),
};

/* How long a flag lives, in seconds, by target kind and type. The split
 * is about how fast the thing stops being true: staff ride a few stops on
 * a bus but work a station for hours; a crowded platform clears in
 * minutes while a crowded bus stays crowded for its whole run; a broken
 * lift or escalator lasts the day, and a station with no step-free route
 * is a fact about the building, not about this morning. Documented in
 * PARAMETERS.md.
 *
 * Types retired in v44 (`fare`, and `inspector` before it) are absent on
 * purpose: rows already in KV fall through to DEFAULT_TTL and age out
 * within the hour, and no new one can be filed. */
const TTL = {
  bus:   { breakdown: 3600, crowded: 3600, noac: 3600,
           security: 1800, staff: 1800 },
  metro: { lift: 7200, escalator: 7200, nowheel: 10800, crowded: 1800,
           security: 7200, staff: 7200 },
};
const DEFAULT_TTL = 3600;
const MAX_ACTIVE_PER_REPORTER = 2;

/* ------------------------ trust model ------------------------------ *
 * Every report is taken at face value. There is no confirmation tier and
 * no voting: a rider who files a flag is believed, and the flag stands
 * until it expires or its author withdraws it.
 *
 * What replaces corroboration as a signal is simply the COUNT. Each
 * reporter files their own record for a target (that is what keeps
 * withdrawal rights per-person), so the number of records sharing
 * kind+targetId+type IS the number of distinct people reporting the same
 * thing. The apps groups them into one marker and shows that number, so
 * "4 reports" reads as stronger than "1" without anyone having to vote.
 *
 * The remaining abuse controls are blunt and cheap: MAX_ACTIVE_PER_REPORTER
 * caps how many flags one device can hold up at once, per-IP rate limits
 * cap how fast they arrive, and every flag expires on its own. A false
 * flag can still be cleared by its author or by the admin purge.
 * ------------------------------------------------------------------ */
function reportTtl(r) {
  return (TTL[r.kind] && TTL[r.kind][r.type]) || DEFAULT_TTL;
}
function reportsReady(env) { return !!(env && env.ALERTS); }

async function readReports(env, now) {
  const all = await env.ALERTS.get(REPORTS_KEY, "json");
  if (!Array.isArray(all)) return [];
  return all.filter(r => r && r.at + reportTtl(r) > now);
}
async function writeReports(env, list) {
  await env.ALERTS.put(REPORTS_KEY, JSON.stringify(list));
}
/* What clients see: everything except the reporter token. `mine` unlocks
   the ✕. `count` is how many distinct people have filed this same flag —
   one record per person per target+type, so the group size is the head
   count. The client groups by the same key to draw one marker. */
function publicReport(r, by, count) {
  const out = {
    id: r.id, kind: r.kind, type: r.type,
    veh: r.veh || null, routeCode: r.routeCode || null, lineId: r.lineId || null,
    targetId: r.targetId, targetName: r.targetName || "",
    lat: r.lat, lng: r.lng, at: r.at, expires: r.at + reportTtl(r),
    count: count || 1,
  };
  if (by && r.by === by) out.mine = true;
  return out;
}
/* The identity of a flag: same thing wrong with the same vehicle/station. */
function reportKey(r) { return `${r.kind}|${r.targetId}|${r.type}`; }
function countByKey(list) {
  const n = new Map();
  for (const r of list) n.set(reportKey(r), (n.get(reportKey(r)) || 0) + 1);
  return n;
}
function publicList(list, by) {
  const n = countByKey(list);
  return list.map(r => publicReport(r, by, n.get(reportKey(r))));
}

/* Every filed (or renewed) report also lands in D1's report_log —
 * fire-and-forget, so a missing DB binding costs nothing. */
async function logReport(env, r, now, renewed) {
  if (!dbReady(env)) return;
  try {
    await initSchema(env);
    await env.DB.prepare(
      `INSERT INTO report_log(ts, kind, type, target_id, target_name, line_id, route_code, renewed)
       VALUES(?,?,?,?,?,?,?,?)`)
      .bind(now, r.kind, r.type, r.targetId, r.targetName || "", r.lineId || "",
        r.routeCode || "", renewed ? 1 : 0).run();
  } catch (_) { /* stats are best-effort */ }
}

async function handleReports(req, url, env, ctx) {
  if (!reportsReady(env)) return json({ error: "reports not configured" }, 501);
  const now = Math.floor(Date.now() / 1000);

  if (req.method === "GET") {
    const by = url.searchParams.get("by") || "";
    return json(publicList(await readReports(env, now), by));
  }

  const b = await req.json().catch(() => null);
  if (!b) return json({ error: "bad body" }, 400);
  const by = String(b.by || "");
  if (by.length < 8 || by.length > 80) return json({ error: "by required" }, 400);

  const active = await readReports(env, now);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.endsWith("/reports/delete")) {
    const i = active.findIndex(r => r.id === b.id);
    if (i < 0) return json({ error: "not found" }, 404);
    if (active[i].by !== by) return json({ error: "not yours" }, 403);
    active.splice(i, 1);
    await writeReports(env, active);
    return json({ ok: true });
  }

  // create / renew
  const kind = String(b.kind || "");
  const type = String(b.type || "");
  const targetId = String(b.targetId || "").slice(0, 60);
  if (!REPORT_TYPES[kind] || !targetId) return json({ error: "bad target" }, 400);
  if (!REPORT_TYPES[kind].has(type)) return json({ error: "bad type" }, 400);
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng required" }, 400);

  const fields = {
    kind, type, targetId, lat, lng,
    targetName: String(b.targetName || "").slice(0, 120),
    veh: b.veh ? String(b.veh).slice(0, 20) : null,
    routeCode: b.routeCode ? String(b.routeCode).slice(0, 20) : null,
    lineId: b.lineId ? String(b.lineId).slice(0, 20) : null,
  };
  // (No free-text note in this version — anything sent is ignored.)

  // Same reporter re-flagging the same thing renews it; a different
  // reporter files their own record, which keeps withdrawal rights
  // separate per user AND is what makes the head count meaningful.
  const mine = active.find(r =>
    r.by === by && r.kind === kind && r.type === type && r.targetId === targetId);
  if (mine) {
    Object.assign(mine, fields, { at: now });
    await writeReports(env, active);
    if (ctx) ctx.waitUntil(logReport(env, mine, now, true));
    return json(publicReport(mine, by, countByKey(active).get(reportKey(mine))));
  }
  if (active.filter(r => r.by === by).length >= MAX_ACTIVE_PER_REPORTER) {
    return json({ error: "too many active reports" }, 429);
  }

  const rec = { id: crypto.randomUUID(), by, at: now, ...fields };
  active.push(rec);
  await writeReports(env, active);
  if (ctx) ctx.waitUntil(logReport(env, rec, now, false));
  return json(publicReport(rec, by, countByKey(active).get(reportKey(rec))));
}

/* ===================== Athens metro stations ====================== *
 * Static list (lines M1/M2/M3) so reports can be pinned to a metro
 * station too. Coordinates are close approximations of the station
 * entrances — tweak freely, nothing else depends on them.
 * ------------------------------------------------------------------ */
const METRO_STATIONS = [
  // Line 1 (ISAP, green): Piraeus → Kifissia
  { id: "m-peiraias",        el: "Πειραιάς",             en: "Piraeus",              lines: ["1", "3"], lat: 37.9481, lng: 23.6430 },
  { id: "m-faliro",          el: "Φάληρο",               en: "Faliro",               lines: ["1"], lat: 37.9451, lng: 23.6653 },
  { id: "m-moschato",        el: "Μοσχάτο",              en: "Moschato",             lines: ["1"], lat: 37.9550, lng: 23.6800 },
  { id: "m-kallithea",       el: "Καλλιθέα",             en: "Kallithea",            lines: ["1"], lat: 37.9603, lng: 23.6973 },
  { id: "m-tavros",          el: "Ταύρος",               en: "Tavros",               lines: ["1"], lat: 37.9626, lng: 23.7035 },
  { id: "m-petralona",       el: "Πετράλωνα",            en: "Petralona",            lines: ["1"], lat: 37.9686, lng: 23.7093 },
  { id: "m-thiseio",         el: "Θησείο",               en: "Thiseio",              lines: ["1"], lat: 37.9767, lng: 23.7207 },
  { id: "m-monastiraki",     el: "Μοναστηράκι",          en: "Monastiraki",          lines: ["1", "3"], lat: 37.9761, lng: 23.7256 },
  { id: "m-omonoia",         el: "Ομόνοια",              en: "Omonia",               lines: ["1", "2"], lat: 37.9843, lng: 23.7281 },
  { id: "m-viktoria",        el: "Βικτώρια",             en: "Victoria",             lines: ["1"], lat: 37.9932, lng: 23.7304 },
  { id: "m-attiki",          el: "Αττική",               en: "Attiki",               lines: ["1", "2"], lat: 37.9994, lng: 23.7223 },
  { id: "m-agios-nikolaos",  el: "Άγιος Νικόλαος",       en: "Agios Nikolaos",       lines: ["1"], lat: 38.0069, lng: 23.7275 },
  { id: "m-kato-patisia",    el: "Κάτω Πατήσια",         en: "Kato Patisia",         lines: ["1"], lat: 38.0111, lng: 23.7288 },
  { id: "m-agios-eleftherios", el: "Άγιος Ελευθέριος",   en: "Agios Eleftherios",    lines: ["1"], lat: 38.0177, lng: 23.7318 },
  { id: "m-ano-patisia",     el: "Άνω Πατήσια",          en: "Ano Patisia",          lines: ["1"], lat: 38.0238, lng: 23.7360 },
  { id: "m-perissos",        el: "Περισσός",             en: "Perissos",             lines: ["1"], lat: 38.0326, lng: 23.7448 },
  { id: "m-pefkakia",        el: "Πευκάκια",             en: "Pefkakia",             lines: ["1"], lat: 38.0370, lng: 23.7500 },
  { id: "m-nea-ionia",       el: "Νέα Ιωνία",            en: "Nea Ionia",            lines: ["1"], lat: 38.0413, lng: 23.7550 },
  { id: "m-irakleio",        el: "Ηράκλειο",             en: "Irakleio",             lines: ["1"], lat: 38.0462, lng: 23.7660 },
  { id: "m-eirini",          el: "Ειρήνη",               en: "Irini",                lines: ["1"], lat: 38.0437, lng: 23.7830 },
  { id: "m-neratziotissa",   el: "Νερατζιώτισσα",        en: "Neratziotissa",        lines: ["1"], lat: 38.0450, lng: 23.7929 },
  { id: "m-marousi",         el: "Μαρούσι",              en: "Marousi",              lines: ["1"], lat: 38.0560, lng: 23.8080 },
  { id: "m-kat",             el: "ΚΑΤ",                  en: "KAT",                  lines: ["1"], lat: 38.0660, lng: 23.8040 },
  { id: "m-kifisia",         el: "Κηφισιά",              en: "Kifisia",              lines: ["1"], lat: 38.0736, lng: 23.8080 },
  // Line 2 (red): Anthoupoli → Elliniko
  { id: "m-anthoupoli",      el: "Ανθούπολη",            en: "Anthoupoli",           lines: ["2"], lat: 38.0170, lng: 23.6910 },
  { id: "m-peristeri",       el: "Περιστέρι",            en: "Peristeri",            lines: ["2"], lat: 38.0130, lng: 23.6960 },
  { id: "m-agios-antonios",  el: "Άγιος Αντώνιος",       en: "Agios Antonios",       lines: ["2"], lat: 38.0067, lng: 23.6997 },
  { id: "m-sepolia",         el: "Σεπόλια",              en: "Sepolia",              lines: ["2"], lat: 38.0025, lng: 23.7134 },
  { id: "m-stathmos-larisis", el: "Σταθμός Λαρίσης",     en: "Larissa Station",      lines: ["2"], lat: 37.9922, lng: 23.7210 },
  { id: "m-metaxourgeio",    el: "Μεταξουργείο",         en: "Metaxourgeio",         lines: ["2"], lat: 37.9862, lng: 23.7211 },
  { id: "m-panepistimio",    el: "Πανεπιστήμιο",         en: "Panepistimio",         lines: ["2"], lat: 37.9802, lng: 23.7330 },
  { id: "m-syntagma",        el: "Σύνταγμα",             en: "Syntagma",             lines: ["2", "3"], lat: 37.9755, lng: 23.7353 },
  { id: "m-akropoli",        el: "Ακρόπολη",             en: "Acropoli",             lines: ["2"], lat: 37.9686, lng: 23.7295 },
  { id: "m-syngrou-fix",     el: "Συγγρού-Φιξ",          en: "Syngrou-Fix",          lines: ["2"], lat: 37.9642, lng: 23.7265 },
  { id: "m-neos-kosmos",     el: "Νέος Κόσμος",          en: "Neos Kosmos",          lines: ["2"], lat: 37.9578, lng: 23.7285 },
  { id: "m-agios-ioannis",   el: "Άγιος Ιωάννης",        en: "Agios Ioannis",        lines: ["2"], lat: 37.9569, lng: 23.7345 },
  { id: "m-dafni",           el: "Δάφνη",                en: "Dafni",                lines: ["2"], lat: 37.9493, lng: 23.7373 },
  { id: "m-agios-dimitrios", el: "Άγιος Δημήτριος",      en: "Agios Dimitrios",      lines: ["2"], lat: 37.9403, lng: 23.7407 },
  { id: "m-ilioupoli",       el: "Ηλιούπολη",            en: "Ilioupoli",            lines: ["2"], lat: 37.9302, lng: 23.7448 },
  { id: "m-alimos",          el: "Άλιμος",               en: "Alimos",               lines: ["2"], lat: 37.9180, lng: 23.7449 },
  { id: "m-argyroupoli",     el: "Αργυρούπολη",          en: "Argyroupoli",          lines: ["2"], lat: 37.9032, lng: 23.7458 },
  { id: "m-elliniko",        el: "Ελληνικό",             en: "Elliniko",             lines: ["2"], lat: 37.8927, lng: 23.7473 },
  // Line 3 (blue): Dimotiko Theatro → Airport
  { id: "m-dimotiko-theatro", el: "Δημοτικό Θέατρο",     en: "Dimotiko Theatro",     lines: ["3"], lat: 37.9429, lng: 23.6468 },
  { id: "m-maniatika",       el: "Μανιάτικα",            en: "Maniatika",            lines: ["3"], lat: 37.9535, lng: 23.6400 },
  { id: "m-nikaia",          el: "Νίκαια",               en: "Nikaia",               lines: ["3"], lat: 37.9655, lng: 23.6470 },
  { id: "m-korydallos",      el: "Κορυδαλλός",           en: "Korydallos",           lines: ["3"], lat: 37.9767, lng: 23.6516 },
  { id: "m-agia-varvara",    el: "Αγία Βαρβάρα",         en: "Agia Varvara",         lines: ["3"], lat: 37.9855, lng: 23.6597 },
  { id: "m-agia-marina",     el: "Αγία Μαρίνα",          en: "Agia Marina",          lines: ["3"], lat: 37.9970, lng: 23.6666 },
  { id: "m-aigaleo",         el: "Αιγάλεω",              en: "Egaleo",               lines: ["3"], lat: 37.9917, lng: 23.6817 },
  { id: "m-elaionas",        el: "Ελαιώνας",             en: "Eleonas",              lines: ["3"], lat: 37.9877, lng: 23.6944 },
  { id: "m-kerameikos",      el: "Κεραμεικός",           en: "Kerameikos",           lines: ["3"], lat: 37.9785, lng: 23.7115 },
  { id: "m-evangelismos",    el: "Ευαγγελισμός",         en: "Evangelismos",         lines: ["3"], lat: 37.9764, lng: 23.7472 },
  { id: "m-megaro-mousikis", el: "Μέγαρο Μουσικής",      en: "Megaro Moussikis",     lines: ["3"], lat: 37.9793, lng: 23.7527 },
  { id: "m-ampelokipoi",     el: "Αμπελόκηποι",          en: "Ambelokipi",           lines: ["3"], lat: 37.9872, lng: 23.7570 },
  { id: "m-panormou",        el: "Πανόρμου",             en: "Panormou",             lines: ["3"], lat: 37.9932, lng: 23.7637 },
  { id: "m-katechaki",       el: "Κατεχάκη",             en: "Katehaki",             lines: ["3"], lat: 37.9938, lng: 23.7763 },
  { id: "m-ethniki-amyna",   el: "Εθνική Άμυνα",         en: "Ethniki Amyna",        lines: ["3"], lat: 38.0003, lng: 23.7857 },
  { id: "m-cholargos",       el: "Χολαργός",             en: "Holargos",             lines: ["3"], lat: 38.0044, lng: 23.7946 },
  { id: "m-nomismatokopeio", el: "Νομισματοκοπείο",      en: "Nomismatokopio",       lines: ["3"], lat: 38.0095, lng: 23.8055 },
  { id: "m-agia-paraskevi",  el: "Αγία Παρασκευή",       en: "Agia Paraskevi",       lines: ["3"], lat: 38.0173, lng: 23.8128 },
  { id: "m-chalandri",       el: "Χαλάνδρι",             en: "Halandri",             lines: ["3"], lat: 38.0215, lng: 23.8207 },
  { id: "m-doukissis-plakentias", el: "Δουκίσσης Πλακεντίας", en: "Doukissis Plakentias", lines: ["3"], lat: 38.0243, lng: 23.8337 },
  { id: "m-pallini",         el: "Παλλήνη",              en: "Pallini",              lines: ["3"], lat: 38.0057, lng: 23.8697 },
  { id: "m-paiania-kantza",  el: "Παιανία-Κάντζα",       en: "Paiania-Kantza",       lines: ["3"], lat: 37.9840, lng: 23.8698 },
  { id: "m-koropi",          el: "Κορωπί",               en: "Koropi",               lines: ["3"], lat: 37.9128, lng: 23.8963 },
  { id: "m-aerodromio",      el: "Αεροδρόμιο",           en: "Airport",              lines: ["3"], lat: 37.9364, lng: 23.9445 },
];

/* ==================== journey planning: the model ==================== *
 * Everything below turns "A to B" into a graph with time on its edges.
 * Three modes only: walking, bus/trolley, and metro/ISAP.
 *
 * What is measured and what is modelled, stated plainly because the
 * difference is the whole honesty of the feature:
 *
 *   measured   your walk (the app's own speed model), the live ETA of the
 *              bus you are about to board, the stop sequence of a route
 *   modelled   how long a bus takes between two stops (traffic-dependent
 *              speed x road distance), how long you wait for a service
 *              whose next vehicle has not been dispatched yet, and every
 *              metro time, since OASA's telematics feed does not carry
 *              trains at all
 *
 * Anything modelled is flagged in the response so the UI can say so.
 * ------------------------------------------------------------------ */

/* Station order along each line. The station table above is grouped by the
 * line that "owns" a station, so the interchanges (Piraeus, Monastiraki,
 * Omonia, Attiki, Syntagma) sit in someone else's block. Adjacency comes
 * from these sequences, never from the order of that array. */
const METRO_LINES = {
  "1": ["m-peiraias", "m-faliro", "m-moschato", "m-kallithea", "m-tavros", "m-petralona",
        "m-thiseio", "m-monastiraki", "m-omonoia", "m-viktoria", "m-attiki", "m-agios-nikolaos",
        "m-kato-patisia", "m-agios-eleftherios", "m-ano-patisia", "m-perissos", "m-pefkakia",
        "m-nea-ionia", "m-irakleio", "m-eirini", "m-neratziotissa", "m-marousi", "m-kat",
        "m-kifisia"],
  "2": ["m-anthoupoli", "m-peristeri", "m-agios-antonios", "m-sepolia", "m-attiki",
        "m-stathmos-larisis", "m-metaxourgeio", "m-omonoia", "m-panepistimio", "m-syntagma",
        "m-akropoli", "m-syngrou-fix", "m-neos-kosmos", "m-agios-ioannis", "m-dafni",
        "m-agios-dimitrios", "m-ilioupoli", "m-alimos", "m-argyroupoli", "m-elliniko"],
  "3": ["m-dimotiko-theatro", "m-peiraias", "m-maniatika", "m-nikaia", "m-korydallos",
        "m-agia-varvara", "m-agia-marina", "m-aigaleo", "m-elaionas", "m-kerameikos",
        "m-monastiraki", "m-syntagma", "m-evangelismos", "m-megaro-mousikis", "m-ampelokipoi",
        "m-panormou", "m-katechaki", "m-ethniki-amyna", "m-cholargos", "m-nomismatokopeio",
        "m-agia-paraskevi", "m-chalandri", "m-doukissis-plakentias", "m-pallini",
        "m-paiania-kantza", "m-koropi", "m-aerodromio"],
};

/* Only some trains from Doukissis Plakentias carry on to the airport, and
 * that branch has its own, much longer, headway. Everyone knows this one
 * by heart; it is the single most common way an estimate goes wrong. */
const AIRPORT_LEG = new Set(["m-pallini", "m-paiania-kantza", "m-koropi", "m-aerodromio"]);
const AIRPORT_HEADWAY_MIN = 36;

/* Headways in minutes, by day type, over [fromMinute, toMinute) of the day.
 * These are the published service patterns rounded to something defensible,
 * NOT a timetable: STASY publishes frequency bands rather than departure
 * times for the metro, and they shift with the season. Treat every number
 * here as "about". */
const HEADWAY_METRO = {
  wd:  [[330, 420, 7], [420, 570, 4], [570, 780, 6], [780, 900, 5],
        [900, 1020, 6], [1020, 1230, 4], [1230, 1380, 8], [1380, 1560, 10]],
  sat: [[330, 480, 9], [480, 900, 7], [900, 1260, 6], [1260, 1560, 9]],
  sun: [[330, 480, 11], [480, 1260, 8], [1260, 1560, 11]],
};
// ISAP runs a longer headway than the two newer lines, all day.
const METRO_LINE_FACTOR = { "1": 1.3, "2": 1, "3": 1 };

/* Buses are the weak spot: OASA has ~300 lines and their frequencies are
 * nothing alike, so a single table can only ever be an order of magnitude.
 * It is used ONLY when there is no live ETA to use instead, which in
 * practice means a boarding far enough ahead that no vehicle has been
 * dispatched for it yet. */
const HEADWAY_BUS = {
  wd:  [[300, 420, 20], [420, 570, 12], [570, 780, 16], [780, 900, 14],
        [900, 1020, 15], [1020, 1230, 12], [1230, 1380, 20], [1380, 1500, 30]],
  sat: [[300, 480, 25], [480, 1230, 18], [1230, 1500, 28]],
  sun: [[300, 480, 35], [480, 1230, 25], [1230, 1500, 35]],
};

/* Average bus speed in km/h INCLUDING stops, by day type and time of day.
 * Athens traffic is the dominant term in any bus estimate, well ahead of
 * distance, which is why this is a curve and not a constant. */
const BUS_SPEED = {
  wd:  [[0, 360, 21], [360, 420, 17], [420, 570, 11], [570, 780, 14], [780, 900, 12],
        [900, 1020, 13], [1020, 1230, 11], [1230, 1380, 16], [1380, 1440, 19]],
  sat: [[0, 420, 21], [420, 600, 16], [600, 1260, 13], [1260, 1440, 18]],
  sun: [[0, 480, 23], [480, 1260, 17], [1260, 1440, 20]],
};

// Metro is grade-separated, so it keeps its speed; the airport branch is
// effectively suburban rail and much faster between stations.
const METRO_SPEED_KMH = { urban: 34, isap: 30, airport: 62 };
const METRO_DWELL_S = 25;

/* Service window, minutes from midnight. The metro stops before the buses
 * do; asking for a 03:00 journey should say so rather than quietly plan a
 * train that is not running. */
const METRO_SERVICE = { open: 5 * 60 + 30, close: 24 * 60 + 20, lateClose: 26 * 60 };
const BUS_SERVICE = { open: 5 * 60, close: 24 * 60 + 30 };

const PLAN = {
  walkSpeed: 80,          // m/min — the same figure the arrival list walks with
  detour: 1.35,           // straight line x this = street distance
  maxWalkM: 1100,         // furthest we will propose walking in one go
  accessM: 750,           // radius for candidate boarding / alighting stops
  maxAccess: 5,           // candidate stops per end (subrequest budget)
  maxRoutes: 20,          // route stop-lists we will fetch (subrequest budget)
  transferM: 300,         // stop-to-stop walk that counts as an interchange
  liveHorizonMin: 35,     // past this, no vehicle has been dispatched yet
  changePenaltyMin: 8,    // only for the "fewer changes" alternative
  interchangeMin: 2,      // platform to platform inside one metro station
  busDwellS: 20,          // per intermediate stop on a bus leg
  roadFactor: 1.25,       // straight line between stops x this = road distance
  walkOnlyMaxMin: 40,     // offer "just walk" up to here
  walkKeepSlackMin: 10,   // ...but only if riding is not this much quicker
  maxRefine: 3,           // live-ETA lookups spent improving a found itinerary
  maxSchedules: 3,        // timetable fetches per plan (subrequest budget)
  maxWalkRoutes: 4,       // pedestrian routings per plan (subrequest budget)
};

/* Walking is where a plan quietly goes wrong. Every leg begins and ends on
 * foot, transfers are on foot, and a straight line times a constant is a
 * poor model of a city: it does not know about the motorway between you and
 * the stop, or that the crossing is fifty metres up the road.
 *
 * Two levels, and the leg says which it got.
 *
 *   estimated  straight line x a detour factor that VARIES WITH DISTANCE.
 *              Short hops detour proportionally much more than long ones —
 *              going around one block doubles fifty metres and barely
 *              touches a kilometre — so a single factor is wrong at both
 *              ends. Used for every edge inside the search, where only the
 *              ranking matters and there are thousands of them.
 *   routed     a real pedestrian route, with its real distance and its real
 *              shape to draw. One request each, so only the walking legs of
 *              the itinerary that won, and only if ORS_KEY is configured.
 *
 * The key is a Worker secret, not a client value: unlike the tile key this
 * one never has to reach a browser, so it should not.
 *     npx wrangler secret put ORS_KEY      (openrouteservice.org, free tier)
 */
/* Tram and trolley ride the same telematics feed as the buses and come
 * back through the same route calls, so they are already planned over —
 * they were just all being called "bus". OASA names the mode in the route
 * or line description, which is steadier to read than guessing from line
 * numbers: those get renumbered, and the tram has been renumbered twice.
 * Anything unrecognised stays a bus, which is what the overwhelming
 * majority of it is. */
// bus, tram and trolley are all "a road vehicle you board at a stop": the
// same graph, the same timetables, the same live ETAs. Only the label differs.
const SURFACE = new Set(["bus", "tram", "trolley"]);
function vehicleMode(info) {
  const t = [info && info.el, info && info.en, info && info.id].join(" ");
  if (/τραμ|tram/i.test(t)) return "tram";
  if (/τρολ|trolley|trolei/i.test(t)) return "trolley";
  return "bus";
}

const WALK_ROUTER = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";
const WALK_CACHE = 7 * 86400;   // a pavement is not news
function detourFor(metres) {
  const m = Math.max(0, Number(metres) || 0);
  if (m <= 150) return 1.65;
  if (m >= 1200) return 1.22;
  // straight interpolation between the two ends
  return 1.65 + (1.22 - 1.65) * ((m - 150) / (1200 - 150));
}

function dayType(d) { const k = d.getDay(); return k === 0 ? "sun" : k === 6 ? "sat" : "wd"; }
function bandValue(table, minutes, fallback) {
  for (const [a, b, v] of table) if (minutes >= a && minutes < b) return v;
  return fallback;
}
// Athens is the only timezone this app has ever cared about.
function athensParts(ms) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms));
  const g = t => (f.find(x => x.type === t) || {}).value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")] ?? 1;
  return { day: wd, min: (+g("hour")) * 60 + (+g("minute")) };
}
function clockAt(baseMs, offsetMin) {
  const p = athensParts(baseMs + offsetMin * 60000);
  return { dayType: p.day === 0 ? "sun" : p.day === 6 ? "sat" : "wd", day: p.day, min: p.min };
}

function walkMinutes(metres) { return (metres * detourFor(metres)) / PLAN.walkSpeed; }

/* One pedestrian route. Returns null on anything unexpected rather than a
 * half-answer, because a wrong walking time is worse than an admitted
 * estimate: it is the number that decides whether you make the connection. */
async function routeWalk(a, b, env) {
  const key = env && env.ORS_KEY;
  if (!key) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(WALK_ROUTER, {
      method: "POST",
      headers: { "Authorization": key, "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ coordinates: [[a.lng, a.lat], [b.lng, b.lat]] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const f = j && Array.isArray(j.features) && j.features[0];
    const sum = f && f.properties && f.properties.summary;
    const coords = f && f.geometry && f.geometry.coordinates;
    if (!sum || !isFinite(sum.duration) || !Array.isArray(coords) || coords.length < 2) return null;
    return {
      min: sum.duration / 60,
      metres: sum.distance,
      path: coords.map(c => [c[1], c[0]]),      // GeoJSON is lng,lat; Leaflet is lat,lng
    };
  } catch (_) { return null; }
}

/* Replace the estimate on the walking legs of a chosen itinerary with the
 * real thing, and re-time everything after each one. */
async function refineWalks(plan, budget, env) {
  if (!(env && env.ORS_KEY)) return plan;
  let spent = 0;
  for (let k = 0; k < plan.legs.length; k++) {
    const leg = plan.legs[k];
    if (leg.mode !== "walk") continue;
    if (spent >= PLAN.maxWalkRoutes || budget.used >= 46) break;
    const path = leg.path || [];
    if (path.length < 2) continue;
    const a = { lat: path[0][0], lng: path[0][1] };
    const b = { lat: path[path.length - 1][0], lng: path[path.length - 1][1] };
    const r = await routeWalk(a, b, env);
    spent++; budget.used++;
    if (!r) continue;
    const shift = r.min - leg.min;
    leg.min = Math.round(r.min * 10) / 10;
    leg.metres = Math.round(r.metres);
    leg.path = r.path;
    leg.basis = "routed";
    for (let i = k + 1; i < plan.legs.length; i++) plan.legs[i].startMin += shift;
    plan.totalMin = Math.round(plan.totalMin + shift);
  }
  plan.walkBasis = plan.legs.filter(l => l.mode === "walk").every(l => l.basis === "routed")
    ? "routed" : plan.legs.some(l => l.basis === "routed") ? "mixed" : "estimated";
  return plan;
}

function metroHeadway(line, at) {
  const base = bandValue(HEADWAY_METRO[at.dayType], at.min, 12);
  return base * (METRO_LINE_FACTOR[line] || 1);
}
function metroRunMinutes(a, b, line) {
  const d = hav(a.lat, a.lng, b.lat, b.lng);
  const branch = AIRPORT_LEG.has(a.id) || AIRPORT_LEG.has(b.id);
  const kmh = branch ? METRO_SPEED_KMH.airport
    : line === "1" ? METRO_SPEED_KMH.isap : METRO_SPEED_KMH.urban;
  return (d / 1000) / kmh * 60 + METRO_DWELL_S / 60;
}
function metroRunning(at) {
  // Fri and Sat nights the two newer lines run on into the small hours.
  const late = at.day === 5 || at.day === 6;
  const close = late ? METRO_SERVICE.lateClose : METRO_SERVICE.close;
  return at.min >= METRO_SERVICE.open && at.min <= close;
}
function busRunning(at) { return at.min >= BUS_SERVICE.open && at.min <= BUS_SERVICE.close; }
function busRunMinutes(metres, at) {
  const kmh = bandValue(BUS_SPEED[at.dayType], at.min, 14);
  return (metres * PLAN.roadFactor / 1000) / kmh * 60 + PLAN.busDwellS / 60;
}
function busHeadway(at) { return bandValue(HEADWAY_BUS[at.dayType], at.min, 25); }

/* ==================== journey planning: the graph =================== *
 * Node keys, because the shape of the graph is the whole algorithm:
 *
 *   O, D                origin and destination
 *   p:<stopCode>        standing at a bus stop
 *   k:<stationId>       standing in a metro station (one node per station,
 *                       so changing lines inside Syntagma is an edge cost,
 *                       not a walk)
 *   r:<routeCode>:<i>   aboard route at its i-th stop
 *   t:<line>:<dir>:<i>  aboard a train
 *
 * Boarding is its own edge, which is what stops the search from strolling
 * between routes at a shared stop for free: you always pay the wait.
 * ------------------------------------------------------------------ */

// A small binary heap. Dijkstra on a few thousand nodes does not need more.
function heapPush(h, node, key) {
  h.push({ node, key });
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].key <= h[i].key) break;
    [h[p], h[i]] = [h[i], h[p]]; i = p;
  }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < h.length && h[l].key < h[m].key) m = l;
      if (r < h.length && h[r].key < h[m].key) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  }
  return top;
}

/* Stops within a few hundred metres of each other are interchange
 * candidates, and there can be a couple of thousand of them. Comparing
 * every pair is a million haversines for nothing, so bucket by a grid
 * whose cell is the search radius and only look at the nine cells around
 * each stop. */
function spatialIndex(points, cellM) {
  const dLat = cellM / 111320;
  const cells = new Map();
  const key = (a, b) => a + "/" + b;
  points.forEach((p, i) => {
    const ca = Math.floor(p.lat / dLat);
    const cb = Math.floor(p.lng / (dLat / Math.cos(p.lat * Math.PI / 180)));
    const k = key(ca, cb);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  return {
    near(lat, lng, radiusM) {
      const ca = Math.floor(lat / dLat);
      const cb = Math.floor(lng / (dLat / Math.cos(lat * Math.PI / 180)));
      /* Scan as many rings as the radius asks for. Scanning a fixed 3x3
         is only correct when the cell is at least as wide as the query,
         and this index is built at transfer range but also queried at
         walking range — which quietly lost every stop past half a cell,
         including whole bus routes that were a perfectly good option. */
      const rings = Math.max(1, Math.ceil(radiusM / cellM));
      const out = [];
      for (let a = ca - rings; a <= ca + rings; a++) for (let b = cb - rings; b <= cb + rings; b++) {
        const c = cells.get(key(a, b)); if (!c) continue;
        for (const i of c) {
          const d = hav(lat, lng, points[i].lat, points[i].lng);
          if (d <= radiusM) out.push({ i, d });
        }
      }
      return out.sort((x, y) => x.d - y.d);
    },
  };
}

async function closestStops(lat, lng) {
  const arr = await getJSON(`${OASA}?act=getClosestStops&p1=${lat}&p2=${lng}`,
    ACT_TTL.getClosestStops);
  if (!Array.isArray(arr)) return [];
  return arr.map(s => {
    const la = Number(pickField(s, "StopLat", "StopY", "stop_lat"));
    const ln = Number(pickField(s, "StopLng", "StopX", "stop_lng"));
    return {
      code: String(pickField(s, "StopCode", "StopID", "stop_code") || ""),
      name: pickField(s, "StopDescr", "StopDescrEng") || "",
      name_en: pickField(s, "StopDescrEng", "StopDescr") || "",
      lat: la, lng: ln,
      dist: (isFinite(la) && isFinite(ln)) ? hav(lat, lng, la, ln) : Infinity,
    };
  }).filter(s => s.code && isFinite(s.dist))
    .sort((a, b) => a.dist - b.dist);
}

async function routeStops(routeCode) {
  const arr = await getJSON(`${OASA}?act=webGetStops&p1=${routeCode}`, ACT_TTL.webGetStops);
  if (!Array.isArray(arr)) return null;
  const out = arr.map(x => {
    const la = Number(pickField(x, "StopLat", "StopY", "stop_lat"));
    const ln = Number(pickField(x, "StopLng", "StopX", "stop_lng"));
    return {
      code: String(pickField(x, "StopCode", "StopID", "stop_code") || ""),
      name: pickField(x, "StopDescr", "StopDescrEng") || "",
      name_en: pickField(x, "StopDescrEng", "StopDescr") || "",
      lat: la, lng: ln,
    };
  }).filter(x => x.code && isFinite(x.lat) && isFinite(x.lng));
  return out.length > 1 ? out : null;
}

async function stopArrivals(code) {
  const arr = await getJSON(`${OASA}?act=getStopArrivals&p1=${code}`, ACT_TTL.getStopArrivals);
  if (!Array.isArray(arr)) return null;
  const by = new Map();
  for (const a of arr) {
    const rc = String(pickField(a, "route_code", "RouteCode") || "");
    const m = parseInt(pickField(a, "btime2", "btime", "stop_time") || "999", 10);
    if (!rc || !isFinite(m)) continue;
    if (!by.has(rc) || m < by.get(rc)) by.set(rc, m);
  }
  return by;
}

/* Build the bounded graph, then run a time-dependent Dijkstra over it.
 *
 * Bounded, because the honest alternative does not fit: OASA exposes the
 * network one route or one stop at a time, so the whole city is thousands
 * of calls and a Worker gets fifty. What we fetch instead is the routes
 * that actually touch either end of THIS journey, plus every stop along
 * them, plus the metro, which is static and free. That is the subgraph a
 * sane itinerary lives in; what it cannot find is a three-bus trip whose
 * middle leg starts somewhere neither end has ever heard of.
 *
 * Time-dependent because the cost of boarding depends on when you arrive
 * at the stop: a wait is not a constant. Dijkstra stays correct under that
 * as long as taking a later train can never get you there sooner, which is
 * true of everything modelled here. */
async function buildGraph(from, to, departMs, budget) {
  const [oNear, dNear] = await Promise.all([
    closestStops(from.lat, from.lng),
    closestStops(to.lat, to.lng),
  ]);
  budget.used += 2;

  const originStops = oNear.filter(s => s.dist <= PLAN.accessM).slice(0, PLAN.maxAccess);
  const destStops = dNear.filter(s => s.dist <= PLAN.accessM).slice(0, PLAN.maxAccess);

  // which routes serve either end
  const routeIds = new Map();          // routeCode -> {code, line, dest}
  const endStops = [...originStops, ...destStops];
  await pool(endStops.map(s => async () => {
    const r = await fetchStopRoutes(s.code);
    if (!r) return;
    for (const rt of r.routes) if (!routeIds.has(rt.code)) routeIds.set(rt.code, rt);
  }), 6);
  budget.used += endStops.length;

  // their stop sequences; this is what turns "route" into "path"
  const wanted = [...routeIds.keys()].slice(0, PLAN.maxRoutes);
  const seqs = new Map();
  await pool(wanted.map(rc => async () => {
    const st = await routeStops(rc);
    if (st) seqs.set(rc, st);
  }), 6);
  budget.used += wanted.length;

  // live ETAs where they exist: only the stops you could actually walk to
  // now have a dispatched vehicle worth knowing about
  const live = new Map();              // stopCode -> Map(routeCode -> minutes)
  await pool(originStops.map(s => async () => {
    const a = await stopArrivals(s.code);
    if (a) live.set(s.code, a);
  }), 5);
  budget.used += originStops.length;

  // every stop we know a position for, bus and metro alike
  const stops = new Map();
  const note = s => { if (!stops.has(s.code)) stops.set(s.code, s); };
  originStops.forEach(note); destStops.forEach(note);
  for (const seq of seqs.values()) seq.forEach(note);

  const stations = METRO_STATIONS.map(m => ({ ...m }));
  return { originStops, destStops, routeIds, seqs, live, stops, stations, departMs };
}

/* One run of the search. `changePenalty` is a search weight only: it biases
 * against extra vehicles without pretending they take longer, so the times
 * reported back are always the real ones. */
function search(g, from, to, opts) {
  const { changePenalty = 0, allowBus = true, allowMetro = true, noDirect = false } = opts || {};
  const departMs = g.departMs;

  const stopList = [...g.stops.values()];
  const stopIdx = new Map(stopList.map((s, i) => [s.code, i]));
  const stopGrid = spatialIndex(stopList, PLAN.transferM);
  const stationGrid = spatialIndex(g.stations, PLAN.transferM);

  const time = new Map();     // node -> minutes after departure, actual clock
  const cost = new Map();     // node -> what the search orders by
  const prev = new Map();
  const heap = [];
  /* Whether the best path to a node has boarded anything yet. Only the
     `noDirect` run reads it, and only to refuse to finish on foot from a
     stop it merely walked to — otherwise "forbid the direct walk" is
     trivially defeated by walking to a stop and walking on from it, which
     is the same walk with a waypoint. */
  const rode = new Map([["O", false]]);
  const boarded = e => !!e && (e.mode === "board" || e.mode === "boardMetro");
  const relax = (u, v, dt, dc, edge) => {
    const nt = time.get(u) + dt, nc = cost.get(u) + (dc == null ? dt : dc);
    if (cost.has(v) && cost.get(v) <= nc) return;
    cost.set(v, nc); time.set(v, nt); prev.set(v, { from: u, edge });
    rode.set(v, rode.get(u) === true || boarded(edge));
    heapPush(heap, v, nc);
  };
  const mayFinishOnFoot = u => !noDirect || rode.get(u) === true;

  time.set("O", 0); cost.set("O", 0); heapPush(heap, "O", 0);
  const done = new Set();

  /* Straight there on foot, always an option worth carrying — except in
     the `noDirect` run, whose whole job is to find the best answer that
     does NOT involve walking the lot, so the walking one has something
     honest to be compared against. */
  const directM = hav(from.lat, from.lng, to.lat, to.lng);
  if (!noDirect && walkMinutes(directM) <= PLAN.walkOnlyMaxMin) {
    relax("O", "D", walkMinutes(directM), null, { mode: "walk", metres: directM });
  }

  while (heap.length) {
    const { node: u } = heapPop(heap);
    if (done.has(u)) continue;
    done.add(u);
    if (u === "D") break;
    const tu = time.get(u);
    const at = clockAt(departMs, tu);

    if (u === "O") {
      // walk to nearby stops and stations
      stopGrid.near(from.lat, from.lng, PLAN.maxWalkM).forEach(({ i, d }) =>
        relax("O", "p:" + stopList[i].code, walkMinutes(d), null,
          { mode: "walk", metres: d, to: stopList[i] }));
      if (allowMetro) stationGrid.near(from.lat, from.lng, PLAN.maxWalkM).forEach(({ i, d }) =>
        relax("O", "k:" + g.stations[i].id, walkMinutes(d), null,
          { mode: "walk", metres: d, to: g.stations[i] }));
      continue;
    }

    if (u.startsWith("p:")) {
      const code = u.slice(2), s = g.stops.get(code);
      if (!s) continue;
      // finish on foot
      const dEnd = hav(s.lat, s.lng, to.lat, to.lng);
      if (dEnd <= PLAN.maxWalkM && mayFinishOnFoot(u))
        relax(u, "D", walkMinutes(dEnd), null, { mode: "walk", metres: dEnd });
      // step across to a neighbouring stop or into a station
      stopGrid.near(s.lat, s.lng, PLAN.transferM).forEach(({ i, d }) => {
        if (stopList[i].code === code) return;
        relax(u, "p:" + stopList[i].code, walkMinutes(d), null,
          { mode: "walk", metres: d, to: stopList[i] });
      });
      if (allowMetro) stationGrid.near(s.lat, s.lng, PLAN.transferM).forEach(({ i, d }) =>
        relax(u, "k:" + g.stations[i].id, walkMinutes(d), null,
          { mode: "walk", metres: d, to: g.stations[i] }));
      // board something
      if (allowBus && busRunning(at)) {
        for (const [rc, seq] of g.seqs) {
          const i = seq.findIndex(x => x.code === code);
          if (i < 0 || i >= seq.length - 1) continue;
          const w = boardWait(g, code, rc, tu, at);
          relax(u, `r:${rc}:${i}`, w.min, w.min + changePenalty,
            { mode: "board", route: rc, wait: w.min, basis: w.basis, stopCode: code });
        }
      }
      continue;
    }

    if (u.startsWith("k:")) {
      const id = u.slice(2), st = g.stations.find(x => x.id === id);
      if (!st) continue;
      const dEnd = hav(st.lat, st.lng, to.lat, to.lng);
      if (dEnd <= PLAN.maxWalkM && mayFinishOnFoot(u))
        relax(u, "D", walkMinutes(dEnd), null, { mode: "walk", metres: dEnd });
      stopGrid.near(st.lat, st.lng, PLAN.transferM).forEach(({ i, d }) =>
        relax(u, "p:" + stopList[i].code, walkMinutes(d), null,
          { mode: "walk", metres: d, to: stopList[i] }));
      if (allowMetro && metroRunning(at)) {
        for (const line of st.lines) {
          const seq = METRO_LINES[line]; if (!seq) continue;
          const i = seq.indexOf(id); if (i < 0) continue;
          for (const dir of [1, -1]) {
            const nxt = i + dir;
            if (nxt < 0 || nxt >= seq.length) continue;
            let head = metroHeadway(line, at);
            if (AIRPORT_LEG.has(seq[nxt]) || AIRPORT_LEG.has(id)) head = AIRPORT_HEADWAY_MIN;
            const wait = head / 2 + PLAN.interchangeMin;
            relax(u, `t:${line}:${dir}:${i}`, wait, wait + changePenalty,
              { mode: "boardMetro", line, dir, wait, basis: "estimated" });
          }
        }
      }
      continue;
    }

    if (u.startsWith("r:")) {
      const [, rc, iS] = u.split(":"); const i = +iS;
      const seq = g.seqs.get(rc); if (!seq) continue;
      relax(u, "p:" + seq[i].code, 0, 0, { mode: "alight" });
      if (i + 1 < seq.length) {
        const d = hav(seq[i].lat, seq[i].lng, seq[i + 1].lat, seq[i + 1].lng);
        const rt = busRunMinutes(d, at);
        relax(u, `r:${rc}:${i + 1}`, rt, rt, { mode: "ride", route: rc, metres: d });
      }
      continue;
    }

    if (u.startsWith("t:")) {
      const [, line, dirS, iS] = u.split(":"); const dir = +dirS, i = +iS;
      const seq = METRO_LINES[line]; if (!seq) continue;
      const here = g.stations.find(x => x.id === seq[i]);
      relax(u, "k:" + seq[i], 0, 0, { mode: "alightMetro" });
      const j = i + dir;
      if (j >= 0 && j < seq.length) {
        const nxt = g.stations.find(x => x.id === seq[j]);
        if (here && nxt) {
          let rt = metroRunMinutes(here, nxt, line);
          /* Only a fraction of line 3's trains carry on past Doukissis
             Plakentias, so crossing onto the airport branch usually means
             letting one or two go and waiting out the branch's own, much
             longer headway. Charged once, where the branch begins. */
          let branchWait = 0;
          if (!AIRPORT_LEG.has(here.id) && AIRPORT_LEG.has(nxt.id)) {
            branchWait = Math.max(0, (AIRPORT_HEADWAY_MIN - metroHeadway(line, at)) / 2);
            rt += branchWait;
          }
          relax(u, `t:${line}:${dir}:${j}`, rt, rt, { mode: "rideMetro", line, dir, branchWait });
        }
      }
      continue;
    }
  }

  if (!time.has("D")) return null;
  return { time, prev, totalMin: time.get("D") };
}

/* How long you stand at a stop, and how sure we are of it.
 *
 *   live       an ETA for a vehicle that has been dispatched and is being
 *              tracked. Only exists inside the horizon.
 *   timetable  past the horizon, the line's published departures, shifted
 *              by how long it takes to reach THIS stop from the terminus.
 *   estimated  no timetable came back, so half of an average headway for
 *              the day and hour. The weakest number in the whole planner.
 *
 * The search itself only ever uses the first and the last: a timetable
 * lookup costs a subrequest and there are thousands of boarding edges, so
 * it is applied afterwards, to the boardings of the itineraries that won.
 */
function boardWait(g, stopCode, routeCode, offsetMin, at) {
  if (offsetMin <= PLAN.liveHorizonMin) {
    const byRoute = g.live.get(stopCode);
    const m = byRoute && byRoute.get(routeCode);
    if (m != null && isFinite(m) && m < 300) {
      const w = Math.max(0, m - offsetMin);
      if (w <= PLAN.liveHorizonMin) return { min: w, basis: "live" };
    }
  }
  return { min: busHeadway(at) / 2, basis: "estimated" };
}

/* ===================== OASA published timetables ===================== *
 * The telematics feed tracks vehicles that exist. For a connection an hour
 * out nothing has been dispatched yet, and the honest source is the
 * timetable — which OASA publishes as DEPARTURES FROM THE TERMINUS, not as
 * times at each stop. So a stop time is a departure plus the running time
 * from the start of the route to that stop, which we already model.
 *
 * The response shape here is not something this code can pin down: the
 * endpoint is undocumented and its field names vary across acts. The parser
 * therefore accepts anything that looks like a time — "07:35", "7:35",
 * minutes past midnight, or a nested array of any of those — and gives up
 * cleanly rather than inventing a departure. Whatever it cannot read falls
 * back to the headway model and is labelled `estimated`, not `timetable`.
 * ------------------------------------------------------------------ */
const SCHED_TTL = 6 * 3600;
const schedMem = new Map();          // lineId|dayType -> sorted minutes, or null

/* "HH:MM" is unmistakable. A bare integer is not: a line code, a route
 * code, a schedule-day code and a sequence number all look exactly like
 * minutes past midnight, and reading 608 as 10:08 would put a departure in
 * the plan that does not exist. So a bare number is only believed when the
 * field it sits under says it is a time. Everything else is dropped, and
 * dropping everything is fine — the leg then says `estimated`, which is
 * true, instead of `timetable`, which would not be. */
const TIME_KEY = /time|hour|depart|start|arriv|ωρα|ώρα|αναχωρ/i;
function parseTimes(node, out, depth, key) {
  if (out.length > 400 || (depth || 0) > 5) return out;
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const v of node) parseTimes(v, out, (depth || 0) + 1, key);
    return out;
  }
  if (typeof node === "object") {
    for (const k in node) parseTimes(node[k], out, (depth || 0) + 1, k);
    return out;
  }
  const s2 = String(node).trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s2);
  if (m) {
    const h = +m[1], mi = +m[2];
    // OASA writes trips after midnight as 24:xx and 25:xx, which is correct
    if (h <= 27 && mi < 60) out.push(h * 60 + mi);
    return out;
  }
  if (/^\d{1,4}$/.test(s2) && TIME_KEY.test(String(key || ""))) {
    const v = +s2;
    if (v >= 180 && v <= 1680) out.push(v);   // minutes past midnight, 03:00–28:00
  }
  return out;
}

async function lineDepartures(lineId, at) {
  if (!lineId) return null;
  const key = String(lineId) + "|" + at.dayType;
  if (schedMem.has(key)) return schedMem.get(key);
  let out = null;
  try {
    const days = await getJSON(
      `${OASA}?act=getScheduleDaysMasterline&p1=${encodeURIComponent(lineId)}`, SCHED_TTL);
    // pick the schedule-day row matching today: weekday, Saturday, Sunday
    const want = at.dayType === "sun" ? /κυριακ|sunday|holiday|αργι/i
      : at.dayType === "sat" ? /σαββατ|saturday/i : /καθημ|weekday|εργασ/i;
    const rows = Array.isArray(days) ? days : [];
    let sdc = null;
    for (const r of rows) {
      const label = Object.values(r || {}).map(v => String(v)).join(" ");
      if (want.test(label)) { sdc = pickField(r, "sdc_code", "sdcCode", "SDC_CODE", "sdc"); break; }
    }
    if (sdc == null && rows.length) sdc = pickField(rows[0], "sdc_code", "sdcCode", "SDC_CODE", "sdc");
    if (sdc != null) {
      const sched = await getJSON(
        `${OASA}?act=getSchedLinesMasterline&p1=${encodeURIComponent(lineId)}` +
        `&p2=${encodeURIComponent(sdc)}&p3=${encodeURIComponent(lineId)}`, SCHED_TTL);
      const mins = parseTimes(sched, [], 0);
      if (mins.length >= 2) out = [...new Set(mins)].sort((a, b) => a - b);
    }
  } catch (_) { out = null; }
  schedMem.set(key, out);
  return out;
}

/* Running time from the first stop of a route to its i-th, which is what
 * turns a terminal departure into a time at the stop you are standing at. */
function runToStop(seq, i, at) {
  let mins = 0;
  for (let k = 0; k < i && k + 1 < seq.length; k++) {
    mins += busRunMinutes(hav(seq[k].lat, seq[k].lng, seq[k + 1].lat, seq[k + 1].lng), at);
  }
  return mins;
}

/* Walk the predecessor chain forward and glue consecutive edges of the same
 * kind into the legs a person actually thinks in: "walk 6 min", "the 608
 * for 9 stops", "M3 to Syntagma". Endpoints come from the node the edge
 * lands on, which is the only thing that cannot drift out of step with the
 * path itself. */
function toLegs(g, res, from, to) {
  const chain = [];
  for (let n = "D"; n && n !== "O"; ) {
    const p = res.prev.get(n); if (!p) break;
    chain.push({ node: n, from: p.from, edge: p.edge });
    n = p.from;
  }
  chain.reverse();
  if (!chain.length) return null;

  const stopName = c => { const s2 = g.stops.get(c); return s2 && { el: s2.name, en: s2.name_en || s2.name }; };
  const stationName = id => { const st = g.stations.find(x => x.id === id); return st && { el: st.el, en: st.en }; };
  const nameOf = key => key.startsWith("p:") ? stopName(key.slice(2))
    : key.startsWith("k:") ? stationName(key.slice(2)) : null;
  // where a node is, so each leg can carry the line the map should draw
  const posOf = key => {
    if (key === "O") return [from.lat, from.lng];
    if (key === "D") return [to.lat, to.lng];
    if (key.startsWith("p:")) { const s2 = g.stops.get(key.slice(2)); return s2 && [s2.lat, s2.lng]; }
    if (key.startsWith("k:")) { const st = g.stations.find(x => x.id === key.slice(2)); return st && [st.lat, st.lng]; }
    return null;
  };

  const legs = [];
  let scheduled = false, estimated = false, live = false;

  for (const step of chain) {
    const e = step.edge; if (!e) continue;
    const tIn = res.time.get(step.from), tOut = res.time.get(step.node);

    if (e.mode === "walk") {
      const last = legs[legs.length - 1];
      const here2 = posOf(step.node);
      if (last && last.mode === "walk") {
        last.min += tOut - tIn; last.metres += e.metres; last.to = nameOf(step.node) || last.to;
        if (here2) last.path.push(here2);
      } else {
        const a0 = posOf(step.from);
        legs.push({ mode: "walk", min: tOut - tIn, metres: e.metres, startMin: tIn,
          basis: "estimated", to: nameOf(step.node), path: [a0, here2].filter(Boolean) });
      }
      continue;
    }

    if (e.mode === "board" || e.mode === "boardMetro") {
      const isMetro = e.mode === "boardMetro";
      if (e.basis === "live") live = true;
      if (e.basis === "scheduled") scheduled = true;
      if (e.basis === "estimated") estimated = true;
      const info = isMetro ? null : g.routeIds.get(e.route);
      legs.push({
        mode: isMetro ? "metro" : vehicleMode(info),
        line: isMetro ? e.line : (info && info.id) || e.route,
        routeCode: isMetro ? null : e.route,
        headsign: isMetro || !info ? null : { el: info.el, en: info.en },
        dir: isMetro ? e.dir : null,
        wait: e.wait, basis: e.basis, startMin: tIn,
        stopCode: isMetro ? null : e.stopCode,
        from: nameOf(step.from), to: nameOf(step.from),
        stops: 0, rideMin: 0, min: e.wait,
        path: [posOf(step.from)].filter(Boolean),
      });
      continue;
    }

    if (e.mode === "ride" || e.mode === "rideMetro") {
      const leg = legs[legs.length - 1];
      if (!leg || leg.mode === "walk") continue;
      leg.stops += 1;
      leg.rideMin = tOut - (leg.startMin + leg.wait);
      leg.min = leg.wait + leg.rideMin;
      // where we now are, so the last ride edge leaves `to` correct
      if (e.mode === "ride") {
        const seq = g.seqs.get(e.route);
        const i = +step.node.split(":")[2];
        if (seq && seq[i]) {
          leg.to = { el: seq[i].name, en: seq[i].name_en || seq[i].name };
          leg.path.push([seq[i].lat, seq[i].lng]);
        }
      } else {
        const [, line, , iS] = step.node.split(":");
        const seq = METRO_LINES[line];
        const st = seq && g.stations.find(x => x.id === seq[+iS]);
        if (st) { leg.to = { el: st.el, en: st.en }; leg.path.push([st.lat, st.lng]); }
      }
      if (e.branchWait) leg.branchWait = (leg.branchWait || 0) + e.branchWait;
      continue;
    }
    // alight / alightMetro cost nothing and change nothing
  }

  const vehicles = legs.filter(l => l.mode !== "walk").length;
  return {
    totalMin: Math.round(res.time.get("D")),
    legs: legs.map(l => ({ ...l, min: Math.round(l.min * 10) / 10 })),
    changes: Math.max(0, vehicles - 1),
    vehicles,
    basis: summariseBasis(legs),
  };
}

/* The user asked for live ETAs and a fall back to schedule beyond their
 * horizon. The search can only use live data for the first boarding, since
 * that is the only stop we can afford to ask about up front. Once we know
 * which itinerary won, the later boardings are worth a lookup too: if the
 * connection is close enough that a vehicle exists for it, replace the
 * half-headway guess with the real wait and re-time everything after it. */
/* The search had to guess at every boarding after the first, because a
 * lookup per boarding edge is thousands of requests. Now that one itinerary
 * has won, its boardings are worth asking about properly — a handful of
 * requests, spent where they change what the rider is told.
 *
 * Two sources, in order of how much they are worth: a live ETA if the
 * connection is close enough that a vehicle exists for it, otherwise the
 * line's published timetable. Only if neither answers does the half-headway
 * guess stand, and then the leg says `estimated`.
 *
 * Shifting a leg moves everything after it, so the whole tail is re-timed
 * rather than left describing a plan that no longer exists. */
async function refineBoardings(plan, g, budget) {
  let spent = 0, scheds = 0;
  for (let k = 0; k < plan.legs.length; k++) {
    const leg = plan.legs[k];
    if (!SURFACE.has(leg.mode) || leg.basis === "live") continue;
    if (spent >= PLAN.maxRefine || budget.used >= 44) break;
    if (!leg.stopCode || !leg.routeCode) continue;
    const at = clockAt(g.departMs, leg.startMin);
    let wait = null, basis = null;

    // close enough that a vehicle should have been dispatched: ask
    if (leg.startMin <= PLAN.liveHorizonMin) {
      const by = await stopArrivals(leg.stopCode);
      spent++; budget.used++;
      const m = by && by.get(leg.routeCode);
      if (m != null && isFinite(m) && m - leg.startMin >= 0 && m - leg.startMin <= PLAN.liveHorizonMin) {
        wait = m - leg.startMin; basis = "live";
      }
    }

    // otherwise the timetable, shifted to this stop
    if (wait == null && scheds < PLAN.maxSchedules) {
      const seq = g.seqs.get(leg.routeCode);
      const i = seq ? seq.findIndex(x => String(x.code) === String(leg.stopCode)) : -1;
      const deps = await lineDepartures(leg.line, at);
      scheds++; budget.used += 2;
      if (deps && i >= 0) {
        const offset = runToStop(seq, i, at);
        const wantAt = at.min + 0;                     // clock time we reach the stop
        const next = deps.map(d => d + offset).find(t => t >= wantAt - 0.5);
        if (next != null && next - wantAt <= 180) { wait = next - wantAt; basis = "timetable"; }
      }
    }

    if (wait == null || basis == null) continue;
    const shift = wait - leg.wait;
    leg.wait = Math.round(wait * 10) / 10; leg.basis = basis;
    leg.min = Math.round((wait + leg.rideMin) * 10) / 10;
    for (let i = k + 1; i < plan.legs.length; i++) plan.legs[i].startMin += shift;
    plan.totalMin = Math.round(plan.totalMin + shift);
  }
  plan.basis = summariseBasis(plan.legs);
  return plan;
}

/* One word for where an itinerary's numbers came from. "mixed" is not a
   hedge: a trip really is routinely half measured and half modelled, and
   saying so beats picking the flattering half. */
function summariseBasis(legs) {
  const b = new Set(legs.filter(l => l.mode !== "walk").map(l => l.basis));
  if (!b.size) return "live";
  if (b.size === 1) return [...b][0];
  return "mixed";
}

function sameShape(a, b) {
  const sig = p => p.legs.filter(l => l.mode !== "walk")
    .map(l => l.mode + ":" + l.line).join(">");
  return sig(a) === sig(b);
}

/* How many boarding points the search actually had within walking distance
 * of a point. Zero at either end is the difference between "the network
 * does not go there" and "the planner could not find a way", and it is the
 * one thing a rider can act on — walk two streets and try again. */
function reachOf(g, pt) {
  let n = 0;
  for (const s of g.stops.values())
    if (hav(pt.lat, pt.lng, s.lat, s.lng) <= PLAN.maxWalkM) n++;
  for (const st of g.stations)
    if (hav(pt.lat, pt.lng, st.lat, st.lng) <= PLAN.maxWalkM) n++;
  return n;
}

const isWalkOnly = p => p.legs.length > 0 && p.legs.every(l => l.mode === "walk");

/* There are three slots. A walk-only option earns one when it is close to
 * competitive; a 38-minute walk against a 15-minute ride is not an
 * alternative, it is padding, and it pushes a real second route off the
 * list. Keeping it under walkKeepSlackMin still covers the case a rider
 * actually wants — "riding is a bit quicker, but I'd rather walk it". */
function pruneWalk(out) {
  const i = out.findIndex(isWalkOnly);
  if (i < 0) return out;
  const ride = out.find(p => !isWalkOnly(p));
  if (ride && out[i].totalMin > ride.totalMin + PLAN.walkKeepSlackMin) out.splice(i, 1);
  return out;
}

/* "Walk 34 minutes" is the one answer a rider cannot sanity-check. It may
 * mean the network is shut, or that the next bus is 40 minutes out, or
 * that the planner simply failed — and those deserve different reactions.
 * So a walk-only itinerary carries the reason it was offered, and where
 * the reason is a wait, the wait itself. */
function explainWalk(out, service, g, from, to) {
  const walk = out.find(isWalkOnly);
  if (!walk) return;
  const ride = out.find(p => !isWalkOnly(p));

  if (ride) {
    const board = ride.legs.find(l => l.mode !== "walk");
    walk.why = {
      code: walk.totalMin <= ride.totalMin ? "beats" : "also",
      viaMin: ride.totalMin,
      waitMin: board && isFinite(board.wait) ? Math.round(board.wait) : null,
      line: board ? String(board.line) : null,
      mode: board ? board.mode : null,
    };
    return;
  }
  walk.why = { code: noRideReason(service, g, from, to) };
}

/* Why no riding option exists — shared by the walk-only note and by the
 * empty answer, which are the same question asked from two sides. */
function noRideReason(service, g, from, to) {
  if (!service.metro && !service.bus) return "closed";
  if (!reachOf(g, from)) return "nostopsfrom";
  if (!reachOf(g, to)) return "nostopsto";
  return "noconnection";
}

async function planJourney(from, to, departMs, env) {
  const budget = { used: 0 };
  const g = await buildGraph(from, to, departMs, budget);

  /* The fourth run costs no requests — it is Dijkstra again over a graph
     already in memory — and it earns its place twice over: it is the
     "I would rather not walk it" option when walking wins, and it is what
     the walking option gets measured against in the note under it. */
  const runs = [
    { key: "best", opts: {} },
    { key: "fewer", opts: { changePenalty: PLAN.changePenaltyMin } },
    { key: "metro", opts: { allowBus: false } },
    { key: "ride", opts: { noDirect: true } },
  ];
  const out = [];
  for (const r of runs) {
    const res = search(g, from, to, r.opts);
    if (!res) continue;
    const p = toLegs(g, res, from, to);
    if (!p || !p.legs.length) continue;
    p.kind = r.key;
    if (!out.some(x => sameShape(x, p))) out.push(p);
  }
  const atNow = clockAt(departMs, 0);
  const service = { metro: metroRunning(atNow), bus: busRunning(atNow) };
  if (!out.length) return { departAt: departMs, itineraries: [], service, subrequests: budget.used,
    reason: noRideReason(service, g, from, to) };

  out.sort((a, b) => a.totalMin - b.totalMin);
  // the winner is the only one worth spending requests on
  await refineBoardings(out[0], g, budget);
  await refineWalks(out[0], budget, env);
  out.sort((a, b) => a.totalMin - b.totalMin);
  /* After refining, not before: a live ETA can turn a 40-minute guessed
     wait into a 4-minute real one, and the note has to describe the times
     the rider is actually being shown. */
  pruneWalk(out);
  explainWalk(out, service, g, from, to);

  return {
    departAt: departMs,
    itineraries: out.slice(0, 3),
    subrequests: budget.used,
    service,
    // whether real pedestrian routing was available at all, so the UI can
    // say "walking times are estimated" once instead of on every leg
    walkRouting: !!(env && env.ORS_KEY),
  };
}

/* Skip the D1 round-trip on every cron run when nothing is tracked.
 * Cached per isolate for a few minutes — adding a route is rare and
 * takes effect on the next refresh at the latest. */
let trackFlag = null;
async function trackingActive(env) {
  if (!dbReady(env)) return false;
  const nowS = Date.now() / 1000;
  if (trackFlag && nowS - trackFlag.at < 300) return trackFlag.on;
  let on = false;
  try {
    await initSchema(env);
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM tracked_route").first();
    on = !!(c && c.n > 0);
  } catch (_) { on = true; }          // on error, don't silently stop tracking
  trackFlag = { on, at: nowS };
  return on;
}

/* OPTIONAL self-tuning schedule. Cloudflare crons are static config, so
 * the only way to actually cut invocations is to rewrite them. If (and
 * only if) CF_API_TOKEN + CF_ACCOUNT_ID are configured, the worker
 * updates its own cron triggers to the narrowest set covering current
 * alert windows — no rules, no crons at all. Without those secrets this
 * is a no-op and you tune wrangler.toml by hand from /alerts/windows.
 *
 * Security note: that token can edit your Worker, so it is deliberately
 * opt-in. Scope it to "Workers Scripts: Edit" on this account only. */
let lastApplied = null;
async function applySchedule(env, crons) {
  if (!env || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { skipped: "not configured" };
  /* An empty PUT here removes every trigger, and the handler that would
     put them back only runs on a trigger. Alerts would stop for everyone,
     permanently, with nothing to see. cronFor() no longer returns an empty
     list; this is the second lock on the same door. */
  if (!Array.isArray(crons) || !crons.length) return { skipped: "refused empty schedule" };
  const script = env.CF_SCRIPT_NAME || "oasa-stop";
  const body = JSON.stringify(crons.map(c => ({ cron: c })));
  if (body === lastApplied) return { skipped: "unchanged" };
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}/schedules`,
      { method: "PUT", headers: {
          "Authorization": `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        }, body });
    if (r.ok) { lastApplied = body; return { applied: crons }; }
    return { error: `HTTP ${r.status}` };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

/* ======================= lines & live map ========================= */

// The whole line catalogue, trimmed to what the picker needs and cached
// for a day at the edge — it changes about once a timetable season.
async function handleLines() {
  const raw = await getJSON(`${OASA}?act=webGetLines`, ACT_TTL.webGetLines);
  const lines = (Array.isArray(raw) ? raw : []).map(l => ({
    code: String(pickField(l, "LineCode", "line_code") || ""),
    id: String(pickField(l, "LineID", "line_id") || ""),
    el: pickField(l, "LineDescr", "line_descr") || "",
    en: pickField(l, "LineDescrEng", "line_descr_eng") || "",
  })).filter(l => l.code && l.id);
  lines.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return new Response(JSON.stringify(lines), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ACT_TTL.webGetLines}`,
      ...CORS,
    },
  });
}

/* Live positions around a point. "Every bus in Athens" would be one
 * getBusLocation call per route — hundreds, far past the subrequest cap
 * — so we resolve the lines that actually serve the area and fetch those.
 * Budget: <=5 stop-list calls + <=10 route lookups + <=28 vehicle calls.
 * Cached 15s on a coarse key, so panning around is cheap for everyone. */
const LIVE = { radius: 900, stopProbe: 10, maxRoutes: 28, cache: 15 };

async function handleLive(url, env) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng required" }, 400);

  const ck = `https://live/?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`;
  const cache = caches.default;
  const hit = await cache.match(new Request(ck));
  if (hit) return withCors(hit);

  const lists = await Promise.all(samplePts(lat, lng, LIVE.radius).slice(0, 5).map(p =>
    getJSON(`${OASA}?act=getClosestStops&p1=${p[0]}&p2=${p[1]}`, ACT_TTL.getClosestStops)));
  const stops = [];
  const seen = new Set();
  for (const arr of lists) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const code = String(pickField(s, "StopCode", "StopID", "stop_code") || "");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const la = Number(pickField(s, "StopLat", "StopY", "stop_lat"));
      const ln = Number(pickField(s, "StopLng", "StopX", "stop_lng"));
      stops.push({ code, d: (isFinite(la) && isFinite(ln)) ? hav(lat, lng, la, ln) : Infinity });
    }
  }
  stops.sort((a, b) => a.d - b.d);

  const routes = new Map();
  await pool(stops.slice(0, LIVE.stopProbe).map(s => async () => {
    const r = await fetchStopRoutes(s.code);
    if (!r) return;
    for (const rt of r.routes) if (!routes.has(rt.code)) routes.set(rt.code, rt);
  }), 5);

  const buses = [];
  await pool([...routes.values()].slice(0, LIVE.maxRoutes).map(rt => async () => {
    const arr = await getJSON(
      `${OASA}?act=getBusLocation&p1=${encodeURIComponent(rt.code)}`, ACT_TTL.getBusLocation);
    for (const v of (Array.isArray(arr) ? arr : [])) {
      const la = Number(pickField(v, "CS_LAT", "cs_lat"));
      const ln = Number(pickField(v, "CS_LNG", "cs_lng"));
      const veh = String(pickField(v, "VEH_NO", "veh_no", "VEH_CODE") || "");
      if (!veh || !isFinite(la) || !isFinite(ln)) continue;
      buses.push({ veh, line: rt.id, routeCode: rt.code, el: rt.el, en: rt.en, lat: la, lng: ln });
    }
  }), 6);

  const res = new Response(JSON.stringify({
    origin: { lat, lng }, routes: routes.size, buses,
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${LIVE.cache}`,
      ...CORS,
    },
  });
  await cache.put(new Request(ck), res.clone());
  return res;
}

/* ==================== onboard scan (batched) ====================== *
 * The "which bus am I on?" fan-out used to run on the phone: ~14
 * getBusLocation calls per tap. Now it's ONE request — the fan-out
 * happens here as subrequests (which don't count against the daily
 * request quota) and the result is cached 10 s on a ~110 m grid, so
 * two riders scanning on the same bus share one answer. The precise
 * 100 m + GPS-accuracy filtering stays on the phone, which knows its
 * own exact fix; we return everything within a generous 1.5 km so
 * that filtering has raw material to work with.
 * ------------------------------------------------------------------ */
/* stopProbe/maxRoutes are deliberately wider than /live's: on a big
 * avenue the line you are actually riding is easily the 15th route to
 * turn up, and a candidate that is never fetched can never be matched.
 * Budget: 5 stop lists + 14 route lookups + 20 vehicle calls = 39, still
 * inside the 50-subrequest free-tier ceiling. The follow-up samples pass
 * ?routes= and cost 6. */
/* keepM: how far from the rider a vehicle may be and still be returned as
 * a candidate. It is NOT a polling radius — getBusLocation is fetched per
 * ROUTE and always returns that route's whole fleet, so this trims the
 * response, not the subrequest count. What sets the floor is staleness: a
 * bus's reported position lags reality by speed x age, and the client will
 * believe an age of up to ONBOARD.maxStaleS (75 s). At an urban 8 m/s that
 * is 600 m of lag; the extra 200 m covers GPS error and a faster arterial.
 * Drop this below ~700 m and the moving-bus matching regresses to only
 * finding your vehicle once it stops. */
const SCAN = { stopRadius: 600, stopProbe: 14, maxRoutes: 20, keepM: 800, cache: 10 };

/* OASA sometimes stamps each fix with its own time. If it does, the
 * client can measure real staleness per vehicle instead of assuming it.
 * Accept epoch seconds/ms or a parsable date string; ignore nonsense. */
function vehicleTs(v) {
  const raw = pickField(v, "CS_DATE", "cs_date", "CS_DATE_TIME", "LAST_UPDATE", "last_update");
  if (raw == null) return null;
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    const s = n > 1e11 ? Math.floor(n / 1000) : n;       // ms → s
    return (s > 1.5e9 && s < 4e9) ? s : null;
  }
  const t = Date.parse(String(raw));
  if (!isFinite(t)) return null;
  const s = Math.floor(t / 1000);
  return (s > 1.5e9 && s < 4e9) ? s : null;
}

async function handleScan(url) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat/lng required" }, 400);
  // The second (co-movement) sample must not be served from cache, and
  // only needs the candidate routes — one cheap request instead of a
  // second full fan-out.
  const fresh = url.searchParams.get("fresh") === "1";
  const only = (url.searchParams.get("routes") || "").split(",")
    .map(s => s.trim()).filter(Boolean).slice(0, 6);

  const ck = `https://scan/?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`;
  const cache = caches.default;
  if (!fresh && !only.length) {
    const hit = await cache.match(new Request(ck));
    if (hit) return withCors(hit);
  }

  const routes = new Map();
  if (only.length) {
    for (const code of only) routes.set(code, { code, id: "", el: "", en: "" });
  } else {
    // stops around the rider → the lines that serve them
    const lists = await Promise.all(samplePts(lat, lng, SCAN.stopRadius).map(p =>
      getJSON(`${OASA}?act=getClosestStops&p1=${p[0]}&p2=${p[1]}`, ACT_TTL.getClosestStops)));
    const stops = [];
    const seen = new Set();
    for (const arr of lists) {
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        const code = String(pickField(s, "StopCode", "StopID", "stop_code") || "");
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const la = Number(pickField(s, "StopLat", "StopY", "stop_lat"));
        const ln = Number(pickField(s, "StopLng", "StopX", "stop_lng"));
        stops.push({ code, d: (isFinite(la) && isFinite(ln)) ? hav(lat, lng, la, ln) : Infinity });
      }
    }
    stops.sort((a, b) => a.d - b.d);
    await pool(stops.slice(0, SCAN.stopProbe).map(s => async () => {
      const r = await fetchStopRoutes(s.code);
      if (r) for (const rt of r.routes) if (!routes.has(rt.code)) routes.set(rt.code, rt);
    }), 5);
  }

  // vehicle positions fetched fresh (ttl 0) — the 10 s scan cache above
  // is the sharing layer; stacking the 12 s /api cache under it would
  // serve up to 22 s-old positions to a feature that resolves 100 m.
  const buses = [];
  await pool([...routes.values()].slice(0, SCAN.maxRoutes).map(rt => async () => {
    const arr = await getJSON(`${OASA}?act=getBusLocation&p1=${encodeURIComponent(rt.code)}`, 0);
    for (const v of (Array.isArray(arr) ? arr : [])) {
      const veh = String(pickField(v, "VEH_NO", "veh_no", "VEH_CODE") || "");
      const la = Number(pickField(v, "CS_LAT", "cs_lat"));
      const ln = Number(pickField(v, "CS_LNG", "cs_lng"));
      if (!veh || !isFinite(la) || !isFinite(ln)) continue;
      // a moving rider's own bus can report a badly stale position, so the
      // keep-radius stays generous; the client does the real filtering
      if (!only.length && hav(lat, lng, la, ln) > SCAN.keepM) continue;
      buses.push({ veh, lat: la, lng: ln, ts: vehicleTs(v),
        route: { code: rt.code, id: rt.id, el: rt.el, en: rt.en } });
    }
  }), 6);

  const res = new Response(JSON.stringify({
    generated: Math.floor(Date.now() / 1000), buses,
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": (fresh || only.length) ? "no-store" : `public, max-age=${SCAN.cache}`,
      ...CORS,
    },
  });
  if (!fresh && !only.length) await cache.put(new Request(ck), res.clone());
  return res;
}

/* ============================ routing ============================= */

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "");
    const ip = clientIp(req);

    if (p.endsWith("/api")) {
      const act = url.searchParams.get("act");
      if (!act || !ALLOWED_ACTS.has(act)) return json({ error: "act not allowed" }, 400);
      // Cached reads are cheap and shared; only the cache-bypassing refine
      // path (nocache=1) actually hits OASA per request, so throttle that.
      const fresh = url.searchParams.get("nocache") === "1";
      if (fresh && !rateLimit(ip, "api-fresh", 60, 60)) return tooMany();
      const up = new URL(OASA);
      up.searchParams.set("act", act);
      for (const k of ["p1", "p2", "p3"]) {
        const v = url.searchParams.get(k);
        if (v != null) up.searchParams.set(k, v);
      }
      return proxy(up.toString(), fresh ? 0 : (ACT_TTL[act] || OASA_CACHE), fresh);
    }

    if (p.endsWith("/nearby")) return handleNearby(url, env, ctx);

    /* Type-ahead fires on almost every keystroke, so the ceiling here is
     * about the ORS daily quota rather than about OASA. The 24h edge
     * cache absorbs the repeats; this caps a single abusive client. */
    if (p.endsWith("/geocode")) {
      if (!rateLimit(ip, "geocode", 40, 60)) return tooMany();
      return handleGeocode(url, env);
    }

    if (p.endsWith("/reverse")) {
      const lat = url.searchParams.get("lat"), lon = url.searchParams.get("lon");
      if (!lat || !lon) return json({ error: "lat/lon required" }, 400);
      const n = new URL(NOMINATIM + "reverse");
      n.searchParams.set("format", "jsonv2");
      n.searchParams.set("lat", lat);
      n.searchParams.set("lon", lon);
      n.searchParams.set("addressdetails", "1");
      n.searchParams.set("accept-language", url.searchParams.get("lang") || "el");
      return proxy(n.toString(), GEO_CACHE);
    }

    /* GET /plan?from=lat,lng&to=lat,lng[&depart=<epoch ms>]
     * Not cached: the answer depends on the minute you asked. */
    if (p.endsWith("/plan")) {
      const parse = v => {
        const m = String(v || "").split(",").map(Number);
        return (m.length === 2 && isFinite(m[0]) && isFinite(m[1])) ? { lat: m[0], lng: m[1] } : null;
      };
      const from = parse(url.searchParams.get("from"));
      const to = parse(url.searchParams.get("to"));
      if (!from || !to) return json({ error: "from and to required as lat,lng" }, 400);
      if (hav(from.lat, from.lng, to.lat, to.lng) < 120)
        return json({ itineraries: [], reason: "tooclose" });
      const depart = Number(url.searchParams.get("depart")) || Date.now();
      try {
        const out = await planJourney(from, to, depart, env);
        return json(out);
      } catch (e) {
        return json({ error: "planner failed", detail: String((e && e.message) || e) }, 500);
      }
    }

    if (p.endsWith("/metro")) {
      return new Response(JSON.stringify(METRO_STATIONS.map(m => ({
        id: m.id, name: m.el, name_en: m.en, lines: m.lines, lat: m.lat, lng: m.lng,
      }))), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          ...CORS,
        },
      });
    }

    // Aggregated history: which buses/lines/stations collect the most
    // reports. Feeds any future public statistics page.
    //   /reports/toplist?days=30&type=breakdown&kind=bus
    if (p.endsWith("/reports/toplist")) {
      if (!dbReady(env)) return json({ error: "stats not configured" }, 501);
      await initSchema(env);
      const days = Math.min(365, Math.max(1, +(url.searchParams.get("days") || 30)));
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const type = url.searchParams.get("type");   // e.g. breakdown; omit = all
      const kind = url.searchParams.get("kind");   // bus | metro; omit = both
      const cond = ["ts>?"], args = [since];
      if (type) { cond.push("type=?"); args.push(type); }
      if (kind) { cond.push("kind=?"); args.push(kind); }
      const { results } = await env.DB.prepare(
        `SELECT kind, type, target_id, target_name, line_id,
                COUNT(*) reports, MAX(ts) last_ts
         FROM report_log WHERE ${cond.join(" AND ")}
         GROUP BY kind, target_id, type ORDER BY reports DESC LIMIT 30`)
        .bind(...args).all();
      return json({ days, type: type || "all", kind: kind || "all", top: results || [] });
    }

    if (p.endsWith("/reports") || p.endsWith("/reports/delete")) {
      if (req.method === "POST") {
        // filing is the abusable one; withdrawing your own is harmless
        const del = p.endsWith("/delete");
        if (!rateLimit(ip, del ? "reports-del" : "reports", del ? 30 : 8, 60)) return tooMany();
      }
      return handleReports(req, url, env, ctx);
    }

    /* What the cron schedule *should* be, from the live rules. Admin —
       it summarises when users have alerts. Paste `crons` into
       wrangler.toml, or set the CF API secrets to auto-apply. */
    if (p.endsWith("/alerts/windows")) {
      if (!adminOK(req, env)) return json({ error: "admin token required" }, 403);
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      const windows = windowsOf(await readRules(env));
      const crons = cronFor(windows);
      const out = {
        rules: windows.length, athensUtcOffset: athensUtcOffsetHours(),
        windows: windows.map(w => ({ days: w.days,
          from: `${String(Math.floor(w.from / 60)).padStart(2, "0")}:${String(w.from % 60).padStart(2, "0")}`,
          to: `${String(Math.floor(w.to / 60)).padStart(2, "0")}:${String(w.to % 60).padStart(2, "0")}`,
          leadMin: w.lead })),
        crons: crons.length ? crons : ["(none — no active alert rules)"],
        estimatedRunsPerDay: crons.length ? estimateRuns(crons) : 0,
      };
      if (url.searchParams.get("apply") === "1") out.apply = await applySchedule(env, crons);
      return json(out);
    }

    /* Wipe reports (e.g. false flags from testing). Admin only.
       body: { all:true } | { targetId } | { type }  (+ log:true, hours:N
       to also delete the matching rows from the D1 history log). */
    if (p.endsWith("/admin/reports/purge") && req.method === "POST") {
      if (!adminOK(req, env)) return json({ error: "admin token required" }, 403);
      if (!reportsReady(env)) return json({ error: "reports not configured" }, 501);
      const b = await req.json().catch(() => null) || {};
      const nowS = Math.floor(Date.now() / 1000);
      const active = await readReports(env, nowS);
      const match = r => (b.all === true) ||
        (b.targetId && r.targetId === String(b.targetId)) ||
        (b.type && r.type === String(b.type));
      if (!b.all && !b.targetId && !b.type) {
        return json({ error: "specify all:true, targetId, or type" }, 400);
      }
      const keep = active.filter(r => !match(r));
      const removedLive = active.length - keep.length;
      await writeReports(env, keep);

      let removedLog = 0;
      if (b.log === true && dbReady(env)) {
        await initSchema(env);
        const since = b.hours ? nowS - Math.min(8760, +b.hours) * 3600 : 0;
        const cond = ["ts > ?"], args = [since];
        if (b.targetId) { cond.push("target_id = ?"); args.push(String(b.targetId)); }
        if (b.type) { cond.push("type = ?"); args.push(String(b.type)); }
        const res = await env.DB.prepare(
          `DELETE FROM report_log WHERE ${cond.join(" AND ")}`).bind(...args).run();
        removedLog = (res && res.meta && res.meta.changes) || 0;
      }
      return json({ ok: true, removedLive, removedLog, remaining: keep.length });
    }

    /* A stop the client found has no lines any more. Never trust that
       claim — a malicious caller could hide healthy stops for everyone —
       so verify against OASA here and only then record it in the shared
       KV map that /nearby filters on. */
    if (p.endsWith("/stops/dead") && req.method === "POST") {
      if (!rateLimit(ip, "stops-dead", 30, 60)) return tooMany();
      const b = await req.json().catch(() => null);
      const code = String((b && b.code) || "").slice(0, 20);
      if (!code) return json({ error: "code required" }, 400);
      const r = await fetchStopRoutes(code);
      if (!r) return json({ error: "upstream unavailable" }, 502);
      const nowS = Math.floor(Date.now() / 1000);
      const known = await loadStopLines(env);
      slSet(known, code, r.lines.length, nowS);
      if (ctx) ctx.waitUntil(saveStopLines(env));
      return json({ code, dead: r.lines.length === 0, lines: r.lines.length });
    }

    /* Usage at a glance, so you don't have to dig through the Cloudflare
       dashboard. Unauthenticated it's a bare liveness ping (safe for an
       uptime monitor); with the admin token it reports the numbers that
       actually decide when you'd need to pay — reports drive KV writes,
       which is the ceiling that gives way first. */
    /* POST /pulse?mode=app|web  — "the app was opened".
     * POST /pulse?ev=install    — "the browser installed it".
     * Increments a number and stores nothing else; see bumpUsage. The
     * rate limit is generous because a legitimate client sends one of
     * these per cold boot and no more. */
    if (p.endsWith("/pulse")) {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      if (!rateLimit(ip, "pulse", 20, 60)) return tooMany();
      const ev = url.searchParams.get("ev") === "install" ? "install" : "open";
      const kinds = ev === "install" ? ["install"]
        : (url.searchParams.get("mode") === "app" ? ["open", "open_app"] : ["open"]);
      if (kinds.some(k => !USAGE_KINDS.has(k))) return json({ error: "bad kind" }, 400);
      let counted = false;
      try { counted = await bumpUsage(env, kinds); } catch (_) { /* never fail a boot */ }
      return json({ ok: true, counted });
    }

    /* GET /stats/usage?token=&days=30 — the daily series behind /health. */
    if (p.endsWith("/stats/usage")) {
      if (!adminOK(req, env)) return json({ error: "forbidden" }, 403);
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const u = await readUsage(env, days);
      return json(u || { error: "no database configured" }, u ? 200 : 501);
    }

    /* GET /walk?from=lat,lng&to=lat,lng — one pedestrian route, on demand.
     *
     * planJourney routes only the itinerary it ranks first, because before
     * anyone has chosen, that is the only one worth spending requests on.
     * The cost of that is that opening the second or third option drew a
     * straight line across the blocks — an answer that looks like a route
     * and is not one. This fills the geometry in at the moment a rider
     * actually looks at a leg, which is both cheaper and better timed.
     *
     * Cached hard: the pavement between two fixed points does not change,
     * so the second person to open the same leg costs nothing. */
    if (p.endsWith("/walk")) {
      if (!rateLimit(ip, "walk", 30, 60)) return tooMany();
      const pt = v => {
        const m = String(v || "").split(",").map(Number);
        return (m.length === 2 && isFinite(m[0]) && isFinite(m[1])) ? { lat: m[0], lng: m[1] } : null;
      };
      const a = pt(url.searchParams.get("from")), b = pt(url.searchParams.get("to"));
      if (!a || !b) return json({ error: "from/to required" }, 400);
      if (!(env && env.ORS_KEY)) return json({ error: "no walking router configured" }, 501);
      // five decimals ≈ 1 m: enough to be the same doorway, coarse enough to share
      const ck = new Request(`https://walk/?a=${a.lat.toFixed(5)},${a.lng.toFixed(5)}` +
        `&b=${b.lat.toFixed(5)},${b.lng.toFixed(5)}`);
      const cache = caches.default;
      const hit = await cache.match(ck);
      if (hit) return withCors(hit);
      const r = await routeWalk(a, b, env);
      if (!r) return json({ error: "router unavailable" }, 502);
      const out = json({ min: Math.round(r.min * 10) / 10,
        metres: Math.round(r.metres), path: r.path, basis: "routed" });
      out.headers.set("Cache-Control", `public, max-age=${WALK_CACHE}`);
      ctx.waitUntil(cache.put(ck, out.clone()));
      return out;
    }

    if (p.endsWith("/health")) {
      const full = adminOK(req, env);
      const nowS = Math.floor(Date.now() / 1000);
      const out = { ok: true, version: APP_VERSION, time: nowS };
      if (!full) return json(out);

      out.bindings = { kv: !!env.ALERTS, d1: !!env.DB,
        // ORS drives BOTH the walking geometry and the address autocomplete,
        // so "why is the walk a straight line" and "why are house numbers
        // missing" are usually the same question, answered here.
        ors: !!env.ORS_KEY,
        push: pushReady(env), admin: true, selfTuneCron: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID) };

      if (env.ALERTS) {
        try {
          const active = await readReports(env, nowS);
          const byType = {};
          for (const r of active) byType[r.type] = (byType[r.type] || 0) + 1;
          out.reports = { activeNow: active.length, byType };
        } catch (_) { }
        try {
          const rules = (await readRules(env)).filter(r => r && r.enabled !== false);
          const w = windowsOf(rules);
          out.alerts = { rules: rules.length, dueNow: windowDue(w, athensNow()),
            cronSuggestion: cronFor(w),
            estimatedCronRunsPerDay: w.length ? estimateRuns(cronFor(w)) : 0 };
        } catch (_) { }
        try {
          const known = await loadStopLines(env);
          out.deadStopIndex = known.size;
        } catch (_) { }
      }

      /* The two questions "is the scheduler still calling us" and "has a
         push ever gone out" had no answer at all, which is why an alert
         that never arrived could not be told from a cron that had stopped.
         They need different fixes, so they need different answers. Outside
         the KV block on purpose: this is about the scheduler, not storage,
         and it must report even when alerts are unconfigured. */
      if (dbReady(env)) {
        try {
          const cronLast = Number(await getMeta(env, "cron_last")) || 0;
          const alertLast = Number(await getMeta(env, "alert_last")) || 0;
          out.cron = { lastRun: cronLast || null,
            agoSec: cronLast ? nowS - cronLast : null,
            healthy: !!cronLast && nowS - cronLast < 15 * 60 };
          out.alerts = Object.assign(out.alerts || {}, {
            lastSent: alertLast || null,
            lastSentAgoSec: alertLast ? nowS - alertLast : null });
        } catch (_) { }
        try {
          // today and the last 30 days, the two numbers worth a glance
          const u = await readUsage(env, 30);
          out.usage = { last30: u.total, today: u.byDay[dayKey(Date.now())] || {},
            note: "opens, not people — see /stats/usage" };
        } catch (_) { }
        try {
          await initSchema(env);
          const d1 = await env.DB.prepare(
            `SELECT COUNT(*) total,
                    SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) day,
                    SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) week
             FROM report_log`).bind(nowS - 86400, nowS - 7 * 86400).first();
          const tr = await env.DB.prepare("SELECT COUNT(*) n FROM tracked_route").first();
          const ev = await env.DB.prepare(
            "SELECT COUNT(*) n FROM stop_event WHERE ts > ?").bind(nowS - 86400).first();
          out.history = { reportsLogged: (d1 && d1.total) || 0,
            last24h: (d1 && d1.day) || 0, last7d: (d1 && d1.week) || 0 };
          out.tracking = { routes: (tr && tr.n) || 0, eventsLast24h: (ev && ev.n) || 0 };
        } catch (_) { }
      }

      /* The number that matters: every report is one KV write, and the
         free plan allows 1,000/day. Everything else has far more slack. */
      const writes = (out.history && out.history.last24h) || 0;
      out.freePlanUsage = {
        kvWritesLast24h: writes, kvWriteLimitPerDay: 1000,
        kvWritesPercent: Math.round(writes / 10),
        note: writes > 700 ? "approaching the KV write ceiling — see README (move reports to D1)"
          : "comfortable",
      };
      return json(out);
    }

    /* Search stops by name anywhere in Athens. OASA has no stop-name
       search, so we geocode the query (Nominatim, same path the address
       search already uses) and ask for the stops around that point —
       two cached calls, no index to build or keep fresh. */
    if (p.endsWith("/stops/search")) {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ stops: [] });
      if (!rateLimit(ip, "stopsearch", 30, 60)) return tooMany();

      const ck = `https://stopsearch/?q=${encodeURIComponent(q.toLowerCase())}`;
      const cache = caches.default;
      const hit = await cache.match(new Request(ck));
      if (hit) return withCors(hit);

      let pt = null;
      for (const cand of geocodeCandidates(q)) {
        const data = await getJSON(nominatimSearchUrl(cand, "el"), GEO_CACHE);
        if (Array.isArray(data) && data.length) {
          pt = { lat: Number(data[0].lat), lng: Number(data[0].lon),
            label: data[0].display_name || cand };
          break;
        }
      }
      if (!pt || !isFinite(pt.lat)) return json({ stops: [], place: null });

      const raw = await getJSON(
        `${OASA}?act=getClosestStops&p1=${pt.lat}&p2=${pt.lng}`, ACT_TTL.getClosestStops);
      const norm = s => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const needle = norm(q);
      let stops = (Array.isArray(raw) ? raw : []).map(s => {
        const la = Number(pickField(s, "StopLat", "StopY", "stop_lat"));
        const ln = Number(pickField(s, "StopLng", "StopX", "stop_lng"));
        return {
          code: String(pickField(s, "StopCode", "StopID", "stop_code") || ""),
          name_el: pickField(s, "StopDescr", "StopDescrEng") || "",
          name_en: pickField(s, "StopDescrEng", "StopDescr") || "",
          street: pickField(s, "StopStreet", "StopStreetEng") || "",
          lat: la, lng: ln,
          dist: (isFinite(la) && isFinite(ln)) ? hav(pt.lat, pt.lng, la, ln) : Infinity,
        };
      }).filter(s => s.code && isFinite(s.dist));
      // a stop actually named like the query wins over merely nearby ones
      stops.forEach(s => { s.named = norm(s.name_el).includes(needle) || norm(s.name_en).includes(needle); });
      stops.sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || a.dist - b.dist);
      stops = stops.slice(0, 12);

      const res = new Response(JSON.stringify({ place: pt.label, origin: { lat: pt.lat, lng: pt.lng }, stops }), {
        headers: { "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600", ...CORS },
      });
      await cache.put(new Request(ck), res.clone());
      return res;
    }

    if (p.endsWith("/lines")) return handleLines();

    if (p.endsWith("/live")) {
      if (!rateLimit(ip, "live", 30, 60)) return tooMany();
      return handleLive(url, env);
    }

    if (p.endsWith("/scan")) {
      if (!rateLimit(ip, "scan", 30, 60)) return tooMany();
      return handleScan(url);
    }

    if (p.endsWith("/push/key")) {
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      return json({ key: env.VAPID_PUBLIC_KEY });
    }

    if (p.endsWith("/push/subscribe") && req.method === "POST") {
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      if (!rateLimit(ip, "push-sub", 15, 60)) return tooMany();
      const b = await req.json().catch(() => null);
      if (!b || !b.subscription || !b.subscription.endpoint) return json({ error: "bad subscription" }, 400);
      const id = b.id || crypto.randomUUID();
      await env.ALERTS.put(`sub:${id}`, JSON.stringify(b.subscription));
      return json({ id });
    }

    if (p.endsWith("/push/test") && req.method === "POST") {
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      if (!rateLimit(ip, "push-test", 15, 60)) return tooMany();
      const b = await req.json().catch(() => null);
      const sub = b && b.sub ? await env.ALERTS.get(`sub:${b.sub}`, "json") : null;
      if (!sub) return json({ error: "unknown subscription" }, 404);
      const status = await sendPush(sub, {
        title: "OASAx ✓", body: "Οι ειδοποιήσεις δουλεύουν.", tag: "test", url: "./",
      }, env);
      return json({ ok: status < 300, status });
    }

    if (p.endsWith("/rules")) {
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      if (req.method === "GET") {
        // A sub is the caller's own token; requiring it means you can only
        // read YOUR rules. Without it we used to return everyone's — which
        // leaked every user's stop, line, commute window and sub token.
        const sub = url.searchParams.get("sub");
        if (!sub) return json({ error: "sub required" }, 400);
        const all = await readRules(env);
        return json(all.filter(r => r.sub === sub));
      }
      if (req.method === "POST") {
        if (!rateLimit(ip, "rules", 15, 60)) return tooMany();
        const r = await req.json().catch(() => null);
        if (!r || !r.sub || !r.stopCode) return json({ error: "bad rule" }, 400);
        r.id = r.id || crypto.randomUUID();
        if (r.enabled == null) r.enabled = true;
        const all = await readRules(env);
        const i = all.findIndex(x => x.id === r.id);
        // don't let a POST overwrite a rule that belongs to a different sub
        if (i >= 0 && all[i].sub !== r.sub) return json({ error: "not yours" }, 403);
        if (i >= 0) all[i] = r; else all.push(r);
        await writeRules(env, all);
        return json(r);
      }
    }

    if (p.endsWith("/rules/delete") && req.method === "POST") {
      if (!pushReady(env)) return json({ error: "push not configured" }, 501);
      if (!rateLimit(ip, "rules-del", 30, 60)) return tooMany();
      const b = await req.json().catch(() => null);
      if (!b || !b.id || !b.sub) return json({ error: "id and sub required" }, 400);
      const all = await readRules(env);
      const rule = all.find(x => x.id === b.id);
      if (!rule) return json({ error: "not found" }, 404);
      // only the owner (matching sub) may delete — was: anyone with the id
      if (rule.sub !== b.sub) return json({ error: "not yours" }, 403);
      await writeRules(env, all.filter(x => x.id !== b.id));
      return json({ ok: true });
    }

    /* ---------------- tracking + stats (needs D1) ----------------- */
    if (p.includes("/track") || p.includes("/stats")) {
      if (!dbReady(env)) return json({ error: "tracking not configured" }, 501);
      // Mutations (add/remove/sample) are admin actions — require the
      // ADMIN_TOKEN secret. Reads (/track/list, /stats*) stay public: they
      // expose only aggregate service quality, nothing user-specific.
      const isMutation = p.endsWith("/track/add") || p.endsWith("/track/remove") ||
        p.endsWith("/track/sample");
      if (isMutation && !adminOK(req, env)) {
        return json({ error: "admin token required" }, 403);
      }
      await initSchema(env);

      if (p.endsWith("/track/list")) {
        const { results } = await env.DB.prepare(
          `SELECT t.route_code, t.line_id, t.descr, t.added_at,
                  (SELECT COUNT(*) FROM stop_event e WHERE e.route_code=t.route_code) events,
                  (SELECT MIN(ts)   FROM stop_event e WHERE e.route_code=t.route_code) first_ts,
                  (SELECT MAX(ts)   FROM stop_event e WHERE e.route_code=t.route_code) last_ts,
                  (SELECT COUNT(DISTINCT veh) FROM stop_event e WHERE e.route_code=t.route_code) vehicles
           FROM tracked_route t ORDER BY t.added_at`).all();
        return json(results || []);
      }
      if (p.endsWith("/track/add") && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !b.route_code) return json({ error: "route_code required" }, 400);
        const c = await env.DB.prepare("SELECT COUNT(*) n FROM tracked_route").first();
        if (c && c.n >= TRACK.maxRoutes) return json({ error: "limit", max: TRACK.maxRoutes }, 400);
        await env.DB.prepare(
          `INSERT INTO tracked_route(route_code, line_id, line_code, descr, added_at) VALUES(?,?,?,?,?)
           ON CONFLICT(route_code) DO UPDATE SET line_id=excluded.line_id, descr=excluded.descr`)
          .bind(String(b.route_code), String(b.line_id || ""), String(b.line_code || ""),
                String(b.descr || ""), Math.floor(Date.now() / 1000)).run();
        return json({ ok: true });
      }
      if (p.endsWith("/track/remove") && req.method === "POST") {
        const b = await req.json().catch(() => null);
        if (!b || !b.route_code) return json({ error: "route_code required" }, 400);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM tracked_route WHERE route_code=?").bind(String(b.route_code)),
          env.DB.prepare("DELETE FROM veh_state WHERE route_code=?").bind(String(b.route_code)),
        ]);
        return json({ ok: true });
      }
      if (p.endsWith("/track/sample") && req.method === "POST") {
        return json(await sampleVehicles(env));     // manual trigger, handy for testing
      }
      if (p.endsWith("/stats/bunching")) {
        return json(await bunchingIncidents(env, url.searchParams.get("route"),
          +(url.searchParams.get("days") || 7), 40));
      }
      if (p.endsWith("/stats/missing")) {
        return json(await missingService(env, url.searchParams.get("route"),
          +(url.searchParams.get("days") || 7), 25));
      }
      if (p.endsWith("/stats")) {
        const route = url.searchParams.get("route");
        if (!route) return json({ error: "route required" }, 400);
        return json(await routeStats(env, route, +(url.searchParams.get("days") || 7)));
      }
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const now = athensNow();
      const daily = (() => {
        const h = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Athens", hour: "2-digit", minute: "2-digit", hour12: false,
        }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
        return h.hour === "04" && +h.minute < 2;
      })();

      // Cheapest possible no-op minute: one small KV read tells us whether
      // any alert window is near. Nothing due and no tracking → stop here,
      // touching neither OASA nor D1.
      let windows = [];
      if (pushReady(env)) {
        try { windows = windowsOf(await readRules(env)); } catch (_) { }
      }
      /* Proof of life, written before anything that can fail. Without it
         "alerts stopped working" and "the scheduler stopped calling us"
         look identical from the outside, and they need opposite fixes. */
      await setMeta(env, "cron_last", Math.floor(Date.now() / 1000));
      try { await bumpUsage(env, ["cron"]); } catch (_) {}

      const alertsDue = windowDue(windows, now);
      if (alertsDue) await runAlerts(env);
      if (await trackingActive(env)) await sampleVehicles(env);
      if (daily) {
        await syncSchedules(env);
        await pruneOld(env);
        // Keep the cron schedule itself matched to the current rules
        // (no-op unless the CF API secrets are configured).
        await applySchedule(env, cronFor(windows));
      }
    })());
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
function withCors(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}
