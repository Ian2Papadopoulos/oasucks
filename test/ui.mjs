/* The v50 interface changes: one FAQ instead of two documents, one row
   per place in the picker, Home and Work, and gestures that do one thing
   each.

   These are all "does the app behave the way it says it does" rather than
   "does it throw", which is why they are driven rather than grepped. The
   gesture pair especially: a toggle bound to a double-tap and a separate
   long-press to remove look identical in source and behave nothing alike. */
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_FLAG } from "./_tour.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };

const NOW = Math.floor(Date.now() / 1000);
const LAT = 37.976, LNG = 23.73;
const stops = [
  { code: "500", name_el: "ΣΥΝΤΑΓΜΑ", name_en: "SYNTAGMA", lat: LAT, lng: LNG, dist: 40,
    detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
    routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
    arrivals: [{ code: "r1", veh: "V1", min: 4 }] },
  { code: "501", name_el: "ΑΜΠΕΛΟΚΗΠΟΙ", name_en: "AMPELOKIPI", lat: LAT + 0.003, lng: LNG,
    dist: 340, detail: true, lines: [{ id: "608", el: "Κ", en: "C" }],
    routes: [{ code: "r1", id: "608", el: "ΚΕΝΤΡΟ", en: "CENTRE" }],
    arrivals: [{ code: "r1", veh: "V2", min: 9 }] },
];
/* The geocoder names the same place the loaded stop does — which is the
   whole point of the dedupe test: three sources, one corner. */
const GEO = [
  { lat: String(LAT), lon: String(LNG), display_name: "Σύνταγμα, Αθήνα",
    address: { road: "ΣΥΝΤΑΓΜΑ", city: "Αθήνα" }, source: "ors", precision: "point" },
  { lat: String(LAT), lon: String(LNG), display_name: "Σύνταγμα, Αθήνα",
    address: { road: "ΣΥΝΤΑΓΜΑ", city: "Αθήνα" }, source: "ors", precision: "point" },
  { lat: "37.99", lon: "23.74", display_name: "Φιλοτίμου 12",
    address: { house_number: "12", road: "Φιλοτίμου", suburb: "Αμπελόκηποι" },
    source: "ors", precision: "address" },
];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const J = o => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/nearby") return J({ origin: {}, radius: 600, generated: NOW, hidden: 0, stops, reports: [] });
  if (u.pathname === "/geocode") return J(GEO);
  if (u.pathname === "/metro") return J([{ id: "m-syn", name: "Σύνταγμα", name_en: "SYNTAGMA",
    lines: ["2", "3"], lat: LAT, lng: LNG }]);
  const f = path.join(PUB, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (existsSync(f) && !f.includes("..")) {
    const e = path.extname(f);
    res.writeHead(200, { "Content-Type": e === ".js" ? "text/javascript" : "text/html; charset=utf-8" });
    return res.end(readFileSync(f));
  }
  J([]);
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function open({ lang = "en", slots = null } = {}) {
  const c = await browser.newContext({ viewport: { width: 390, height: 840 },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(([l, sl, tf]) => {
    try {
      localStorage.setItem("lang", l); localStorage.setItem("tourSeen", tf);
      if (sl) for (const k of Object.keys(sl)) localStorage.setItem("slot:" + k, JSON.stringify(sl[k]));
    } catch (_) {}
  }, [lang, slots, TOUR_FLAG]);
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1300);
  return { page, ctx: c, errs };
}
const rows = p => p.evaluate(() =>
  [...document.querySelectorAll("#jpp-res .res")].map(b => b.textContent.trim()));

console.log("\n— one FAQ, folded —");
{
  const v = await open();
  ok("the menu no longer carries About or Terms separately",
    await v.page.evaluate(() => !document.getElementById("m-about") && !document.getElementById("m-legal")),
    "two documents in two places is what nobody read");
  ok("Settings offers one informational row, and it is the FAQ",
    await v.page.evaluate(() => document.getElementById("set-faq").innerText.trim()) === "FAQ");
  await v.page.evaluate(() => openAbout());
  await v.page.waitForTimeout(200);
  const st = await v.page.evaluate(() => {
    const d = [...document.querySelectorAll("#ab-body .faq")];
    return { n: d.length, open: d.filter(x => x.open).length,
             qs: d.map(x => x.querySelector("summary").textContent.trim()) };
  });
  ok("every answer is a fold", st.n >= 8, `${st.n} entries`);
  ok("...and they all start closed, so the sheet is a list of questions",
    st.open === 0, `${st.open} open`);
  ok("the questions cover the app, not just the legals",
    st.qs.some(q => /pin a stop/i.test(q)) && st.qs.some(q => /plan a journey/i.test(q)),
    st.qs.join(" | "));
  ok("...and the legals are in there too",
    st.qs.some(q => /terms/i.test(q)) && st.qs.some(q => /data do you collect/i.test(q)));
  ok("the unofficial disclaimer stays outside the folds",
    await v.page.evaluate(() => !!document.querySelector("#ab-body .unofficial")),
    "it must not need opening to be read");
  await v.page.evaluate(() => document.querySelectorAll("#ab-body .faq")[0].open = true);
  ok("opening one reveals its answer",
    /unofficial/i.test(await v.page.evaluate(() =>
      document.querySelectorAll("#ab-body .faq")[0].innerText)));
  ok("the full legal page is still linked, for the authoritative text",
    await v.page.evaluate(() => !!document.querySelector('#ab-body a[href*="legal.html"]')));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open({ lang: "el" });
  await v.page.evaluate(() => openAbout());
  await v.page.waitForTimeout(200);
  const txt = await v.page.evaluate(() => document.getElementById("ab-body").innerText);
  ok("el: the FAQ is translated, questions and answers",
    /Τι είναι το OASAx/.test(txt) && /Όροι χρήσης/.test(txt), txt.slice(0, 60).replace(/\n/g, " "));
  await v.ctx.close();
}

console.log("\n— one row per place —");
{
  const v = await open();
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  await v.page.fill("#jpp-q", "syntagma");
  await v.page.waitForTimeout(1500);
  const r = await rows(v.page);
  const syn = r.filter(x => /συνταγμα|syntagma/i.test(x));
  ok("a corner known to the stop list, the metro list AND the geocoder is listed once",
    syn.length === 1, `${syn.length}: ${syn.join(" | ")}`);
  ok("...and the geocoder's own duplicate rows collapse too",
    r.filter(x => x === r[0]).length === 1, r.join(" | "));
  ok("a genuinely different place is still listed",
    r.some(x => /Φιλοτίμου 12/.test(x)), r.join(" | "));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open();
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  const r = await rows(v.page);
  ok("stops at different corners are still listed separately",
    r.some(x => /SYNTAGMA/.test(x)) && r.some(x => /AMPELOKIPI/.test(x)),
    r.join(" | "));
  ok("...so the fusing is by position, not by throwing rows away",
    r.filter(x => /🚏/.test(x)).length === 2, r.join(" | "));
  await v.ctx.close();
}

console.log("\n— home and work —");
{
  const v = await open();
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  const r = await rows(v.page);
  ok("both slots are offered when empty", r.some(x => /Set home/.test(x)) && r.some(x => /Set work/.test(x)),
    r.join(" | "));
  ok("...near the top, where a one-tap answer belongs",
    r.findIndex(x => /Set home/.test(x)) <= 1, r.join(" | "));

  await v.page.evaluate(() => {
    const b = [...document.querySelectorAll("#jpp-res .res")].find(x => /Set home/.test(x.textContent));
    b.click();
  });
  await v.page.waitForTimeout(150);
  ok("choosing it arms the picker, visibly",
    await v.page.evaluate(() => document.getElementById("jppick").classList.contains("arming")));
  ok("...and the heading says what it is now asking for",
    /home/i.test(await v.page.evaluate(() => document.getElementById("jpp-h").textContent)));

  await v.page.evaluate(() => {
    const b = [...document.querySelectorAll("#jpp-res .res")].find(x => /SYNTAGMA/i.test(x.textContent));
    b.click();
  });
  await v.page.waitForTimeout(250);
  const saved = await v.page.evaluate(() => JSON.parse(localStorage.getItem("slot:home") || "null"));
  ok("the place you pick is saved as home", saved && isFinite(saved.lat), JSON.stringify(saved));
  ok("...and is also used for this journey, rather than making you pick twice",
    await v.page.evaluate(() => !!jp.to && isFinite(jp.to.lat)));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open({ slots: { home: { lat: LAT, lng: LNG, label: "Φιλοτίμου 12" } } });
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  const r = await rows(v.page);
  ok("a set home shows as a place, not as a prompt",
    r.some(x => /Home/.test(x) && !/Set home/.test(x)), r.join(" | "));
  ok("...carrying the address it was set to", r.some(x => /Φιλοτίμου 12/.test(x)), r.join(" | "));
  ok("work is still offered as empty", r.some(x => /Set work/.test(x)));
  await v.ctx.close();
}
{
  const v = await open({ slots: { home: { lat: LAT, lng: LNG, label: "X" } } });
  await v.page.evaluate(() => { openJourney(); openJourneyPick("to"); });
  await v.page.waitForTimeout(300);
  // long-press clears it — the same gesture that unpins a favourite
  const box = await v.page.evaluate(() => {
    const b = [...document.querySelectorAll("#jpp-res .res")].find(x => /Home/.test(x.textContent));
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await v.page.mouse.move(box.x, box.y);
  await v.page.mouse.down();
  await v.page.waitForTimeout(700);
  await v.page.mouse.up();
  await v.page.waitForTimeout(300);
  ok("long-pressing a slot clears it",
    (await v.page.evaluate(() => localStorage.getItem("slot:home"))) === null,
    "same gesture as unpinning a favourite, so there is one thing to learn");
  await v.ctx.close();
}

console.log("\n— two gestures, one job each —");
{
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("nothing toggles a favourite any more", !/function toggleFav/.test(html),
    "one gesture doing opposite things by hidden state is how a repeat undid your own pin");
  ok("double-tap adds", /onDoubleTap\([^)]*\)[\s\S]{0,80}addFav\(/.test(html));
  ok("long-press removes", /onLongPress\([^)]*\)[\s\S]{0,80}removeFav\(/.test(html));
  for (const where of ["hd", "el", '$("#sc-hd")']) {
    const re = new RegExp(`onLongPress\\(${where.replace(/[$()#"]/g, "\\$&")}`);
    ok(`...on the ${where === "hd" ? "list card" : where === "el" ? "map pin" : "stop card"} too`, re.test(html));
  }
  ok("adding something already pinned says so rather than silently undoing it",
    /favAlready/.test(html));
  ok("the hint text teaches the new gesture",
    /Long-press the name to unpin/.test(html) && /Κράτα πατημένο το όνομα/.test(html));
}
{
  const v = await open();
  const before = await v.page.evaluate(() => favs.length);
  await v.page.evaluate(() => addFav(state.stops[0]));
  await v.page.waitForTimeout(120);
  ok("adding pins one", await v.page.evaluate(() => favs.length) === before + 1);
  await v.page.evaluate(() => addFav(state.stops[0]));
  await v.page.waitForTimeout(120);
  ok("adding it again does not unpin it", await v.page.evaluate(() => favs.length) === before + 1,
    "the old toggle would have removed it here");
  await v.page.evaluate(() => removeFav(state.stops[0]));
  await v.page.waitForTimeout(120);
  ok("removing unpins it", await v.page.evaluate(() => favs.length) === before);
  await v.page.evaluate(() => removeFav(state.stops[1]));
  ok("removing something never pinned is a no-op",
    await v.page.evaluate(() => favs.length) === before);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

console.log("\n— the carousel shows the real controls —");
{
  const v = await open();
  await v.page.evaluate(() => { tourAt = 0; $("#tour").hidden = false; paintTour(); });
  await v.page.waitForTimeout(200);
  const dot = await v.page.evaluate(() => {
    const d = document.querySelector("#tour-art .livedot");
    return d ? getComputedStyle(d).borderColor : null;
  });
  ok("card one shows the actual live dot", !!dot, String(dot));
  ok("...in the colour the button really is",
    /178, 84, 10/.test(dot || ""), String(dot),
    "a black glyph asked you to translate before you could look");
  await v.page.evaluate(() => { tourAt = 1; paintTour(); });
  const star = await v.page.evaluate(() => {
    const s = document.querySelector("#tour-art .art-star");
    return s ? getComputedStyle(s).color : null;
  });
  ok("card two shows a star in the pin colour", /240, 201, 63/.test(star || ""), String(star));
  await v.page.evaluate(() => { tourAt = 2; paintTour(); });
  const seg = await v.page.evaluate(() => {
    const s = document.querySelector("#tour-art .art-seg");
    return s ? s.innerText.replace(/\s+/g, " ").trim() : null;
  });
  ok("card three shows the list/map control, labelled as it is in the app",
    /list/i.test(seg || "") && /map/i.test(seg || ""), String(seg));
  await v.page.evaluate(() => { tourAt = 3; paintTour(); });
  ok("card four shows the journey button, the same three characters as the header",
    await v.page.evaluate(() => {
      const a = document.querySelector("#tour-art .art-plan .ab");
      const h = document.querySelector("#planbtn .ab");
      return !!a && !!h && a.textContent === h.textContent;
    }));
  await v.page.evaluate(() => { tourAt = TOUR.length - 1; paintTour(); });
  ok("the last card shows the app's own mark",
    await v.page.evaluate(() => !!document.querySelector("#tour-art .mark")));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

/* An alert you set once is nearly always the alert you want again, an hour
   later or a stop along. Until now the only thing you could do to one was
   delete it and retype the whole thing from the stop upwards. */
console.log("\n— an alert can be edited, not only deleted —");
{
  const v = await open();
  const RULE = {
    id: "r-1", sub: "s-1", stopCode: "9001", stopName: "PANORMOU",
    lineId: "608", routeCodes: ["rc-9"], routeName: "608 TO GALATSI",
    days: [2, 4], from: "07:15", to: "07:45", leads: [15, 3], enabled: true,
  };
  await v.page.evaluate(r => {
    hasBackend = () => true;            // no push in a test browser
    state.subId = "s-1";
    state.rules = [r];
    renderAlerts();
  }, RULE);
  await v.page.waitForTimeout(150);

  const btns = await v.page.evaluate(() =>
    [...document.querySelectorAll("#rulelist .rule button")]
      .map(b => [b.textContent, b.getAttribute("aria-label")]));
  ok("each alert offers two things, not one", btns.length === 2, JSON.stringify(btns));
  ok("...edit first, delete second",
    btns[0][0].startsWith("\u270E") && btns[1][0] === "✕",
    JSON.stringify(btns.map(b => b[0])));
  ok("...and the pencil is asked for as a glyph, not a colour emoji",
    btns[0][0].includes("\uFE0E"), JSON.stringify(btns[0][0]));
  ok("...both named for a screen reader",
    btns.every(b => b[1] && b[1].length > 2), JSON.stringify(btns.map(b => b[1])));

  await v.page.evaluate(() => document.querySelector("#rulelist .rule button").click());
  await v.page.waitForTimeout(400);
  const form = await v.page.evaluate(() => ({
    head: (document.querySelector("#ruleform .fhead") || {}).textContent || "",
    stop: (() => { const s = document.getElementById("f-stop");
      return s.options[s.selectedIndex].textContent.trim(); })(),
    route: document.getElementById("f-route").value,
    routeText: (() => { const r = document.getElementById("f-route");
      return r.options[r.selectedIndex] ? r.options[r.selectedIndex].textContent.trim() : ""; })(),
    from: document.getElementById("f-from").value,
    to: document.getElementById("f-to").value,
    days: [...document.querySelectorAll("#f-days .chip")].filter(c => c.classList.contains("on"))
      .map(c => c.textContent),
    leads: [...document.querySelectorAll("#f-leads .chip")].filter(c => c.classList.contains("on"))
      .map(c => c.textContent),
    marked: !!document.querySelector("#rulelist .rule.editing"),
  }));
  ok("editing opens the form on the rule's own stop", /PANORMOU/.test(form.stop), form.stop);
  ok("...its own times", form.from === "07:15" && form.to === "07:45",
    `${form.from}–${form.to}`);
  ok("...its own days, not the weekday default",
    form.days.length === 2 && form.days.join() !== "Mo,Tu,We,Th,Fr", form.days.join(" "));
  ok("...and its own lead times", form.leads.join(" ") === "15′ 3′", form.leads.join(" "));
  /* This stop's directions never load in the harness, which is the same
     thing that happens when OASA is down or the direction was retired. The
     rule's own line has to survive that, or saving would quietly move the
     alert to whichever bus happened to sort first. */
  ok("...keeping the line even when the stop's directions do not load",
    form.route === "rc-9" && /608/.test(form.routeText), `${form.route} · ${form.routeText}`);
  ok("the row being edited says so", form.marked,
    "otherwise the form is indistinguishable from a new alert");
  ok("...and the form says which alert it is changing", /PANORMOU/.test(form.head), form.head);

  /* The Worker replaces a rule when the POST carries its id and refuses
     when the sub does not match, so editing needed no new endpoint. */
  const src = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("saving an edit carries the id, which is what makes it a replace",
    /if\(edit\)\{[\s\S]{0,80}rule\.id=edit\.id;/.test(src),
    "POST /rules with an id replaces in place");

  await v.page.evaluate(() => { document.querySelectorAll("#ruleform button")
    .forEach(b => { if (/cancel/i.test(b.textContent)) b.click(); }); });
  await v.page.waitForTimeout(200);
  await v.page.evaluate(() => renderForm());
  await v.page.waitForTimeout(300);
  const fresh = await v.page.evaluate(() => ({
    head: !!document.querySelector("#ruleform .fhead"),
    from: document.getElementById("f-from").value,
    days: [...document.querySelectorAll("#f-days .chip")].filter(c => c.classList.contains("on")).length,
  }));
  ok("a new alert afterwards is a new alert, not the last one again",
    !fresh.head && fresh.from === "08:30" && fresh.days === 5,
    `${fresh.from}, ${fresh.days} days`);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

/* The alert form is taller than a laptop window. It used to open below the
   fold with nothing scrolled into view, so Save and Cancel were simply not
   on screen — which reads as "the window didn't finish rendering" rather
   than "scroll down". Checked at the height that broke, not the one that
   happened to work. */
console.log("\n— the alert form fits the window it is opened in —");
for (const [w, h] of [[1366, 768], [1280, 600], [1024, 560], [390, 844], [360, 640]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(tf => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf); } catch (_) {}
  }, TOUR_FLAG);
  const page = await c.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    hasBackend = () => true; state.subId = "s-1";
    state.rules = [{ id: "r-1", sub: "s-1", stopCode: "9001", stopName: "PANORMOU",
      lineId: "608", routeCodes: ["rc-9"], routeName: "TO GALATSI", days: [1, 2, 3, 4, 5],
      from: "08:30", to: "08:50", leads: [10, 5], enabled: true }];
    openAlerts(); renderForm();
  });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const act = document.querySelector("#ruleform .formact");
    if (!act) return { missing: true };
    const seen = [...act.querySelectorAll("button")].map(b => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim().slice(0, 8),
               vis: r.top >= -1 && r.bottom <= innerHeight + 1 && r.height > 0 };
    });
    return { sticky: getComputedStyle(act).position, seen };
  });
  ok(`${w}x${h}: the finishing buttons are on screen without scrolling`,
    !m.missing && m.seen.length >= 2 && m.seen.every(b => b.vis),
    JSON.stringify(m.seen));
  ok(`${w}x${h}: ...because they are pinned, not merely near the bottom`,
    m.sticky === "sticky", String(m.sticky));
  await c.close();
}
{
  /* The other half: the form has to be where you are looking when it
     opens, not 500px below the list you were just reading. */
  const c = await browser.newContext({ viewport: { width: 1280, height: 600 } });
  await c.addInitScript(tf => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf); } catch (_) {}
  }, TOUR_FLAG);
  const page = await c.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    hasBackend = () => true; state.subId = "s-1";
    state.rules = Array.from({ length: 4 }, (_, i) => ({ id: "r" + i, sub: "s-1",
      stopCode: "900" + i, stopName: "STOP " + i, lineId: "60" + i, routeCodes: ["rc" + i],
      routeName: "somewhere", days: [1], from: "08:30", to: "08:50", leads: [5], enabled: true }));
    openAlerts();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => renderForm());
  await page.waitForTimeout(700);                    // the scroll is animated
  const top = await page.evaluate(() => {
    const f = document.getElementById("ruleform").getBoundingClientRect();
    const sh = document.querySelector("#alertbg .sheet").getBoundingClientRect();
    return Math.round(f.top - sh.top);
  });
  ok("opening the form scrolls it into view, past a list of four alerts",
    top < 120, `form starts ${top}px into the sheet`);
  await c.close();
}

console.log("\n— the menu says what each entry does —");
{
  const v = await open();
  const items = await v.page.evaluate(() =>
    [...document.querySelectorAll("#menu .menu-item")].filter(b => !b.hidden)
      .map(b => b.innerText.replace(/\s+/g, " ").trim()));
  /* Journey left the menu for the header button row, so what is left is
     the two things that are genuinely menu-shaped. */
  ok("two entries, not six", items.length === 2, items.join(" | "));
  ok("each carries a line saying what it is for",
    items.every(x => x.split(" ").length > 2), items.join(" | "));
  ok("the journey is not among them any more",
    !/journey/i.test(items.join(" ")), items.join(" | "));
  ok("...it sits in the header instead, left of reports",
    await v.page.evaluate(() => {
      const b = [...document.querySelectorAll(".brand .iconbtn")].map(x => x.id);
      return b[0] === "planbtn" && b[1] === "reportbtn";
    }));
  /* A <button> carries the UA's own padding, and 1px 6px of it leaves a
     16px content box inside these 30px — narrower than the label, which
     then overflowed to one side instead of centring. The amount differs
     per engine, so it looked right on a desktop and wrong on a phone. */
  const ab = await v.page.evaluate(() => {
    const b = document.getElementById("planbtn").getBoundingClientRect();
    const s = document.querySelector("#planbtn .ab").getBoundingClientRect();
    return { dx: (s.x + s.width / 2) - (b.x + b.width / 2),
             dy: (s.y + s.height / 2) - (b.y + b.height / 2),
             fits: s.width <= b.width && s.height <= b.height };
  });
  ok("...with its label centred in the button, not pushed off one side",
    Math.abs(ab.dx) < 0.6 && Math.abs(ab.dy) < 0.6, `off by ${ab.dx.toFixed(2)},${ab.dy.toFixed(2)}`);
  ok("...and fitting inside it", ab.fits);
  /* U+2192 is missing from the monospace faces several phones ship, and
     the symbol font that supplies it brings its own metrics. */
  ok("...drawing the arrow rather than typing it",
    await v.page.evaluate(() => {
      const s = document.querySelector("#planbtn .ab");
      return !/→/.test(s.textContent) && !!s.querySelector("i");
    }), "no glyph, nothing to fall back to");
  ok("...which opens the panel without changing the board underneath",
    await v.page.evaluate(async () => {
      const before = state.view;
      document.getElementById("planbtn").click();
      await new Promise(r => setTimeout(r, 200));
      return state.view === before && document.getElementById("jp").classList.contains("on");
    }));
  /* The segment keeps pointing at the board, which is still there behind
     the panel — the journey is not a third view of it. */
  ok("...leaving the segment on the view it was showing",
    await v.page.evaluate(() => document.getElementById("t-vlist").classList.contains("on")
      && document.getElementById("planbtn").classList.contains("on")));
  ok("...and the button goes quiet again on close",
    await v.page.evaluate(async () => {
      closeJourney();
      await new Promise(r => setTimeout(r, 150));
      return !document.getElementById("planbtn").classList.contains("on")
        && document.getElementById("t-vlist").classList.contains("on");
    }));
  ok("Settings is set apart from the two that use the app",
    await v.page.evaluate(() => document.getElementById("m-settings").classList.contains("apart")));
  await v.ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
