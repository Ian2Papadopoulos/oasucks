/**
 * Στάση — Cloudflare Worker backend (v4)
 * ------------------------------------------------------------------
 *  GET  /api?act=...            → OASA telematics proxy (CORS, 8s timeout, retry)
 *  GET  /geocode?q=...          → address search; accepts greeklish ("filotimou")
 *  GET  /reverse?lat=&lon=      → coordinates → address
 *  GET  /push/key               → VAPID public key (for the browser to subscribe)
 *  POST /push/subscribe         → store a push subscription, returns its id
 *  POST /push/test              → send a test notification
 *  GET  /rules?sub=ID           → list alert rules
 *  POST /rules                  → create/update an alert rule
 *  POST /rules/delete           → delete an alert rule
 *  GET  /health                 → liveness; +admin token = usage summary
 *  GET  /stops/search?q=        → find stops by place/stop name
 *  GET  /alerts/windows         → when alerts need the cron (admin)
 *  POST /admin/reports/purge    → wipe reports / history rows (admin)
 *  POST /stops/dead             → verify+record a stop that has no lines
 *  GET  /reports?by=ID          → active user reports (inspector/issue flags)
 *  POST /reports                → file (or renew) a report
 *  POST /reports/delete         → withdraw a report (reporter-only)
 *  GET  /metro                  → static Athens metro station list
 *  GET  /lines                  → every OASA line (id, code, description)
 *  GET  /live?lat=&lng=         → live vehicle positions around a point
 *  GET  /scan?lat=&lng=         → batched "which bus am I on?" candidates
 *  cron (every minute)          → check live arrivals, fire push alerts
 *
 * Alerts need a KV namespace bound as ALERTS and VAPID secrets; without
 * them the app still works fully, alerts just report "not configured".
 */

const APP_VERSION = "v27";
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

async function timedFetch(urlStr, cacheTtl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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

async function getJSON(urlStr, cacheTtl) {
  try {
    const r = await timedFetch(urlStr, cacheTtl);
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

async function handleGeocode(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);
  const lang = url.searchParams.get("lang") || "el";
  for (const cand of geocodeCandidates(q)) {
    const data = await getJSON(nominatimSearchUrl(cand, lang), GEO_CACHE);
    if (Array.isArray(data) && data.length) {
      return json(data.map(d => ({
        lat: d.lat, lon: d.lon, display_name: d.display_name,
        address: d.address || null, matched: cand,
      })));
    }
  }
  return json([]);
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
function cronFor(windows) {
  if (!windows.length) return [];                 // nothing to do: no cron at all
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
    // "which line gets the most inspector reports" — will read from.
    `CREATE TABLE IF NOT EXISTS report_log(id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts INTEGER, kind TEXT, type TEXT, target_id TEXT, target_name TEXT,
       line_id TEXT, route_code TEXT, renewed INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ix_rl_ts ON report_log(ts)`,
    `CREATE INDEX IF NOT EXISTS ix_rl_target ON report_log(kind, target_id, ts)`,
  ];
  await env.DB.batch(stmts.map(s => env.DB.prepare(s)));
  schemaDone = true;
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

async function pruneOld(env) {
  if (!dbReady(env)) return;
  await initSchema(env);
  const cutoff = Math.floor(Date.now() / 1000) - TRACK.retentionDays * 86400;
  await env.DB.prepare("DELETE FROM stop_event WHERE ts < ?").bind(cutoff).run();
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
  const limit = Math.min(12, Math.max(1, +(url.searchParams.get("limit") || 8)));
  const markers = Math.min(150, Math.max(limit, +(url.searchParams.get("markers") || 60)));
  // Map pins show the stop name now, so line metadata is only needed for the
  // stops the list renders. Everything else lazy-loads when its popup opens.
  const withRoutes = limit;

  // ~110m cache granularity, so a whole street corner shares one response
  const ck = `https://nearby/?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}&r=${radius}&l=${limit}&m=${markers}`;
  const cache = caches.default;
  const hit = await cache.match(new Request(ck));
  if (hit) return withCors(hit);

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
  const used = samplePts(lat, lng, radius).length + limit;      // stop-lists + arrivals
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
    try { reports = (await readReports(env, now)).map(r => publicReport(r, "")); } catch (_) { }
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
  return res;
}

/* ====================== user reports (KV) ========================= *
 * Community flags: "ticket inspector" (red) or a service issue
 * (yellow) attached to a specific bus, stop, or metro station.
 *
 * Rules, straight from the spec:
 *   - inspector (red) on a bus or stop      → expires after 15 min
 *   - inspector (red) on a metro station    → expires after 2 h
 *   - anything else (yellow), any target    → expires after 60 min
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
/* What may be flagged, and with what. A rider reports from inside a bus
 * or standing at a metro station — those are the only two categories —
 * and each one has its own short menu (inspector = red, rest = yellow). */
const REPORT_TYPES = {
  bus: new Set(["breakdown", "crowded", "inspector"]),
  metro: new Set(["inspector"]),
};
const YELLOW_TTL = 3600;          // 60 min for every yellow flag
const RED_TTL = 900;              // 15 min: inspectors hop off after a few stops
const RED_METRO_TTL = 7200;       // 2 h on the metro, per spec
const MAX_ACTIVE_PER_REPORTER = 10;

function reportTtl(r) {
  if (r.type !== "inspector") return YELLOW_TTL;
  return r.kind === "metro" ? RED_METRO_TTL : RED_TTL;
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
// What clients see: everything except the reporter token.
function publicReport(r, by) {
  const out = {
    id: r.id, kind: r.kind, type: r.type,
    veh: r.veh || null, routeCode: r.routeCode || null, lineId: r.lineId || null,
    targetId: r.targetId, targetName: r.targetName || "",
    lat: r.lat, lng: r.lng, at: r.at, expires: r.at + reportTtl(r),
  };
  if (by && r.by === by) out.mine = true;
  return out;
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
    const active = await readReports(env, now);
    return json(active.map(r => publicReport(r, by)));
  }

  const b = await req.json().catch(() => null);
  if (!b) return json({ error: "bad body" }, 400);
  const by = String(b.by || "");
  if (by.length < 8 || by.length > 80) return json({ error: "by required" }, 400);

  const active = await readReports(env, now);

  if (url.pathname.replace(/\/+$/, "").endsWith("/reports/delete")) {
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
  // reporter files their own record (which also keeps the flag alive,
  // and keeps withdrawal rights separate per user).
  const mine = active.find(r =>
    r.by === by && r.kind === kind && r.type === type && r.targetId === targetId);
  if (mine) {
    Object.assign(mine, fields, { at: now });
    await writeReports(env, active);
    if (ctx) ctx.waitUntil(logReport(env, mine, now, true));
    return json(publicReport(mine, by));
  }
  if (active.filter(r => r.by === by).length >= MAX_ACTIVE_PER_REPORTER) {
    return json({ error: "too many active reports" }, 429);
  }
  const rec = { id: crypto.randomUUID(), by, at: now, ...fields };
  active.push(rec);
  await writeReports(env, active);
  if (ctx) ctx.waitUntil(logReport(env, rec, now, false));
  return json(publicReport(rec, by));
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
const SCAN = { stopRadius: 600, stopProbe: 10, maxRoutes: 14, keepM: 1500, cache: 10 };

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

    if (p.endsWith("/geocode")) return handleGeocode(url);

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
    //   /reports/toplist?days=30&type=inspector&kind=metro
    if (p.endsWith("/reports/toplist")) {
      if (!dbReady(env)) return json({ error: "stats not configured" }, 501);
      await initSchema(env);
      const days = Math.min(365, Math.max(1, +(url.searchParams.get("days") || 30)));
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const type = url.searchParams.get("type");   // e.g. inspector; omit = all
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
        const bucket = p.endsWith("/delete") ? "reports-del" : "reports";
        const limit = p.endsWith("/delete") ? 30 : 20;
        if (!rateLimit(ip, bucket, limit, 60)) return tooMany();
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
    if (p.endsWith("/health")) {
      const full = adminOK(req, env);
      const nowS = Math.floor(Date.now() / 1000);
      const out = { ok: true, version: APP_VERSION, time: nowS };
      if (!full) return json(out);

      out.bindings = { kv: !!env.ALERTS, d1: !!env.DB,
        push: pushReady(env), admin: true, selfTuneCron: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID) };

      if (env.ALERTS) {
        try {
          const active = await readReports(env, nowS);
          out.reports = { activeNow: active.length,
            red: active.filter(r => r.type === "inspector").length };
        } catch (_) { }
        try {
          const rules = (await readRules(env)).filter(r => r && r.enabled !== false);
          const w = windowsOf(rules);
          out.alerts = { rules: rules.length, cronSuggestion: cronFor(w),
            estimatedCronRunsPerDay: w.length ? estimateRuns(cronFor(w)) : 0 };
        } catch (_) { }
        try {
          const known = await loadStopLines(env);
          out.deadStopIndex = known.size;
        } catch (_) { }
      }

      if (dbReady(env)) {
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
        title: "Στάση ✓", body: "Οι ειδοποιήσεις δουλεύουν.", tag: "test", url: "./",
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
