/* Three things that are only visible at the edges of the app: whether the
   splash appears twice, whether the browser offers to translate it, and
   what happens on the address it used to live at.

   All three are about the frame around the app rather than the app, and
   all three are invisible in normal use — which is why they need a suite:
   the failure mode of each is something a developer will never see and a
   user will see every single time. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_FLAG } from "./_tour.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

/* A copy of public/ with MOVED_TO forced, so the real file is never edited
   and a value already set in it cannot make the "off" case pass silently. */
function withMoved(to) {
  const dir = mkdtempSync(path.join(tmpdir(), "origin-"));
  cpSync(SRC, dir, { recursive: true });
  const f = path.join(dir, "index.html");
  const src = readFileSync(f, "utf8");
  const pat = /const MOVED_TO\s*=\s*"[^"]*";/;
  if (!pat.test(src)) throw new Error("MOVED_TO declaration not found in index.html");
  writeFileSync(f, src.replace(pat, `const MOVED_TO=${JSON.stringify(to)};`));
  return dir;
}

const NOW = Math.floor(Date.now() / 1000);
const LAT = 37.976, LNG = 23.73;
const stops = [{ code: "500", name_el: "ΚΟΝΤΑ", name_en: "NEAR", lat: LAT, lng: LNG, dist: 40,
  detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
  routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
  arrivals: [{ code: "r1", veh: "V1", min: 4 }] }];

let ROOT = SRC;
let notice = null;                     // what /notice hands back, per test
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // the mode probe: is there a Worker on this origin
  if (u.pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true,"version":"test"}'); }
  if (u.pathname === "/notice") { res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(notice || {})); }
  if (u.pathname === "/nearby") { res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] })); }
  const f = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
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

/* `standalone` forges what a launcher-opened app matches. Playwright has no
   switch for display-mode, so the media query is emulated at the source. */
async function open({ standalone = false, lang = "en", host = "127.0.0.1", page: at = "/" } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 780 },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(([l, s, tf]) => {
    try { localStorage.setItem("lang", l); localStorage.setItem("tourSeen", tf); } catch (_) {}
    if (s) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /display-mode:\s*(standalone|fullscreen|minimal-ui|window-controls-overlay)/.test(q)
        ? { matches: true, media: q, addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {} } : mm(q);
    }
  }, [lang, standalone, TOUR_FLAG]);
  const p = await c.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto(`http://${host}:${PORT}${at}`, { waitUntil: "commit" });
  return { page: p, ctx: c, errs };
}
const splashUp = p => p.evaluate(() => {
  const s = document.getElementById("splash");
  if (!s) return false;
  return getComputedStyle(s).display !== "none" && !s.classList.contains("gone");
});

console.log("\n— one splash, not two —");
{
  const v = await open({ standalone: false });
  await v.page.waitForTimeout(90);
  ok("a browser tab gets the splash, because nothing else showed one",
    await splashUp(v.page));
  await v.ctx.close();
}
{
  const v = await open({ standalone: true });
  await v.page.waitForTimeout(90);
  ok("an installed launch does not, because the launcher already painted one",
    !(await splashUp(v.page)),
    "two in a row reads as the app opening twice");
  const disp = await v.page.evaluate(() =>
    getComputedStyle(document.getElementById("splash")).display);
  ok("...and it is hidden in CSS, so it never paints even for a frame",
    disp === "none", disp);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open({ standalone: true });
  await v.page.waitForTimeout(120);
  ok("...and the boot does not sit waiting for a splash that is not there",
    await v.page.evaluate(() => splashDone === true),
    "the tour waits on this flag before opening");
  await v.ctx.close();
}
{
  const html = readFileSync(path.join(SRC, "index.html"), "utf8");
  const css = (html.match(/@media \(display-mode:standalone\)[\s\S]{0,220}?\}\s*\}/) || [""])[0];
  ok("every installed display mode is covered, not just standalone",
    /fullscreen/.test(css) && /minimal-ui/.test(css) && /window-controls-overlay/.test(css),
    css.replace(/\s+/g, " ").slice(0, 90));
}

console.log("\n— the browser is told not to translate it —");
{
  for (const [name, file] of [["the app", "index.html"], ["the terms", "legal.html"]]) {
    const html = readFileSync(path.join(SRC, file), "utf8");
    ok(`${name}: the translate prompt is withdrawn`,
      /<meta name="google" content="notranslate"/.test(html),
      "otherwise Chrome offers a worse version of the language switch");
    ok(`${name}: ...and a menu-started translation is refused too`,
      /<html lang="el" translate="no">/.test(html));
  }
}
{
  const v = await open({ lang: "en" });
  await v.page.waitForTimeout(900);
  ok("the document still declares the language the app is set to",
    (await v.page.evaluate(() => document.documentElement.lang)) === "en",
    "a page that lies about its language is what invites the prompt");
  ok("...and still refuses translation",
    (await v.page.evaluate(() => document.documentElement.translate)) === false);
  await v.ctx.close();
}
{
  const v = await open({ lang: "el" });
  await v.page.waitForTimeout(900);
  ok("...in Greek too", (await v.page.evaluate(() => document.documentElement.lang)) === "el");
  await v.ctx.close();
}

console.log("\n— the address it moved away from —");
{
  ROOT = SRC;                                   // MOVED_TO empty, as shipped
  const v = await open({});
  await v.page.waitForTimeout(900);
  ok("with no new home configured, nothing is said anywhere",
    await v.page.evaluate(() => document.getElementById("moved").hidden),
    "the default must be silent, or every install shows a banner");
  await v.ctx.close();
}
{
  ROOT = withMoved("https://oasax.example");    // a different host than the server
  const v = await open({});
  await v.page.waitForTimeout(900);
  const bar = await v.page.evaluate(() => {
    const m = document.getElementById("moved");
    return { hidden: m.hidden, text: m.innerText,
             href: document.getElementById("moved-go").getAttribute("href") };
  });
  ok("the old address says where the app went", !bar.hidden, bar.text.replace(/\n/g, " "));
  ok("...naming the new host", /oasax\.example/.test(bar.text));
  ok("...warning that favourites do not travel", /do not travel/i.test(bar.text),
    "a browser keeps stored data per origin; nothing can move it");
  ok("...and linking straight there", /^https:\/\/oasax\.example\//.test(bar.href), bar.href);
}
{
  const v = await open({});
  await v.page.waitForTimeout(900);
  await v.page.click("#moved-x");
  ok("it can be dismissed", await v.page.evaluate(() => document.getElementById("moved").hidden));
  const p2 = await v.ctx.newPage();
  await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(900);
  ok("...and stays dismissed on the next open",
    await p2.evaluate(() => document.getElementById("moved").hidden),
    "a notice that will not go away is an advert");
  await v.ctx.close();
}
{
  // the same build, served from what MOVED_TO calls home
  ROOT = withMoved(`http://localhost:${PORT}`);
  const v = await open({ host: "localhost" });
  await v.page.waitForTimeout(900);
  ok("the new address does not tell people to go to itself",
    await v.page.evaluate(() => document.getElementById("moved").hidden),
    "the same build is served on both origins, so this check has to be live");
  await v.ctx.close();
}
{
  ROOT = withMoved("not a url");
  const v = await open({});
  await v.page.waitForTimeout(900);
  ok("a malformed setting is ignored rather than throwing over the boot",
    await v.page.evaluate(() => document.getElementById("moved").hidden) && v.errs.length === 0,
    v.errs.join(" | "));
  await v.ctx.close();
}
{
  const shipped = readFileSync(path.join(SRC, "index.html"), "utf8");
  ok("what ships has it switched off",
    /const MOVED_TO="";/.test(shipped),
    "turn it on only once the new domain actually serves the app");
}

console.log("\n— the app is origin-relative, so a new domain needs no edit —");
{
  const man = JSON.parse(readFileSync(path.join(SRC, "manifest.webmanifest"), "utf8"));
  ok("start_url is relative", !/^https?:/.test(man.start_url), man.start_url);
  ok("scope is relative", !/^https?:/.test(man.scope), man.scope);
  ok("the app identity is stable and origin-relative", man.id === "/", man.id);
  const html = readFileSync(path.join(SRC, "index.html"), "utf8");
  ok("the backend is same-origin, not a hardcoded host",
    /proxyBase:""/.test(html), "otherwise a new domain would talk to the old one");
  const abs = (html.match(/href="https?:\/\/[^"]+"/g) || [])
    .filter(h => !/gnu\.org|openstreetmap|carto/i.test(h));
  ok("no page link points at a fixed host", abs.length === 0, abs.join(" "));
  /* The share card is the exception, and it has to be: a social crawler
     resolves og:image against nothing, so a relative one is a coin toss.
     It is metadata about where the app lives, not something the app
     fetches — which is why the rule above still holds for everything the
     running page actually touches. */
  const meta = html.match(/content="https?:\/\/[^"]+"/g) || [];
  ok("the only fixed host in the page is the canonical one",
    meta.length > 0 && meta.every(m => /oasax\.com/.test(m)), meta.join(" "));
  ok("...and nothing the page loads or links to names it",
    !/href="https?:\/\/oasax\.com/.test(html) && !/src="https?:\/\/oasax\.com/.test(html)
    && !/fetch\(\s*["`]https?:\/\/oasax\.com/.test(html),
    "a fixed host in a fetch is how a new domain ends up talking to the old one");
  const sw = readFileSync(path.join(SRC, "sw.js"), "utf8");
  ok("the service worker caches relative paths", !/https?:\/\/[a-z0-9.-]*workers\.dev/i.test(sw));
}

/* Saying "we are doing maintenance" should not need a deploy, a cache
   purge and a wait, at exactly the moment when deploying is least
   appealing. The Worker holds the text; the app asks for it. */
console.log("\n— a notice the operator can set without shipping —");
{
  notice = null;
  const v = await open({});
  await v.page.waitForTimeout(900);
  ok("nothing renders when none is set",
    await v.page.evaluate(() => document.getElementById("noticebg").hidden),
    "an unset notice must cost nothing and say nothing");
  await v.ctx.close();
}
{
  notice = { id: "m1", el: "Κάνουμε εργασίες.", en: "We're doing some work." };
  const v = await open({ lang: "en" });
  await v.page.waitForTimeout(1200);
  const card = await v.page.evaluate(() => {
    const b = document.getElementById("noticebg");
    const r = document.querySelector(".noticecard").getBoundingClientRect();
    return { hidden: b.hidden, txt: b.innerText.replace(/\s+/g, " ").trim(),
      // centred, not a line hugging the top edge
      middle: Math.abs((r.top + r.height / 2) - innerHeight / 2) < 60 };
  });
  ok("...and a card appears in the middle of the screen once one is",
    !card.hidden && card.middle, `${card.middle ? "centred" : "not centred"}`);
  ok("...carrying the operator's words", /doing some work/i.test(card.txt), card.txt);
  ok("...under a heading about maintenance, and nothing else",
    /MAINTENANCE/i.test(card.txt) && !/OASA is|blocked/i.test(card.txt),
    "the heading is the app's, so the tone cannot drift with the message");
  const gone = await v.page.evaluate(() => {
    document.getElementById("notice-ok").click();
    return document.getElementById("noticebg").hidden
      && localStorage.getItem("noticeSeen") === "m1";
  });
  ok("...dismissed once, and remembered", gone);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  notice = { id: "m1", el: "Κάνουμε εργασίες.", en: "" };
  const v = await open({ lang: "en" });
  await v.page.waitForTimeout(1200);
  ok("a notice written in only one language still reaches the other reader",
    await v.page.evaluate(() =>
      !document.getElementById("noticebg").hidden
      && /εργασίες/i.test(document.getElementById("notice-p").textContent)),
    "showing an English reader nothing would be worse than showing them Greek");
  await v.ctx.close();
  notice = null;
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
