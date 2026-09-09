/* Terms & privacy, and the About sheet behind the menu.

   Two things are being defended. First, that both documents follow the
   app's language setting — someone who set the app to Greek must not land
   on an English wall of terms, which is what happened before v45. Second,
   that the pair stay honest with each other and with the code: the same
   expiry window, the same processors, the same accessibility warning.

   The page is driven in a real browser, because "which language does it
   show" is a question about CSS and a script, not about the source. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const html = readFileSync(path.join(PUB, "legal.html"), "utf8");
const app = readFileSync(path.join(PUB, "index.html"), "utf8");
/* The version printed in About is the one thing on that sheet a reader
   might quote back in a bug report, so it has to be the Worker's. */
const VERSION = (readFileSync(path.join(REPO, "worker.js"), "utf8")
  .match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    res.writeHead(200, { "Content-Type": e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]");
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

/* Open legal.html with `lang` already in localStorage, exactly as the app
   would have left it, and read back what is actually visible. */
async function view({ setting, query } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  if (setting) {
    await ctx.addInitScript(l => { try { localStorage.setItem("lang", l); } catch (_) {} }, setting);
  }
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/legal.html${query || ""}`, { waitUntil: "load" });
  const out = {
    text: await page.evaluate(() => document.body.innerText),
    lang: await page.evaluate(() => document.documentElement.lang),
    title: await page.title(),
    button: await page.evaluate(() => document.getElementById("lang").textContent.trim()),
    errs,
    page, ctx,
  };
  return out;
}

console.log("\n— the page follows the app's language —");
{
  const v = await view({ setting: "el" });
  ok("app set to Greek gives a Greek page", /Όροι χρήσης/.test(v.text), v.lang);
  ok("...and none of the English text is visible", !/Terms of use/.test(v.text));
  ok("...with the document language marked for a screen reader", v.lang === "el");
  ok("...and a Greek title", /Όροι/.test(v.title), v.title);
  ok("...offering the other language on the button", v.button === "English", v.button);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await view({ setting: "en" });
  ok("app set to English gives an English page", /Terms of use/.test(v.text), v.lang);
  ok("...and none of the Greek text is visible", !/Όροι χρήσης/.test(v.text));
  ok("...with lang=en", v.lang === "en");
  ok("...and the button offers Greek", v.button === "Ελληνικά", v.button);
  await v.ctx.close();
}
{
  const v = await view({});
  ok("with no setting at all it falls back to the app's default, Greek",
    /Όροι χρήσης/.test(v.text) && v.lang === "el");
  await v.ctx.close();
}
{
  const v = await view({ setting: "el", query: "?lang=en" });
  ok("a shared ?lang= link overrides the local setting",
    /Terms of use/.test(v.text), "so a link can be sent to someone set the other way");
  await v.ctx.close();
}
{
  const v = await view({ setting: "el", query: "?lang=fr" });
  ok("an unknown ?lang= is ignored rather than blanking the page",
    /Όροι χρήσης/.test(v.text));
  await v.ctx.close();
}

console.log("\n— the button switches the page, not the app —");
{
  const v = await view({ setting: "el" });
  await v.page.click("#lang");
  const after = await v.page.evaluate(() => document.body.innerText);
  const setting = await v.page.evaluate(() => localStorage.getItem("lang"));
  ok("clicking it shows the other language", /Terms of use/.test(after));
  ok("...and does NOT rewrite the app's language setting", setting === "el",
    "reading the terms in English is not a request to switch the whole app");
  await v.page.click("#lang");
  ok("...and it switches back", /Όροι χρήσης/.test(await v.page.evaluate(() => document.body.innerText)));
  await v.ctx.close();
}

console.log("\n— both languages say the same things —");
{
  const el = await view({ setting: "el" }), en = await view({ setting: "en" });
  const both = (name, reEl, reEn) => {
    ok(`el: ${name}`, reEl.test(el.text), "");
    ok(`en: ${name}`, reEn.test(en.text), "");
  };
  both("the app is declared unofficial", /ανεπίσημ/i, /unofficial/i);
  both("the data is declared unreliable", /30–60 δευτερόλεπτα/, /30–60 seconds/);
  // matched on the prose, not the headings: those are CSS-uppercased, and
  // uppercasing Greek strips the accents the regex would be looking for
  both("reports are declared unverified",
    /Δεν ελέγχουμε αν είναι αληθείς/, /We don't check whether they are true/);
  both("the accessibility warning is present", /χωρίς σκαλιά/i, /step-free/i);
  both("the IP window is stated", /60 δευτερόλεπτα/, /60 seconds/);
  both("the report retention window is stated", /30 λεπτά έως 3 ώρες/, /30 minutes to 3 hours/);
  both("the history window is stated", /90 ημέρες/, /90 days/);
  both("the geocoder is disclosed as a processor", /OpenRouteService/, /OpenRouteService/);
  /* Added in v53 and disclosed late: a street name and its position leave
     the Worker for a service nobody had been told about. Anything the app
     talks to on the rider's behalf belongs on this list the day it ships. */
  both("...and so is the service that estimates house numbers", /Overpass/, /Overpass/);
  both("...along with the rounding it receives", /ένα χιλιόμετρο/, /one kilometre/);
  both("...and that it does not get your IP", /δεν λαμβάνει τη διεύθυνση IP/, /not receive your IP/);
  both("the contact address is given", /oasax@proton\.me/, /oasax@proton\.me/);
  both("Greek law and Athens jurisdiction", /δικαστήρια της Αθήνας/, /courts of Athens/);
  ok("neither language leaks the other's headings into the visible text",
    !/Privacy\b/.test(el.text) && !/Απόρρητο/.test(en.text),
    "both blocks are in the DOM; only one may be shown");
  await el.ctx.close(); await en.ctx.close();
}

console.log("\n— the anchors About links to actually exist —");
{
  const v = await view({ setting: "el" });
  ok("#terms is a real target", await v.page.evaluate(() => !!document.getElementById("terms")));
  ok("#privacy is a real target", await v.page.evaluate(() => !!document.getElementById("privacy")));
  ok("...and About links to both",
    /legal\.html#terms/.test(app) && /legal\.html#privacy/.test(app));
  await v.ctx.close();
}

console.log("\n— About, in the app —");
{
  /* About and Terms are one collapsible FAQ since v50, so the checks are
     on the questions rather than on prose headings. */
  for (const [lang, want] of [["el", /ζωντανές αναφορές/i], ["en", /live reports/i]]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 },
      permissions: [], });
    await ctx.addInitScript(l => { try { localStorage.setItem("lang", l); } catch (_) {} }, lang);
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", e => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { try { openAbout(); } catch (e) {} });
    // textContent, not innerText: the section labels are CSS-uppercased
    const txt = await page.evaluate(() => document.getElementById("ab-body").textContent);
    ok(`${lang}: the FAQ renders in the language the app is set to`, want.test(txt),
      txt.slice(0, 60).replace(/\n/g, " "));
    ok(`${lang}: ...and carries the accessibility warning`,
      /(step-free|χωρίς σκαλιά)/i.test(txt));
    ok(`${lang}: ...and says the reports are unverified`,
      /(unverified|ανεπιβεβαίωτ)/i.test(txt));
    ok(`${lang}: ...and the terms are in there too, not on a separate screen`,
      /(as is|ως έχει)/i.test(txt));
    ok(`${lang}: ...as are the privacy answers`,
      /(no tracking|χωρίς παρακολούθηση|no cookies|cookies)/i.test(txt));
    ok(`${lang}: ...and the map attribution`, /OpenStreetMap/.test(txt));
    ok(`${lang}: ...and the version the Worker will report`, txt.includes(VERSION),
      `About says ${(txt.match(/v\d+/) || [])[0]}, worker.js says ${VERSION}`);
    ok(`${lang}: no page errors`, errs.length === 0, errs.join(" | "));
    await ctx.close();
  }
}

console.log("\n— the documents agree with the repo —");
{
  // markdown wraps lines and carries emphasis markers; neither is content
  const flat = f => readFileSync(path.join(REPO, f), "utf8").replace(/[*_`]/g, "").replace(/\s+/g, " ");
  const terms = flat("TERMS.md"), privacy = flat("PRIVACY.md");
  ok("TERMS.md carries the accessibility warning too", /step-free/i.test(terms));
  ok("PRIVACY.md names the geocoder as a processor", /OpenRouteService/.test(privacy));
  ok("...and the house-number estimator", /Overpass/.test(privacy));
  ok("PRIVACY.md states the same retention window as the page",
    /30 minutes to 3 hours/.test(privacy),
    "the markdown mirrors legal.html; change them together");
  ok("...and the same IP window", /60 seconds/.test(privacy));
  ok("...and the same geocoder rounding", /one kilometre/.test(privacy));
  ok("TERMS.md states the same staleness figure", /30–60 seconds/.test(terms));
  for (const [name, f] of [["legal.html", html], ["TERMS.md", terms], ["PRIVACY.md", privacy]]) {
    ok(`${name} ships no repository URL or owner name`,
      !/github\.com/i.test(f) && !new RegExp(["oas", "ucks"].join(""), "i").test(f));
  }
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
