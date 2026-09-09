/* Community flags: what may be reported, how long it lives, and the fact
   that there is exactly one colour on the screen.

   v44 removed the issue/ops split. That change touches the Worker's
   validation, the app's chip list, eleven CSS rules and both translations,
   and the failure mode if any one of them is missed is silent — a type the
   server rejects still renders a chip, a label that is missing renders as
   its own key. So most of this file is about the two lists agreeing and
   every type having a word in both languages. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };
const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));

const worker = readFileSync(path.join(REPO, "worker.js"), "utf8");
const html = readFileSync(path.join(REPO, "public", "index.html"), "utf8");

/* The Worker's own tables, read out of a vm rather than re-parsed with a
   regex, so this checks what the code will actually enforce. */
const ctx = {
  console, Date, Math, JSON, Map, Set, Intl, Promise, Array, Object, String, Number,
  isFinite, parseInt, parseFloat, setTimeout, clearTimeout, URL, Request, Response, Headers,
  TextEncoder, TextDecoder, btoa, atob, WeakMap, Symbol, Error, TypeError, RegExp,
  Uint8Array, ArrayBuffer, DataView, encodeURIComponent, decodeURIComponent,
  AbortController: class { constructor() { this.signal = null; } abort() {} },
  crypto: { randomUUID: () => "x", subtle: {} },
  caches: { default: { async match() {}, async put() {} } },
  fetch: async () => { throw new Error("no network in the harness"); },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(worker.replace(/^export default/m, "const __handler ="), ctx);

const BUS = vm.runInContext("[...REPORT_TYPES.bus]", ctx);
const METRO = vm.runInContext("[...REPORT_TYPES.metro]", ctx);
const TTL = vm.runInContext("JSON.parse(JSON.stringify(TTL))", ctx);
const DEFAULT_TTL = vm.runInContext("DEFAULT_TTL", ctx);
const ttlOf = (kind, type) => vm.runInContext(`reportTtl(${JSON.stringify({ kind, type })})`, ctx);

console.log("\n— what may be flagged —");
{
  ok("a surface vehicle carries the vehicle faults and who is aboard",
    same(BUS, ["breakdown", "crowded", "noac", "security", "staff"]), BUS.join(", "));
  ok("a station carries the station's own faults",
    same(METRO, ["lift", "escalator", "nowheel", "crowded", "security", "staff"]),
    METRO.join(", "));
  ok("an escalator can be reported out of order", METRO.includes("escalator"));
  ok("a station with no step-free route can be flagged", METRO.includes("nowheel"));
  ok("crowding is reportable on a vehicle AND at a station",
    BUS.includes("crowded") && METRO.includes("crowded"),
    "trolleys are the 'bus' kind, so they are covered by the same entry");
  ok("OASA staff is one entry, on both", BUS.includes("staff") && METRO.includes("staff"));
  ok("fare inspection is gone from the vehicle list", !BUS.includes("fare"));
  ok("...and from the station list", !METRO.includes("fare"));
  ok("nothing is left that mentions inspection at all",
    !BUS.concat(METRO).some(x => /fare|inspect/i.test(x)));
}

console.log("\n— how long a flag lives —");
{
  const missing = [];
  for (const t of BUS) if (TTL.bus[t] == null) missing.push("bus/" + t);
  for (const t of METRO) if (TTL.metro[t] == null) missing.push("metro/" + t);
  ok("every reportable type has an explicit lifetime", missing.length === 0, missing.join(", "));
  ok("a retired type falls through to the default rather than living forever",
    ttlOf("bus", "fare") === DEFAULT_TTL && ttlOf("metro", "inspector") === DEFAULT_TTL,
    `${DEFAULT_TTL}s — rows already in KV age out within the hour`);
  ok("a crowded platform clears faster than a crowded bus",
    TTL.metro.crowded < TTL.bus.crowded,
    `${TTL.metro.crowded}s vs ${TTL.bus.crowded}s`);
  ok("a broken escalator lasts as long as a broken lift",
    TTL.metro.escalator === TTL.metro.lift);
  ok("no step-free access outlives everything else, being a fact about the building",
    TTL.metro.nowheel === Math.max(...Object.values(TTL.metro)),
    `${TTL.metro.nowheel}s`);
  ok("staff on a bus expire faster than staff at a station",
    TTL.bus.staff < TTL.metro.staff, "they ride a few stops; a station is a shift");
  const all = [...Object.values(TTL.bus), ...Object.values(TTL.metro)];
  ok("nothing lives longer than the app claims in About",
    Math.max(...all) <= 3 * 3600 && Math.min(...all) >= 30 * 60,
    `${Math.min(...all) / 60}–${Math.max(...all) / 3600}h`);
}

console.log("\n— the app agrees with the server —");
const clientTypes = (() => {
  const m = html.match(/const TYPES_BY_KIND=\{([\s\S]*?)\};/);
  if (!m) return null;
  const grab = k => {
    const g = m[1].match(new RegExp(k + ":\\[([^\\]]*)\\]"));
    return g ? g[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  };
  return { bus: grab("bus"), metro: grab("metro") };
})();
{
  ok("the app's chip list was found at all", !!clientTypes);
  ok("the vehicle chips are exactly what the server accepts",
    same(clientTypes.bus, BUS), clientTypes.bus.join(", "));
  ok("the station chips are exactly what the server accepts",
    same(clientTypes.metro, METRO), clientTypes.metro.join(", "));
}

console.log("\n— every type has a word, in both languages —");
{
  /* T={ el:{…}, en:{…} } — split on the second block's opening so each
     language is read from its own half and a key missing from only one
     of them is still caught. */
  const cut = html.indexOf(" en:{");
  ok("both translation blocks were located", cut > html.indexOf("const T={"));
  const strings = lang => {
    const src = lang === "el" ? html.slice(0, cut) : html.slice(cut);
    const out = {};
    const re = /\bti_([a-z]+):"([^"]*)"/g;
    let m; while ((m = re.exec(src)) !== null) if (out[m[1]] == null) out[m[1]] = m[2];
    return out;
  };
  const all = [...new Set([...BUS, ...METRO])];
  for (const lang of ["el", "en"]) {
    const s = strings(lang);
    const gaps = all.filter(t => !s[t]);
    ok(`${lang}: every reportable type is translated`, gaps.length === 0,
      gaps.length ? "missing " + gaps.join(", ") : all.length + " types");
  }
  const en = strings("en");
  ok("en: staff reads as OASA staff", en.staff === "OASA staff", en.staff);
  ok("en: customer service staff is gone", !/Customer service/i.test(html));
  ok("en: the escalator label says out of order",
    /out of order/i.test(en.escalator || ""), en.escalator);
  ok("en: wheelchair access is named plainly",
    /wheelchair/i.test(en.nowheel || ""), en.nowheel);
  ok("retired types still read sensibly while their rows age out",
    en.fare === "OASA staff" && en.inspector === "OASA staff",
    "a flag filed before the deploy must not render as its own key");
}

console.log("\n— one colour —");
{
  ok("a flag colour is defined once, as a token", /--flag:#[0-9A-Fa-f]{6}/.test(html));
  const hex = (html.match(/--flag:#([0-9A-Fa-f]{6})/) || [])[1];
  const lum = h => {
    const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (1.05) / (lum(hex) + 0.05);
  ok("...dark enough for white text to sit on it", ratio >= 4.5, `${ratio.toFixed(2)}:1 on #${hex}`);

  for (const dead of [".flag.issue", ".flag.ops", ".flagline.issue", ".flagline.ops",
                      ".repitem .rb.issue", ".repitem .rn.ops", ".chip.issue.on",
                      ".rep-legend", "flaglabel.ops"]) {
    ok(`the two-colour rule ${dead} is gone`, !html.includes(dead));
  }
  ok("the pin, the map label, the list bar and the count all use the one token",
    (html.match(/var\(--flag\)/g) || []).length >= 7,
    (html.match(/var\(--flag\)/g) || []).length + " uses");
  ok("no flag surface still reaches for the old red",
    !/\.flag[^{]*\{[^}]*var\(--red\)/.test(html) &&
    !/flaglabel\{[^}]*var\(--red\)/.test(html));
  ok("the report button matches the flags it opens",
    /\.livedot\{[^}]*var\(--flag\)/.test(html));
}

console.log("\n— nothing left of the split —");
{
  for (const gone of ["catOf(", "CAT_ORDER", "const CATEGORY", "catIssue", "catOps",
                      "legIssue", "legOps"]) {
    ok(`the app no longer carries ${gone}`, !html.includes(gone));
  }
  ok("...nor does the Worker", !worker.includes("const CATEGORY"));
  ok("the form asks one question instead of grouping under two",
    /catWhat:/.test(html) && /id="rf-type"><div class="field">/.test(html));
  ok("the admin status counts by type rather than by a colour",
    /byType/.test(worker) && !/red: active\.filter/.test(worker));
}

console.log("\n— what the user is told —");
{
  ok("en: About lists the station types",
    /escalator out of order/i.test(html) && /no wheelchair access/i.test(html));
  ok("el: About lists them too",
    /κυλιόμενη εκτός λειτουργίας/i.test(html) && /χωρίς πρόσβαση ΑμεΑ/i.test(html));
  ok("en: About has no category language left",
    !/Two categories/.test(html) && !/Operational<\/b>/.test(html));
  ok("el: same", !/Δύο κατηγορίες/.test(html) && !/Λειτουργικά<\/b>/.test(html));
  ok("en: About names the reports as unverified",
    /Reports are <b>unverified<\/b>/.test(html));
  ok("el: same", /Οι αναφορές είναι <b>ανεπιβεβαίωτες<\/b>/.test(html));
  ok("the tour no longer promises a red button",
    !/red button/i.test(html) && !/κόκκινο κουμπί/i.test(html));
  ok("...and names the colour it now is",
    /orange button/i.test(html) && /πορτοκαλί κουμπί/i.test(html));
  ok("About's stated expiry window matches the TTL table",
    /30 minutes to\s+3 hours/.test(html) && /30 λεπτά έως\s+3 ώρες/.test(html),
    `TTL runs ${Math.min(...[...Object.values(TTL.bus), ...Object.values(TTL.metro)]) / 60}–` +
    `${Math.max(...[...Object.values(TTL.bus), ...Object.values(TTL.metro)]) / 3600}h`);
  /* "Always carry a valid ticket" is a term of use, not advice the app
     hands out beside a live report — the distinction is the whole reason
     this assertion exists. Since v50 the terms live inside the app's FAQ,
     so the line has one legitimate home; anywhere else is still wrong. */
  // for each mention, which translation key is it sitting under?
  const owner = at => {
    const keys = [...html.slice(0, at).matchAll(/\b(faq[A-Za-z]+|tour\d[hp]|aboutBody|jp[A-Za-z]+):/g)];
    return keys.length ? keys[keys.length - 1][1] : "(none)";
  };
  const hits = [...html.matchAll(/valid ticket|έγκυρο εισιτήριο/gi)];
  const owners = hits.map(m => owner(m.index));
  ok("the fare line appears only in the terms answer",
    owners.every(o => o === "faqTermsA"), owners.join(", ") || "(no mentions)");
  ok("...and it is there, in both languages", owners.length === 2,
    `${owners.length} — one per language`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
