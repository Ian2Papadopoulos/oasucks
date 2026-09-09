/* The app is OASAx. The old name was a pun that no longer applies, and it
   used to be spread across the page title, the manifest, the push fallback
   and the About copy — so this asserts it is gone from all of them rather
   than from whichever one someone remembered to check.
   The old name is assembled at runtime rather than written out, so this
   file does not trip its own search. */
import { chromium } from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "  ok  " : "FAIL  "}${n}${x ? "  — " + x : ""}`); };
const read = p => readFileSync(path.join(REPO, p), "utf8");

console.log("\n— the old name is gone everywhere —");
{
  const files = [];
  const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => {
    if (["node_modules", ".git", "vendor"].includes(e.name)) return;
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    if (/\.(html|js|mjs|md|json|toml|webmanifest)$/.test(e.name)
        && e.name !== "package-lock.json") files.push(f);
  });
  walk(REPO);
  const OLD = new RegExp(["OAS", "UCKS"].join(""), "i");
  const dirty = files.filter(f => OLD.test(readFileSync(f, "utf8")));
  ok("no file still says the old name", dirty.length === 0,
     dirty.map(f => path.relative(REPO, f)).join(", "));
}

console.log("\n— and the new one is in the places that matter —");
{
  const idx = read("public/index.html");
  ok("the page title", /<title>OASAx/.test(idx), (idx.match(/<title>[^<]*/) || [])[0]);
  ok("the iOS home-screen name", /apple-mobile-web-app-title" content="OASAx"/.test(idx));
  ok("the About panel, both languages",
     (idx.match(/<b>OASAx<\/b>/g) || []).length === 2,
     `${(idx.match(/<b>OASAx<\/b>/g) || []).length} of 2`);
  const man = JSON.parse(read("public/manifest.webmanifest"));
  ok("the installed app name", /^OASAx/.test(man.name), man.name);
  ok("...and its short name", man.short_name === "OASAx", man.short_name);
  const sw = read("public/sw.js");
  ok("a push with no title falls back to OASAx", (sw.match(/"OASAx"/g) || []).length === 2,
     `${(sw.match(/"OASAx"/g) || []).length} of 2`);
}

console.log("\n— the wordmark is one word, and the mark carries an x —");
{
  const idx = read("public/index.html");
  ok("the wordmark reads OASA + x",
     /<span class="w-oasa">OASA<\/span><span class="w-x">x<\/span>/.test(idx));
  ok("...with the two-line pun stack gone", !/<span>O A<\/span>/.test(idx));

  /* v46 replaced the two crossing strokes with a single yellow X. Two
     lines read as a strikeout cancelling the name; one X reads as a mark
     stamped on it, which is the thing the app is called. */
  const after = (idx.match(/\.mark::after\{[^}]*\}/s) || [""])[0];
  ok("the mark carries a literal X, not a pair of struck lines",
     /content:"X"/.test(after), after.slice(0, 60));
  /* Two marks now, on purpose. The icon and the header wear the yellow X;
     the SPLASH wears the original black-and-white strike, which is the
     quiet opening frame. The risk is one bleeding into the other, so:
     no unscoped strike rule anywhere, and the strike that does exist must
     be scoped to the splash. */
  ok("...no strikeout rule applies to the icon mark",
     !/(^|\n)\s*\.mark::before\{/.test(idx),
     "an unscoped line would strike through the X as well");
  ok("the splash keeps the original strike, and only the splash",
     /\.splash \.mark::before/.test(idx) && /\.splash \.mark::after\{[^}]*rotate\(-7deg\)/s.test(idx),
     "the two marks are different by choice, not by drift");
  ok("...and it is colourless, which is what makes it the quiet one",
     !/\.splash \.mark::(before|after)\{[^}]*var\(--marker\)/s.test(idx));
  ok("...and it is yellow, the one colour the wordmark's x already uses",
     /color:var\(--marker\)/.test(after), after);
  ok("...set in the same face as the letters it sits on",
     /var\(--mono\)/.test(after));

  /* "In the middle, towards the bottom": horizontally on the seam between
     the second A and the S, vertically in the lower third. */
  const top = Number((after.match(/top:(\d+)%/) || [])[1]);
  ok("it sits low in the block, not across the middle", top >= 65 && top <= 85,
     `top:${top}% — a centred X would be a strikeout again`);
  ok("...and on the horizontal centre of the word",
     /left:calc\(50% - \dpx\)/.test(after),
     "nudged off the box centre because the letter-spacing adds a trailing gap");
  const pad = (idx.match(/\.mark\{[^}]*padding:(\d+)px (\d+)px (\d+)px/s) || []);
  ok("the block is deeper below than above, to give the X room",
     Number(pad[3]) > Number(pad[1]), `${pad[1]}px above, ${pad[3]}px below`);
  ok("the dark outline is painted behind the yellow, not over it",
     /paint-order:stroke fill/.test(after),
     "without it the stroke eats into the glyph and the X goes thin");
}

console.log("\n— the icons were regenerated, not left behind —");
{
  const png = p => { const b = readFileSync(path.join(REPO, "public", p)); return b; };
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const b = png(f);
    ok(`${f} is a real PNG`, b.slice(1, 4).toString() === "PNG", `${b.length} bytes`);
    // width/height live in the IHDR chunk, bytes 16..24
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    const want = f.includes("192") ? 192 : 512;
    ok(`...${w}x${h}, as the manifest promises`, w === want && h === want, `${w}x${h}`);
  }
  /* A timestamp only proves someone touched the file. This looks for the
     mark's yellow in the actual pixels: an icon still carrying the old
     white-on-black strikeout has none of it anywhere, so forgetting to run
     `npm run icons` after changing `.mark` fails here rather than shipping
     last year's logo to everyone who installs the app. */
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await (await browser.newContext()).newPage();
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const b64 = readFileSync(path.join(REPO, "public", f)).toString("base64");
    const share = await page.evaluate(async src => {
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = src; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let hits = 0;
      for (let i = 0; i < d.length; i += 4) {
        // near #FFE24A: high red, high green, low blue
        if (d[i] > 220 && d[i + 1] > 190 && d[i + 1] < 245 && d[i + 2] < 130) hits++;
      }
      return hits / (c.width * c.height);
    }, "data:image/png;base64," + b64);
    ok(`${f} carries the mark's yellow X`, share > 0.004,
       `${(share * 100).toFixed(2)}% yellow — run \`npm run icons\` after changing .mark`);
  }
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
