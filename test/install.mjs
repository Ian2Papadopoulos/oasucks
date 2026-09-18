/* The install card, last in the first-run carousel.

   Installing a PWA is a browser-menu operation with a different name and
   a different menu on every platform, which is exactly the kind of thing
   an app has to spell out or nobody does it. The card names the steps for
   the device in your hand — showing all four platforms at once is the
   failure mode this file exists to prevent — and where Chrome hands us
   the prompt API, it offers a real button instead.

   Driven in a real browser under spoofed user agents, because platform
   detection is the whole feature. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_FLAG } from "./_tour.mjs";
import { mustFindBrowser } from "../tools/browser.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

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
const browser = await chromium.launch({ executablePath: mustFindBrowser() });

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
};

/* Open the app, jump to the last card, and read it back. `touch` forges
   the pointer count iPadOS uses to disguise itself as a desktop Mac. */
async function card({ ua, lang = "en", touch = 0, prompt = false, standalone = false }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, userAgent: ua });
  await ctx.addInitScript(([l, t, s]) => {
    try { localStorage.setItem("lang", l); } catch (_) {}
    if (t) Object.defineProperty(navigator, "maxTouchPoints", { get: () => t });
    if (s) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /display-mode: standalone/.test(q)
        ? { matches: true, media: q, addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {} }
        : mm(q);
    }
  }, [lang, touch, standalone]);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (prompt) {
    // stand in for the event Chrome fires; the app stores it and swaps
    // the instructions for a button
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt");
      e.prompt = () => { window.__prompted = true; };
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      dispatchEvent(e);
    });
  }
  await page.evaluate(() => { tourAt = TOUR.length - 1; $("#tour").hidden = false; paintTour(); });
  await page.waitForTimeout(120);
  const out = {
    text: await page.evaluate(() => $("#tour-p").innerText),
    head: await page.evaluate(() => $("#tour-h").textContent),
    hasBtn: await page.evaluate(() => !!document.getElementById("tour-install")),
    dots: await page.evaluate(() => $("#tour-dots").children.length),
    last: await page.evaluate(() => $("#tour-next").textContent),
    errs, page, ctx,
  };
  return out;
}

console.log("\n— the card is part of the carousel —");
{
  const v = await card({ ua: UA.android });
  ok("the carousel has six cards now", v.dots === 6, `${v.dots} dots`);
  ok("...and installing is the last one", /Put it on your home screen/.test(v.head), v.head);
  ok("...so its button starts the app rather than saying Next",
    !/next/i.test(v.last), v.last);
  ok("it says what installing gets you", /full-screen/.test(v.text), v.text.slice(0, 50));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

console.log("\n— it names the steps for the device in your hand —");
{
  const want = [
    ["android", UA.android, 0, /Add to Home screen/, /Share|Add to Dock|address bar/],
    ["iphone", UA.iphone, 5, /Add to Home Screen/, /menu ⋮|address bar/],
    ["ipad pretending to be a Mac", UA.ipad, 5, /Add to Home Screen/, /menu ⋮/],
    ["windows", UA.win, 0, /install icon/, /Add to Home/],
    ["mac safari", UA.mac, 0, /Add to Dock/, /Add to Home/],
    ["firefox", UA.firefox, 0, /doesn't install websites/, /Add to Home/],
  ];
  for (const [name, ua, touch, yes, no] of want) {
    const v = await card({ ua, touch });
    const steps = await v.page.evaluate(() => {
      const e = document.querySelector(".inst-steps"); return e ? e.innerText : "";
    });
    ok(`${name}: the right steps`, yes.test(steps), steps.replace(/\n/g, " ").slice(0, 70));
    ok(`${name}: ...and not another platform's`, !no.test(steps),
      "showing all four at once is the thing this replaces");
    await v.ctx.close();
  }
}
{
  const v = await card({ ua: UA.iphone, touch: 5 });
  ok("every device still gets the one-line note about the others",
    /Elsewhere/.test(v.text), "the safety net when the sniffing guesses wrong");
  await v.ctx.close();
}

console.log("\n— where the browser offers a real prompt, use it —");
{
  const v = await card({ ua: UA.android, prompt: true });
  ok("the instructions give way to an install button", v.hasBtn);
  ok("...and the steps are not also shown, which would be two answers",
    !/Add to Home screen/.test(v.text), v.text.replace(/\n/g, " ").slice(0, 70));
  await v.page.click("#tour-install");
  await v.page.waitForTimeout(150);
  ok("clicking it actually calls the browser's prompt",
    await v.page.evaluate(() => window.__prompted === true));
  ok("...and afterwards the card no longer offers it twice",
    !(await v.page.evaluate(() => !!document.getElementById("tour-install"))));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await card({ ua: UA.android, prompt: false });
  ok("with no prompt on offer, the steps are shown instead", !v.hasBtn &&
    /Add to Home screen/.test(v.text));
  await v.ctx.close();
}

console.log("\n— already installed —");
{
  const v = await card({ ua: UA.android, standalone: true });
  ok("an installed app is not told how to install itself",
    !/Add to Home screen/.test(v.text) && !v.hasBtn, v.text.replace(/\n/g, " "));
  ok("...it just says so", /Already running/.test(v.text), v.text);
  await v.ctx.close();
}

console.log("\n— both languages —");
{
  const el = await card({ ua: UA.android, lang: "el" });
  ok("el: the card is translated", /αρχική οθόνη/.test(el.head), el.head);
  ok("el: ...including the steps", /Προσθήκη στην αρχική οθόνη/.test(el.text));
  ok("el: ...and the note about other devices", /Αλλού/.test(el.text));
  await el.ctx.close();
  const en = await card({ ua: UA.iphone, touch: 5, lang: "en", standalone: true });
  ok("en: the installed message is translated too", /Already running/.test(en.text));
  await en.ctx.close();
}

/* The carousel is the only thing in the app that interrupts you, so it
   gets exactly one chance: first run, then never again on its own. The
   flag carries the tour's version rather than a bare "1", which is what
   lets a materially different set of cards be shown once more to someone
   who saw the old one. */
console.log("\n— shown once, on the first run —");
async function boot(flag) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, userAgent: UA.android });
  await ctx.addInitScript(fl => {
    try {
      localStorage.setItem("lang", "en");
      // clear it on the first load only — this runs again on reload, and
      // wiping the flag there would defeat the point of the reload
      if (fl === null) {
        if (!sessionStorage.getItem("cleared")) {
          localStorage.removeItem("tourSeen"); sessionStorage.setItem("cleared", "1");
        }
      } else localStorage.setItem("tourSeen", fl);
    } catch (_) {}
  }, flag);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2400);
  const open = await page.evaluate(() => !document.getElementById("tour").hidden);
  return { page, ctx, open };
}
{
  const fresh = await boot(null);
  ok("a first-time visitor gets the carousel", fresh.open);
  ok("...starting at the first card",
    await fresh.page.evaluate(() => $("#tour-h").textContent === t("tour1h")),
    await fresh.page.evaluate(() => $("#tour-h").textContent));
  await fresh.page.click("#tour-skip");
  await fresh.page.waitForTimeout(120);
  ok("...and skipping records the tour's version, not a bare flag",
    await fresh.page.evaluate(() => localStorage.getItem("tourSeen")) === TOUR_FLAG,
    await fresh.page.evaluate(() => localStorage.getItem("tourSeen")));
  await fresh.page.reload({ waitUntil: "domcontentloaded" });
  await fresh.page.waitForTimeout(2400);
  ok("...so the next visit is not interrupted",
    await fresh.page.evaluate(() => document.getElementById("tour").hidden));
  await fresh.ctx.close();

  const seen = await boot(TOUR_FLAG);
  ok("someone who has seen this set is left alone", !seen.open);
  ok("...and nothing in the FAQ offers to replay it",
    await seen.page.evaluate(() => { openAbout(); return !document.getElementById("faq-tour"); }),
    "a tour you can summon is a tour nobody summons");
  await seen.ctx.close();

  const stale = await boot("1");
  ok("a flag left by an older carousel does not hide this one", stale.open);
  await stale.ctx.close();
}

console.log("\n— the manifest actually supports installing —");
{
  const man = JSON.parse(readFileSync(path.join(PUB, "manifest.webmanifest"), "utf8"));
  ok("it asks for a standalone window", man.display === "standalone", man.display);
  ok("it has a start_url", !!man.start_url, man.start_url);
  ok("it names itself", !!man.name && !!man.short_name);
  const sizes = (man.icons || []).map(i => i.sizes);
  ok("...and ships the icon sizes a launcher wants",
    sizes.includes("192x192") && sizes.includes("512x512"), sizes.join(" "));
  ok("...one of them maskable, or Android crops the logo badly",
    (man.icons || []).some(i => /maskable/.test(i.purpose || "")),
    (man.icons || []).map(i => i.purpose).join(","));
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
