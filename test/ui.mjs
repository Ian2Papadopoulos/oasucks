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
  // the mode probe: "is there a Worker on this origin"
  if (u.pathname === "/health") return J({ ok: true, version: "test" });
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

/* Two gestures nobody was told about — double-tap to pin, long-press to
   unpin — became one that shows you the choices, and is also how an alert
   gets made. */
console.log("\n— one gesture, and it shows you the choices —");
{
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("nothing toggles a favourite any more", !/function toggleFav/.test(html),
    "one gesture doing opposite things by hidden state is how a repeat undid your own pin");
  ok("double-tap no longer means anything on a stop",
    !/onDoubleTap\([^)]*\)[\s\S]{0,80}addFav\(/.test(html),
    "an invisible gesture is a feature nobody finds");
  for (const [where, what] of [["hd", "list card"], ["el", "map pin"], ['$("#sc-hd")', "stop card"]]) {
    const re = new RegExp(`onLongPress\\(${where.replace(/[$()#"]/g, "\\$&")}[\\s\\S]{0,90}openStopMenu`);
    ok(`long-press opens it on the ${what}`, re.test(html));
  }
  ok("adding something already pinned says so rather than silently undoing it",
    /favAlready/.test(html));
}
{
  const v = await open();
  const card = await v.page.$("#list .stop .stop-hd");
  const b = await card.boundingBox();
  await v.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await v.page.mouse.down();
  await v.page.waitForTimeout(650);
  await v.page.mouse.up();
  await v.page.waitForTimeout(250);
  const m = await v.page.evaluate(() => ({
    open: !document.getElementById("stopmenu").hidden,
    name: document.getElementById("sm-name").textContent,
    acts: [...document.querySelectorAll("#stopmenu .sm-act")].map(x => x.textContent.trim()),
    blur: getComputedStyle(document.getElementById("stopmenu")).backdropFilter,
  }));
  ok("a long press on a list stop opens the menu", m.open);
  ok("...naming the stop it is about", /\w/.test(m.name), m.name);
  ok("...offering exactly two things", m.acts.length === 2, m.acts.join(" | "));
  ok("...pinning and an alert", /Pin/i.test(m.acts[0]) && /alert/i.test(m.acts[1]),
    m.acts.join(" | "));
  /* The question "which stop is this about" is answered by the name on the
     card, not by reading the list through it. */
  ok("...over a blurred board, not merely a dimmed one", /blur/.test(m.blur), m.blur);

  const pinned = await v.page.evaluate(async () => {
    const n = favs.length;
    document.getElementById("sm-fav").click();
    await new Promise(r => setTimeout(r, 200));
    return { added: favs.length === n + 1, closed: document.getElementById("stopmenu").hidden };
  });
  ok("...pinning from it works, and closes it", pinned.added && pinned.closed);

  /* Second press on the same stop now offers to unpin: one entry that
     knows which way it points, rather than two gestures that do not. */
  const again = await v.page.evaluate(() => {
    openStopMenu(state.stops[0]);
    return document.getElementById("sm-fav").textContent;
  });
  ok("...and a pinned stop is offered the opposite", /Unpin/i.test(again), again);
  await v.ctx.close();
}
{
  /* An alert used to mean opening the bell and finding the stop again in a
     dropdown — the same stop you were already looking at. */
  const v = await open();
  const made = await v.page.evaluate(async () => {
    hasBackend = () => true; state.subId = "s1"; state.rules = [];
    openStopMenu(state.stops[0]);
    document.getElementById("sm-alert").click();
    await new Promise(r => setTimeout(r, 500));
    const sel = document.getElementById("f-stop");
    return {
      panel: document.getElementById("alertbg").classList.contains("on"),
      head: (document.querySelector("#ruleform .fhead") || {}).textContent || "",
      stop: sel ? sel.options[sel.selectedIndex].textContent.trim() : null,
      buttons: [...document.querySelectorAll("#ruleform .formact button")].map(x => x.textContent),
    };
  });
  ok("the alert option opens the form on that stop", made.panel && /\w/.test(made.stop), made.stop);
  ok("...saying which stop, at the top", /alert/i.test(made.head) && made.head.includes(made.stop),
    made.head);
  ok("...and '+ New alert' is gone, being the friction this replaces",
    !made.buttons.some(x => /new alert/i.test(x)), made.buttons.join(" | "));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  /* A stop you found by searching is still a stop. The search results are
     the one place that draws a row and then never touches it again, so the
     pin has to be painted back in by hand — and the row's own click must
     not fire behind the menu on a mouse. */
  const v = await open();
  await v.page.click("#findbtn");
  await v.page.waitForTimeout(200);
  await v.page.fill("#lnq", "SYNTAGMA");
  await v.page.evaluate(() => doLineSearch());
  await v.page.waitForTimeout(400);
  const res = await v.page.$("#lnres .res");
  ok("searching by name finds the stop", !!res);
  const b = await res.boundingBox();
  await v.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await v.page.mouse.down();
  await v.page.waitForTimeout(650);
  await v.page.mouse.up();
  await v.page.waitForTimeout(250);
  const m = await v.page.evaluate(() => ({
    open: !document.getElementById("stopmenu").hidden,
    name: document.getElementById("sm-name").textContent,
    card: document.getElementById("stopcard").classList.contains("on"),
  }));
  ok("...and holding it opens the same menu", m.open);
  ok("...on the stop that was held", /SYNTAGMA/i.test(m.name), m.name);
  ok("...without also opening the stop card behind it", !m.card);

  const flip = await v.page.evaluate(async () => {
    document.getElementById("sm-fav").click();
    await new Promise(r => setTimeout(r, 250));
    return document.querySelector("#lnres .res").innerHTML;
  });
  ok("...and the result row shows the pin straight away", /★/.test(flip), flip.slice(0, 60));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
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
    to: document.getElementById("f-to").value,
    days: [...document.querySelectorAll("#f-days .chip")].filter(c => c.classList.contains("on")).length,
    want: nowWindow(),
  }));
  ok("a new alert afterwards is a new alert, not the last one again",
    !fresh.head && fresh.days === 5, `${fresh.from}, ${fresh.days} days`);
  /* 08:30–08:50 was somebody else's commute. You set an alert because of
     the bus you are waiting for now, so the window starts five minutes
     behind the clock and runs half an hour ahead. */
  ok("...and its window is around right now, not a hard-coded morning",
    fresh.from === fresh.want.from && fresh.to === fresh.want.to,
    `${fresh.from}–${fresh.to}`);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

/* There is no probe now, and that is the fix.

   The app used to prove a Worker was there before trusting it: first by
   calling /api, which the Worker answers by calling OASA, so a slow
   upstream convinced it there was no backend at all; then by calling
   /health, which asked the right question but still hung the whole boot on
   one request winning. Both failed in production, and both looked to the
   rider like an app that simply does not work.

   A deployment has a Worker on its own origin — that is what deploying it
   means. Assume it, and let an unambiguous 404 be the only thing that says
   otherwise. */
/* Real cards are inserted BEFORE whatever is already in the list, so a
   placeholder left behind ends up underneath it. The clear-out checked only
   for `.msg`, which meant the loading skeletons added in v65 survived the
   first real render and sat at the bottom of the board pretending to load,
   forever. */
console.log("\n— nothing left over under the last stop —");
{
  const v = await open();
  await v.page.waitForTimeout(1400);
  const before = await v.page.evaluate(() => ({
    stops: document.querySelectorAll("#list .stop").length,
    skel: document.querySelectorAll("#list .skel-card").length,
  }));
  ok("a loaded board has no placeholders in it", before.skel === 0,
    `${before.stops} cards, ${before.skel} placeholders`);

  /* Drive the exact sequence that produced it: an empty board paints
     placeholders, then stops arrive. */
  const after = await v.page.evaluate(async () => {
    const keep = state.stops;
    state.stops = []; bootDone = false; bootFail = null; renderList();
    const mid = document.querySelectorAll("#list .skel-card").length;
    state.stops = keep; bootDone = true; renderList();
    return { mid, skel: document.querySelectorAll("#list .skel-card").length,
      stops: document.querySelectorAll("#list .stop:not(.skel-card)").length,
      lastIsCard: !(document.querySelector("#list").lastElementChild || {})
        .classList?.contains("skel-card") };
  });
  ok("...the waiting board does paint them", after.mid > 0, `${after.mid} placeholders`);
  ok("...and the stops arriving clears every one", after.skel === 0,
    `${after.stops} cards, ${after.skel} left over`);
  ok("...so the last thing in the list is a real stop", after.lastIsCard);
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

console.log("\n— no probe at all —");
{
  const c = await browser.newContext({ viewport: { width: 390, height: 840 },
    permissions: ["geolocation"], geolocation: { latitude: LAT, longitude: LNG, accuracy: 12 } });
  await c.addInitScript(tf => {
    try { localStorage.setItem("lang", "en"); localStorage.setItem("tourSeen", tf); } catch (_) {}
  }, TOUR_FLAG);
  const page = await c.newPage();
  const probes = [], upstream = [];
  page.on("request", r => {
    if (/\/health$/.test(new URL(r.url()).pathname)) probes.push(r.url());
    if (/getClosestStops&p1=37\.9755&p2=23\.7348/.test(r.url())) upstream.push(r.url());
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  ok("a cold boot spends no request finding out where it is",
    probes.length === 0 && upstream.length === 0,
    `${probes.length} health, ${upstream.length} upstream`);
  ok("...it assumes the backend it was deployed with",
    await page.evaluate(() => MODE === "same" && hasBackend()));
  const settled = await page.evaluate(async () => {
    const all = await Promise.all([ensureMode(), ensureMode(), ensureMode()]);
    return all.every(m => m === "same");
  });
  ok("...and every caller gets that answer without waiting on anything", settled);
  ok("only an unambiguous 404 talks it out of it",
    await page.evaluate(() => {
      const before = MODE;
      const a = downgradeMode(500), b = downgradeMode(0), c = downgradeMode(502);
      const held = MODE === before && !a && !b && !c;
      const gone = downgradeMode(404) && MODE === "none" && !hasBackend();
      MODE = before;
      return held && gone;
    }), "a 5xx or a timeout is a bad minute, not a missing backend");
  await c.close();
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

/* The header carries what you reach for; ☰ carries what you set once.
   Line search moved out of the menu, which left one row leading to
   Settings — a button wearing a costume. */
console.log("\n— the header row, and a ☰ that is just Settings —");
{
  const v = await open();
  const ids = await v.page.evaluate(() =>
    [...document.querySelectorAll(".brand .iconbtn")].map(b => b.id));
  ok("four buttons, in the order you reach for them",
    ids.join(",") === "findbtn,planbtn,reportbtn,menubtn", ids.join(","));
  ok("...search first, in front of the journey", ids[0] === "findbtn");
  ok("...and ☰ last, because it is the one you use least",
    ids[ids.length - 1] === "menubtn");
  /* The bell was a button you pressed to make an alert. Alerts are made by
     holding a stop now, so what is left is reviewing the ones you set —
     which is a settings row, not a thing you reach for at a bus stop. */
  ok("no bell in the header any more", !ids.includes("bell"), ids.join(","));
  ok("the search button opens the line search",
    await v.page.evaluate(async () => {
      document.getElementById("findbtn").click();
      await new Promise(r => setTimeout(r, 250));
      return document.getElementById("linebg").classList.contains("on");
    }), "it used to be two taps behind ☰");
  await v.page.evaluate(() => closeLineSearch());
  ok("☰ opens Settings itself, with no menu in between",
    await v.page.evaluate(async () => {
      document.getElementById("menubtn").click();
      await new Promise(r => setTimeout(r, 250));
      return document.getElementById("setbg").classList.contains("on")
        && document.getElementById("menu").hidden;
    }), "a menu with one row is a button in a costume");
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const v = await open();
  const row = await v.page.evaluate(async () => {
    state.subId = "s1";
    state.rules = [{ id: "a", enabled: true }, { id: "b", enabled: true }];
    bellBadge();
    document.getElementById("menubtn").click();
    await new Promise(r => setTimeout(r, 250));
    return { label: document.getElementById("set-alerts-t").textContent,
             value: document.getElementById("set-alerts-v").textContent,
             first: document.querySelector("#setbg .setrow").id };
  });
  ok("Settings carries the alerts, first in the panel", row.first === "set-alerts");
  ok("...named, so it is not a mystery row", /alert/i.test(row.label), row.label);
  ok("...and still says how many are set, which is what the badge did",
    row.value === "2", row.value);
  const opened = await v.page.evaluate(async () => {
    document.getElementById("set-alerts").click();
    await new Promise(r => setTimeout(r, 300));
    return { alerts: document.getElementById("alertbg").classList.contains("on"),
             settings: document.getElementById("setbg").classList.contains("on") };
  });
  ok("...opening the alerts panel, and closing Settings behind it",
    opened.alerts && !opened.settings, JSON.stringify(opened));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}

/* "Two minutes have passed and it does not update promptly." A refresh is
   45 seconds, 75 if you have not touched the screen, and the board did not
   move between them — so a bus shown as 4 minutes sat there saying four
   until the next fetch landed, by which time it had gone. */
console.log("\n— the minutes count down between sweeps —");
{
  const v = await open();
  const before = await v.page.evaluate(() =>
    [...document.querySelectorAll("#list .row .eta .v")].map(x => x.textContent));
  ok("the board starts with the minutes the server sent", before.length > 0, before.join(","));

  /* Wind the clock the board is dated from back three minutes, which is
     what sitting still for three minutes does. */
  const after = await v.page.evaluate(async () => {
    boardAt -= 3 * 60000;
    etaDrift = -1;                       // force the tick to notice
    renderView();
    await new Promise(r => setTimeout(r, 150));
    return [...document.querySelectorAll("#list .row .eta .v")].map(x => x.textContent);
  });
  ok("...and three minutes later they are three minutes smaller",
    JSON.stringify(after) !== JSON.stringify(before), `${before.join(",")} -> ${after.join(",")}`);

  /* A bus more than a minute past due has gone. Keeping its row is worse
     than showing nothing: it is the one people step out to the kerb for. */
  const gone = await v.page.evaluate(async () => {
    boardAt -= 30 * 60000;
    etaDrift = -1; renderView();
    await new Promise(r => setTimeout(r, 150));
    return { rows: document.querySelectorAll("#list .row").length,
             empty: document.querySelectorAll("#list .empty").length };
  });
  ok("...and a bus half an hour past due is off the board, not frozen on it",
    gone.rows === 0 && gone.empty > 0, JSON.stringify(gone));
  ok("no page errors", v.errs.length === 0, v.errs.join(" | "));
  await v.ctx.close();
}
{
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  ok("the board is dated from when the numbers were true, not when they arrived",
    /lastLoad = gen \? gen\*1000 : Date\.now\(\)/.test(html),
    "the Worker takes its own cache age out before sending them");
  ok("...and every place that shows a minute uses the same clock",
    !/\$\{a\.min\}/.test(html) && !/String\(a\.min\)/.test(html),
    "one countdown, not one per screen");
  const w = readFileSync(path.join(REPO, "worker.js"), "utf8");
  ok("the Worker subtracts its cache age from the minutes it serves",
    /function ageArrivals/.test(w) && /ageArrivals\(\(Array\.isArray\(got\.data\)/.test(w),
    "a 50-second-old '4 minutes' is really three");
  ok("...reading the age from the response, not guessing it",
    /parseInt\(r\.headers\.get\("Age"\)/.test(w));
}

/* Two string tables maintained by hand will drift, and the failure is
   invisible in the language you are not testing in: a key added to `en`
   and missed in `el` renders as `undefined` for every Greek rider. */
console.log("\n— the app is one thing, not the sediment of seventy versions —");
{
  const v = await open();
  const d = await v.page.evaluate(() => {
    const el = Object.keys(T.el), en = Object.keys(T.en);
    return { onlyEl: el.filter(k => !en.includes(k)), onlyEn: en.filter(k => !el.includes(k)),
             n: el.length,
             mismatched: el.filter(k => en.includes(k) && typeof T.el[k] !== typeof T.en[k]) };
  });
  ok("both languages carry exactly the same keys",
    !d.onlyEl.length && !d.onlyEn.length,
    `el-only: ${d.onlyEl.join(",") || "none"} | en-only: ${d.onlyEn.join(",") || "none"}`);
  ok("...and the same shapes, so a plural rule cannot become a bare string",
    !d.mismatched.length, d.mismatched.join(","));
  ok("...and there are still strings", d.n > 200, `${d.n} keys`);
  /* The other direction, and the one that actually bit: a key the code
     calls but no table defines renders as the word "undefined" in the UI.
     Tidying up unused strings is exactly when this happens. */
  const src = readFileSync(path.join(PUB, "index.html"), "utf8");
  const used = [...new Set([...src.matchAll(/[^a-zA-Z]t\("([a-zA-Z0-9_]+)"\)/g)].map(m => m[1]))];
  const missing = await v.page.evaluate(
    u => u.filter(k => T.el[k] === undefined || T.en[k] === undefined), used);
  ok("every string the code asks for exists in both tables",
    !missing.length, missing.join(",") || `${used.length} keys checked`);
  await v.ctx.close();
}
{
  const html = readFileSync(path.join(PUB, "index.html"), "utf8");
  /* A retired feature that still ships is a feature: it costs every page
     load, it shows up in every search, and it has to be reasoned about
     every time something near it changes. */
  for (const gone of ["openStats", "renderStats", "statbg", "trackList", "myPosition",
                      "reportForMetro"]) {
    ok(`the retired ${gone} is gone, not merely unreachable`,
      !new RegExp(`\\b${gone}\\b`).test(html));
  }
  /* One 404 from the Worker used to switch the app to third-party CORS
     proxies for the rest of the session, sending riders' coordinates to a
     stranger's server with nothing on screen to say so. */
  ok("no third-party host is called from the browser at all",
    !/allorigins|corsproxy|nominatim\.openstreetmap/.test(html),
    "the geocoder and the OASA proxy both go through the Worker");
  ok("...and a missing backend is a missing backend, not a silent downgrade",
    /MODE="none"/.test(html) && !/PUBLIC_PROXIES/.test(html),
    "one 404 used to switch every later call to a stranger's server");
  const hdr = readFileSync(path.join(PUB, "_headers"), "utf8");
  ok("so connect-src can finally be closed",
    /Content-Security-Policy:/.test(hdr) && /connect-src 'self'/.test(hdr),
    "injected script cannot exfiltrate what it cannot send");
  ok("...with framing, objects and form posts denied outright",
    /frame-ancestors 'none'/.test(hdr) && /object-src 'none'/.test(hdr)
    && /form-action 'none'/.test(hdr));
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
