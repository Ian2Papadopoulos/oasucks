/* One command that asks the app how it is, and answers in plain words.
 *
 *     ADMIN_TOKEN=... npm run checkup
 *
 * On Windows PowerShell:
 *     $env:ADMIN_TOKEN="..."; npm run checkup
 *
 * Why this exists: /health and /alerts/why are complete and unreadable.
 * They are written for someone holding the whole system in their head, and
 * nobody holds a system in their head at 8am when the phone did not buzz.
 * This reads both, applies the thresholds that actually matter, and says
 * what is fine, what to look at, and what to do about it.
 *
 * It reads and changes nothing. Exit code 1 if anything needs attention,
 * so it can be dropped into a scheduled task later.
 */
const TOKEN = process.env.ADMIN_TOKEN || process.argv[3];
const HOST = (process.env.OASAX_HOST || process.argv[2] || "https://oasax.com")
  .replace(/\/$/, "");

if (!TOKEN) {
  console.error("Set ADMIN_TOKEN first. PowerShell: $env:ADMIN_TOKEN=\"...\"");
  process.exit(2);
}

/* Three verdicts, because three is what a person can act on. OK needs no
   thought. LOOK is "true, not urgent, decide when you have a minute".
   FIX is "this is costing you something right now". */
const lines = [];
let worst = 0;
const say = (level, what, detail) => {
  const rank = { OK: 0, LOOK: 1, FIX: 2 }[level];
  if (rank > worst) worst = rank;
  lines.push({ level, what, detail });
};

const get = async path => {
  const r = await fetch(`${HOST}${path}`, { headers: { "X-Admin-Token": TOKEN } });
  if (!r.ok) throw new Error(`${path} answered HTTP ${r.status}`);
  return r.json();
};

let health, why;
try {
  health = await get("/health");
} catch (e) {
  console.error(`\nCould not reach the app: ${e.message}`);
  console.error("If that is a 403, the token is wrong. If it is a timeout, check the domain.\n");
  process.exit(2);
}
try { why = await get("/alerts/why"); } catch (_) { why = null; }

const ago = s => s == null ? "never"
  : s < 90 ? `${s} seconds ago`
  : s < 5400 ? `${Math.round(s / 60)} minutes ago`
  : s < 172800 ? `${Math.round(s / 3600)} hours ago`
  : `${Math.round(s / 86400)} days ago`;

/* ---- is it alive, and is it the version you think ---- */
say("OK", `The app is up, running ${health.version}.`);

/* ---- can OASA be reached ---- */
const up = health.upstream || {};
if (!up.open) {
  say("OK", "OASA is answering normally.");
} else {
  const why2 = (up.lastFail && up.lastFail.why) || "no answer";
  say("FIX", `OASA is NOT answering (${why2}).`,
    "Nothing you can fix — it is their server. Riders see a bar saying so. "
    + "It clears itself; check again in ten minutes.");
}

/* ---- the sharing that keeps us off their bad side ---- *
   This is the one number the whole load story rests on. */
const b = health.budget || {};
if (typeof b.cachedShare === "string" && b.cachedShare.endsWith("%")) {
  const share = parseInt(b.cachedShare, 10);
  if (b.upstreamCalls < 20) {
    say("OK", `Too quiet to judge sharing yet (${b.upstreamCalls} calls since this server started).`,
      "Open the app on your phone for a minute, then run this again.");
  } else if (share >= 50) {
    say("OK", `${b.cachedShare} of requests to OASA were answered from our own cache.`,
      "This is what keeps them from noticing us. Higher is better.");
  } else {
    say("FIX", `Only ${b.cachedShare} of requests to OASA came from cache.`,
      "The cache is not doing its job, so real load on OASA is much higher than intended. "
      + "Tell Claude: 'cachedShare is " + b.cachedShare + "'.");
  }
} else {
  say("LOOK", "No cache figures yet.", "This server has not called OASA since it started.");
}
if (b.shedThisIsolate > 0) {
  say("LOOK", `Hit our own ceiling ${b.shedThisIsolate} times.`,
    "Riders got slightly older times instead of the app getting blocked. "
    + "That is the design working. If it happens a lot, the app has more users than "
    + "this setup was sized for — worth telling Claude.");
}

/* ---- the scheduler ---- */
const cron = health.cron || {};
if (cron.healthy) say("OK", `The background scheduler ran ${ago(cron.agoSec)}.`);
else say("FIX", "The background scheduler is NOT running.",
  "No alert can fire until this is fixed. Check [triggers] in wrangler.toml, then redeploy.");

/* ---- alerts ---- */
const al = health.alerts || {};
if (!(health.bindings || {}).push) {
  say("FIX", "Notifications are not configured on the server.",
    "The VAPID keys are missing. See PUSH-SETUP.md.");
} else if (!al.rules) {
  say("LOOK", "No alert rules exist.", "Nothing to send. Set one in the app to test.");
} else if (al.lastSentAgoSec == null) {
  say("LOOK", `${al.rules} alert rules, none ever delivered.`,
    "Set one for a stop with a bus due in ~10 minutes and wait.");
} else {
  say("OK", `${al.rules} alert rules. Last notification actually delivered ${ago(al.lastSentAgoSec)}.`);
}
if (al.dueNow === false && al.rules) {
  say("OK", "No alert window is open right now.",
    "Testing alerts this minute would prove nothing — wait until one of your rules is live.");
}

/* ---- what the last real alert run did ---- */
if (why && why.lastCronWithWork && typeof why.lastCronWithWork === "object") {
  const w = why.lastCronWithWork;
  const bad = Object.entries(w.stops || {}).filter(([, v]) => /NO ANSWER|NOT REACHED|SKIPPED/.test(v));
  if (bad.length) {
    say("LOOK", `The last alert run could not read ${bad.length} stop(s).`,
      bad.map(([k, v]) => `${k}: ${v}`).join(" | "));
  } else if (w.attempts > 0) {
    say("OK", `The last alert run sent ${w.attempts} notification(s).`);
  }
  if (typeof w.via === "string" && w.via.startsWith("in-process")) {
    say("LOOK", "Alerts are running the fallback way.", w.via
      + " — fine on a healthy day; tell Claude if notifications go quiet again.");
  }
}
if (why && why.lastPush && typeof why.lastPush === "object" && why.lastPush.ok === false) {
  say("FIX", `The last notification was refused (${why.lastPush.status || why.lastPush.why}).`,
    "That is the browser's push service, not us. Tell Claude the status number.");
}

/* ---- the free plan ---- */
const fp = health.freePlanUsage || {};
if (typeof fp.kvWritesPercent === "number") {
  if (fp.kvWritesPercent < 60) say("OK", `Storage quota: ${fp.kvWritesPercent}% of today's free allowance used.`);
  else say("LOOK", `Storage quota: ${fp.kvWritesPercent}% used today.`,
    "Past 100% alerts stop being recorded. Tell Claude if this keeps climbing.");
}

/* ---- two standing savings, reported once each ---- */
if ((health.bindings || {}).selfTuneCron === false && Array.isArray(al.cronSuggestion)) {
  const now = 1152;   // the broad default in wrangler.toml
  if (al.estimatedCronRunsPerDay && al.estimatedCronRunsPerDay < now * 0.7) {
    say("LOOK", `The scheduler runs ~${now} times a day; your rules only need ~${al.estimatedCronRunsPerDay}.`,
      `Put this in wrangler.toml under [triggers] crons and redeploy:\n      `
      + JSON.stringify(al.cronSuggestion)
      + "\n      Re-check after adding an alert in a new time window.");
  }
}
const tr = health.tracking || {};
if (tr.routes > 0 && tr.eventsLast24h === 0) {
  say("LOOK", `${tr.routes} route(s) are being tracked but produced nothing in 24 hours.`,
    "This costs an OASA call every single minute for no result. Worth turning off.");
}

/* ------------------------------ output ------------------------------ */
const headline = worst === 0 ? "ALL GOOD"
  : worst === 1 ? "FINE, BUT A COUPLE OF THINGS TO LOOK AT"
  : "SOMETHING NEEDS FIXING";
console.log(`\n${headline}\n${"=".repeat(headline.length)}\n`);
for (const level of ["FIX", "LOOK", "OK"]) {
  for (const l of lines.filter(x => x.level === level)) {
    console.log(`  [${level.padEnd(4)}] ${l.what}`);
    if (l.detail) console.log(`           ${l.detail.replace(/\n/g, "\n           ")}`);
  }
}
console.log(`\n  ${HOST} · checked ${new Date().toLocaleString()}\n`);
process.exit(worst === 2 ? 1 : 0);
