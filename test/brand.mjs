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

console.log("\n— one mark, struck through, wherever it appears —");
{
  const idx = read("public/index.html");
  ok("the wordmark reads OASA + x",
     /<span class="w-oasa">OASA<\/span><span class="w-x">x<\/span>/.test(idx));
  ok("...with the two-line pun stack gone", !/<span>O A<\/span>/.test(idx));

  /* There was a second mark for a while — a yellow X stamped on the name,
     worn by the icon and the header while the splash kept the original
     strike. Two drawings of one logo drift, and this one drifted straight
     into the launcher. Now there is one: the black-and-white strike, and
     everything that shows a mark shows that. */
  const before = (idx.match(/\.mark::before\{[^}]*\}/s) || [""])[0];
  const after = (idx.match(/(?:^|\n)\s*\.mark::after\{[^}]*\}/s) || [""])[0];
  ok("the mark is struck by two rules, not stamped with a glyph",
     /rotate\(-7deg\)/.test(after) && /rotate\(52deg\)/.test(before),
     "the skew is the joke; a clean X would read as a logo");
  ok("...and they cross off-square, at different angles",
     !/rotate\(-?7deg\)/.test(before));
  ok("no X glyph is left anywhere in the mark", !/content:"X"/.test(idx),
     "the yellow stamp is gone, not merely covered up");
  ok("...and no colour either — black and white is the whole design",
     !/\.mark::(before|after)\{[^}]*var\(--marker\)/s.test(idx));
  ok("the splash no longer redraws the mark, it only resizes it",
     !/\.splash \.mark::(before|after)/.test(idx),
     "a second drawing scoped to one screen is how the drift started");

  /* Sized in em, so one rule set draws the splash at 34px, the tour card
     at 17px and the icon at whatever the generator asks for. A px here
     would look right in exactly one of those places. */
  for (const [what, css] of [["the long rule", after], ["the steep one", before]]) {
    ok(`${what} is measured in em, so it scales with the block`,
       !/:\s*-?[\d.]+px/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), css.slice(0, 70));
  }
  const mark = (idx.match(/(?:^|\n)\s*\.mark\{[^}]*\}/s) || [""])[0];
  ok("the block's height is pinned, or the icon cannot reproduce it",
     /line-height:1/.test(mark), mark.slice(0, 80));
  ok("...and the trailing tracking is given back, so the word sits centred",
     /text-indent:\.1em/.test(mark));

  /* The generator draws from these numbers; the CSS is the design. If the
     two disagree the launcher gets a logo nobody approved. */
  const gen = read("tools/icons.mjs");
  for (const n of ["0.09", "0.2", "1.82", "0.35", "0.53"]) {
    ok(`the icon generator uses the CSS value ${n}em`, gen.includes(n), n);
  }
  ok("...and no longer knows what yellow is", !/MARKER|FFE24A/.test(gen));
}

/* A browser asks for /favicon.ico by name whatever the markup says. With
   nothing there every desktop tab took a 404 and showed a blank page icon
   — which is how it turned up: as two 404s per visit in the live log. */
console.log("\n— the tab has an icon —");
{
  const idx = read("public/index.html");
  ok("the page declares one", /<link rel="icon"[^>]*favicon\.ico/.test(idx));
  ok("...and a PNG beside it, which is what modern browsers prefer",
    /<link rel="icon" type="image\/png"[^>]*favicon-32\.png/.test(idx));
  const png = readFileSync(path.join(REPO, "public", "favicon-32.png"));
  ok("favicon-32.png is a real PNG", png.slice(1, 4).toString() === "PNG",
    `${png.length} bytes`);
  ok("...32x32, as the link says", png.readUInt32BE(16) === 32 && png.readUInt32BE(20) === 32);
  const ico = readFileSync(path.join(REPO, "public", "favicon.ico"));
  ok("favicon.ico is a real ICO", ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1
    && ico.readUInt16LE(4) === 1, ico.slice(0, 6).toString("hex"));
  ok("...declaring one 32x32 image", ico.readUInt8(6) === 32 && ico.readUInt8(7) === 32);
  ok("...whose payload is the PNG, at the offset the header promises",
    ico.readUInt32LE(18) === 22 && ico.slice(23, 26).toString() === "PNG",
    "since Vista an .ico may carry a PNG, which is the only sane way to write one");
  ok("...and the two agree byte for byte",
    ico.length === png.length + 22 && ico.slice(22).equals(png),
    "one drawing, wrapped twice");
  const gen = read("tools/icons.mjs");
  ok("both come out of `npm run icons` with everything else",
    /favicon-32\.png/.test(gen) && /favicon\.ico/.test(gen),
    "a logo maintained in two places drifts");
}

/* A pasted link becomes a card. With no card it becomes a blue URL, which
   is a poor showing for the post that launches the thing. */
console.log("\n— a shared link has a picture —");
{
  const idx = read("public/index.html");
  for (const [what, re] of [
    ["a description for search results", /<meta name="description" content="[^"]{60,}"/],
    ["a title for the card", /og:title" content="[^"]{10,}"/],
    ["a description for the card", /og:description" content="[^"]{40,}"/],
    ["an image", /og:image" content="[^"]+share\.png"/],
    ["...with its dimensions declared, so no crawler has to guess",
      /og:image:width" content="1200"/],
    ["a large-image card for the ones that read twitter tags",
      /twitter:card" content="summary_large_image"/],
  ]) ok(what, re.test(idx));
  const png = readFileSync(path.join(REPO, "public", "share.png"));
  ok("share.png is a real PNG", png.slice(1, 4).toString() === "PNG", `${png.length} bytes`);
  ok("...1200x630, the size every crawler asks for",
    png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630,
    `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  ok("...and under the 5MB most of them will fetch", png.length < 5e6);
  ok("it is built by `npm run icons` like every other image",
    /share\.png/.test(read("tools/icons.mjs")));
  const robots = read("public/robots.txt");
  ok("robots.txt lets the app be found", /^Allow: \/$/m.test(robots));
  ok("...and keeps crawlers out of the API, which would only burn requests",
    /^Disallow: \/api$/m.test(robots) && /^Disallow: \/nearby$/m.test(robots));
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
  /* A timestamp only proves someone touched the file. This reads the
     actual pixels: an icon left over from the yellow-X era still has that
     yellow in it, and one rendered from a stale lockup has the wrong
     proportions. Forgetting `npm run icons` after changing `.mark` fails
     here rather than shipping last year's logo to everyone who installs. */
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await (await browser.newContext()).newPage();
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const b64 = readFileSync(path.join(REPO, "public", f)).toString("base64");
    const m = await page.evaluate(async src => {
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = src; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      const dark = p => p[0] < 60 && p[1] < 60 && p[2] < 70;
      const pale = p => p[0] > 225 && p[1] > 225 && p[2] > 225;
      let yellow = 0, x0 = c.width, x1 = -1, y0 = c.height, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const p = at(x, y);
        if (p[0] > 220 && p[1] > 190 && p[1] < 245 && p[2] < 130) yellow++;
        if (dark(p)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      // white ink — letters and the two rules — inside the black block
      let ink = 0, cells = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        cells++; if (pale(at(x, y))) ink++;
      }
      return { yellow: yellow / (c.width * c.height), ink: ink / Math.max(1, cells),
               w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }, "data:image/png;base64," + b64);
    /* An icon drawn with the yellow X measured over 0.4% of its pixels;
       what is left here is a few antialiased edges reading warm. */
    ok(`${f} has no yellow left in it`, m.yellow < 0.002,
       `${(m.yellow * 100).toFixed(2)}% — run \`npm run icons\` after changing .mark`);
    /* The struck lockup is 3.86em wide by 1.7em tall. The stamped one it
       replaced was 3.5 by 2.25, so the ratio alone tells the two apart. */
    ok(`...and the block has the struck lockup's proportions`,
       Math.abs(m.w / m.h - 2.27) < 0.3, `${(m.w / m.h).toFixed(2)} wide-to-tall, want ~2.27`);
    ok(`...with the word and the strike actually drawn on it`,
       m.ink > 0.1 && m.ink < 0.45, `${(m.ink * 100).toFixed(1)}% white ink in the block`);
  }
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
