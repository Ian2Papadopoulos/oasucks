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

/* ---- is it alive, and is it the version you think ---- *
   "Why does it still say v82" is a question with one answer and it is
   always the same one: the code was pulled but not deployed. The tool can
   see both sides, so it should say so rather than let you wonder. */
let localVersion = null;
try {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const m = readFileSync(here + "../worker.js", "utf8").match(/APP_VERSION = "([^"]+)"/);
  if (m) localVersion = m[1];
} catch (_) { }
if (localVersion && localVersion !== health.version) {
  say("LOOK", `Running ${health.version}, but this folder has ${localVersion}.`,
    "You pulled the code but have not deployed it. Run:  npx wrangler deploy");
} else {
  say("OK", `The app is up, running ${health.version}.`);
}

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
/* The narrowing is a real saving and a real trap, and the trap is quiet.
   The suggestion covers the rules that exist AT THIS MOMENT. Narrow it by
   hand, then set an alert in an hour the schedule no longer covers, and
   that alert can never fire — with nothing on screen to say why, because
   every other check still passes. Only offer it when there are rules to
   size it against, and never without the warning. */
const selfTunes = (health.bindings || {}).selfTuneCron === true;
if (!selfTunes && al.rules > 0 && Array.isArray(al.cronSuggestion)
    && al.estimatedCronRunsPerDay && al.estimatedCronRunsPerDay < 800) {
  say("LOOK", `The scheduler runs ~1152 times a day; your ${al.rules} rules only need ~${al.estimatedCronRunsPerDay}.`,
    `Optional saving. In wrangler.toml under [triggers] crons, then redeploy:\n      `
    + JSON.stringify(al.cronSuggestion)
    + "\n      WARNING: this fits the rules you have RIGHT NOW. Nothing widens it back"
    + "\n      automatically, so an alert set later in an hour it does not cover will"
    + "\n      never fire, silently. Re-run this after every new alert, or leave the"
    + "\n      broad default alone — it costs nothing you are short of.");
} else if (!selfTunes && al.rules === 0) {
  say("OK", "The scheduler is on the broad default, which is the safe setting.",
    "With no rules there is nothing to narrow it to, and narrowing it now would "
    + "stop the first alert you set from ever firing.");
}
/* The symptom: a notification arrives the moment the app is opened,
   saying the bus is a minute away. That is not a delayed push — it is a
   lead that came due while nothing was running the sweep, delivered by the
   first thing that did. */
if (al.dueNow === true && typeof al.lastSweepAgoSec === "number") {
  if (al.lastSweepAgoSec <= 150) {
    say("OK", `A window is open and the check ran ${ago(al.lastSweepAgoSec)}.`,
      "That is the cadence alerts need — roughly once a minute.");
  } else {
    say("FIX", `A window is open but the check last ran ${ago(al.lastSweepAgoSec)}.`,
      "Alerts will arrive late, or all at once when someone next opens the app. "
      + "The pinger is not calling /alerts/run — check it is enabled and not timing out.");
  }
}
if (why && why.lastCronWithWork && Array.isArray(why.lastCronWithWork.late)
    && why.lastCronWithWork.late.length) {
  say("LOOK", "The last alerts went out later than they were asked for.",
    why.lastCronWithWork.late.join(" | ")
    + "\n      A 10-minute warning sent at 1 minute is an announcement, not a warning. "
    + "It means the sweep is not running often enough.");
}

/* The gap that stops alerts being set-and-forget: the cron cannot reach
   OASA on this Worker, a rider's own request can, and an alert at 06:40
   with nobody awake has neither. */
if ((health.bindings || {}).push && al.rules > 0 && !(health.bindings || {}).runToken) {
  say("LOOK", "Alerts depend on someone using the app at the time they are due.",
    "A rider's phone does NOT need to be open to RECEIVE one — but something has to run "
    + "the check, and the built-in scheduler cannot reach OASA on this setup.\n      "
    + "For alerts that fire with nobody around, set RUN_TOKEN and point a free cron "
    + "service at /alerts/run once a minute. See DEPLOY.md, 'Making alerts fire with "
    + "nobody using the app'.");
} else if ((health.bindings || {}).runToken) {
  say("OK", "An outside pinger can trigger alerts, so they do not need a rider awake.",
    "Check it is actually calling: `via` should say 'request' in the last alert run.");
}

const tr = health.tracking || {};
if (tr.routes > 0 && tr.eventsLast24h === 0) {
  /* Worked-then-stopped and never-worked look identical in a 24-hour
     window and need opposite responses: one is a route OASA has retired
     under you, the other is a setup that never took. */
  if (tr.lastEventAgoSec == null) {
    say("LOOK", `${tr.routes} tracked route(s) have never recorded anything.`,
      "Costs an OASA call a minute for nothing. Turn it off, or check the route code.");
  } else {
    say("LOOK", `Tracking stopped ${ago(tr.lastEventAgoSec)} after working normally.`,
      "It still costs an OASA call every minute. Usually the route code was retired "
      + "upstream. Test it with:  curl.exe -X POST -H \"X-Admin-Token: TOKEN\" "
      + `${HOST}/track/sample`
      + "\n      events:0 means OASA no longer serves that route — remove it. "
      + "Removing keeps the history already collected.");
  }
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
