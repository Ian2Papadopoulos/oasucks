/* Regenerate the PWA icons from the mark.
 *
 *     CHROME_PATH=/path/to/chromium node tools/icons.mjs
 *
 * The mark lives in CSS, in `public/index.html`, and that is the only
 * place it is designed. This script rebuilds the same lockup at icon
 * sizes rather than keeping a second drawing of it in an SVG somewhere —
 * two drawings of one logo drift, and the drift is invisible until
 * somebody installs the app and gets last year's icon.
 *
 * Run it whenever `.mark` changes. `test/brand.mjs` fails if you don't:
 * it reads the icons' actual pixels and looks for the strike. */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "public");

const PAPER = "#F7F7F5", TONER = "#17171A", PAPER_INK = "#F7F7F5";
const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

/* `scale` is the share of the canvas the black block spans. A launcher
 * may crop a maskable icon to a circle, so that one keeps its content
 * well inside the safe zone and lets the paper run to the edges. */
/* Every measurement is expressed against the font size, exactly as the
 * CSS does it, so the icon is the app's mark enlarged and not a second
 * design that merely resembles it. These are the `.mark` values verbatim;
 * keep them in step with the CSS. */
const EM = { pad: 0.35, padSide: 0.53, rule: 0.09, inset: 0.2, steep: 1.82 };

function page(size, scale) {
  const block = size * scale;
  // OASA is 4 mono characters at ~0.6em advance plus 0.1em tracking, so
  // the text is ~2.8em wide; the side padding makes up the rest.
  const fs = block / (2.8 + EM.padSide * 2);
  const px = n => (n * fs).toFixed(2) + "px";
  const rule = `position:absolute;top:50%;height:${px(EM.rule)};background:${PAPER_INK};`;
  return `<style>
    html,body{margin:0;width:${size}px;height:${size}px;background:${PAPER};
      display:grid;place-items:center;overflow:hidden}
    .mark{background:${TONER};color:${PAPER_INK};font-family:${MONO};font-weight:700;
      font-size:${fs.toFixed(2)}px;letter-spacing:.1em;line-height:1;position:relative;
      padding:${px(EM.pad)} ${px(EM.padSide)};text-indent:.1em}
    .mark::after{content:"";${rule}left:${px(EM.inset)};right:${px(EM.inset)};
      transform:translateY(${px(-EM.rule / 2)}) rotate(-7deg)}
    .mark::before{content:"";${rule}left:50%;width:${px(EM.steep)};
      margin-left:${px(-EM.steep / 2)};transform:translateY(${px(-EM.rule / 2)}) rotate(52deg)}
  </style><div class="mark">OASA</div>`;
}

/* At 32 pixels the four letters are a grey smudge, so the favicon is the
   half of the mark that survives the size: the black block and the two
   white rules crossing it, at the angles they cross at everywhere else.
   The strike IS the idea; the word is what a tab cannot show. */
function favicon(size) {
  const px = n => (n * size).toFixed(2) + "px";
  // fractions of the square, not of an em: at this size the only thing
  // that matters is that both strokes survive being 16 pixels wide
  const T = 0.115;                                     // stroke thickness
  const rule = `position:absolute;top:50%;height:${px(T)};background:${PAPER_INK};`;
  return `<style>
    html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}
    .fav{width:${size}px;height:${size}px;background:${TONER};position:relative}
    .fav::after{content:"";${rule}left:${px(0.08)};right:${px(0.08)};
      transform:translateY(-${px(T / 2)}) rotate(-7deg)}
    .fav::before{content:"";${rule}left:50%;width:${px(0.78)};margin-left:-${px(0.39)};
      transform:translateY(-${px(T / 2)}) rotate(52deg)}
  </style><div class="fav"></div>`;
}

/* A .ico is a 22-byte header wrapped around an image, and since Vista that
   image may be a PNG. Browsers ask for /favicon.ico by name whatever the
   markup says, so it is worth having a real one rather than a 404. */
function ico(png) {
  const h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4);   // dir: 1 image
  h.writeUInt8(32, 6); h.writeUInt8(32, 7);                              // 32x32
  h.writeUInt8(0, 8); h.writeUInt8(0, 9);
  h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12);                       // 1 plane, 32bpp
  h.writeUInt32LE(png.length, 14); h.writeUInt32LE(22, 18);
  return Buffer.concat([h, png]);
}

/* The card Facebook, Signal, WhatsApp and the rest draw when someone
   pastes the link. Without one a share is a bare blue URL, which is a poor
   showing for a launch post — and it is the same lockup as everywhere
   else, at the one size social crawlers actually want. */
function share(w, h) {
  const fs = w * 0.075;                              // the mark's font size
  const px = n => (n * fs).toFixed(2) + "px";
  const rule = `position:absolute;top:50%;height:${px(EM.rule)};background:${PAPER_INK};`;
  return `<style>
    html,body{margin:0;width:${w}px;height:${h}px;background:${PAPER};overflow:hidden;
      font-family:${MONO}}
    .wrap{width:${w}px;height:${h}px;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:${(h * 0.06).toFixed(0)}px}
    .mark{background:${TONER};color:${PAPER_INK};font-weight:700;font-size:${fs.toFixed(2)}px;
      line-height:1;letter-spacing:.1em;text-indent:.1em;position:relative;
      padding:${px(EM.pad)} ${px(EM.padSide)}}
    .mark::after{content:"";${rule}left:${px(EM.inset)};right:${px(EM.inset)};
      transform:translateY(${px(-EM.rule / 2)}) rotate(-7deg)}
    .mark::before{content:"";${rule}left:50%;width:${px(EM.steep)};
      margin-left:${px(-EM.steep / 2)};transform:translateY(${px(-EM.rule / 2)}) rotate(52deg)}
    .tag{color:${TONER};font-size:${(w * 0.026).toFixed(1)}px;font-weight:700;
      letter-spacing:.06em;text-align:center;line-height:1.6}
    .host{color:${TONER};opacity:.55;font-size:${(w * 0.019).toFixed(1)}px;
      letter-spacing:.22em;text-transform:uppercase}
  </style><div class="wrap">
    <div class="mark">OASA</div>
    <div class="tag">Ζωντανές αφίξεις σε λεωφορεία, τρόλεϊ και μετρό</div>
    <div class="host">oasax.com</div>
  </div>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [file, size, scale] of [
  /* The struck lockup is wider and shallower than the one it replaced, so
     the same width fraction left it floating in space. These are chosen so
     the block reads at launcher size, not so the numbers match history. */
  ["icon-192.png", 192, 0.90],
  ["icon-512.png", 512, 0.90],
  // 66% keeps every corner of the block inside a circular mask
  ["icon-maskable-512.png", 512, 0.66],
]) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } });
  const p = await ctx.newPage();
  await p.setContent(page(size, scale));
  await p.waitForTimeout(120);                   // let the webfont fallback settle
  const buf = await p.screenshot({ type: "png" });
  writeFileSync(path.join(OUT, file), buf);
  console.log(`${file}  ${size}x${size}  ${buf.length} bytes`);
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 32, height: 32 } });
  const p = await ctx.newPage();
  await p.setContent(favicon(32));
  await p.waitForTimeout(80);
  const png = await p.screenshot({ type: "png" });
  writeFileSync(path.join(OUT, "favicon-32.png"), png);
  writeFileSync(path.join(OUT, "favicon.ico"), ico(png));
  console.log(`favicon-32.png  32x32  ${png.length} bytes`);
  console.log(`favicon.ico     32x32  ${png.length + 22} bytes`);
  await ctx.close();
}
{
  const [w, h] = [1200, 630];                        // what every social crawler wants
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.setContent(share(w, h));
  await p.waitForTimeout(150);
  const buf = await p.screenshot({ type: "png" });
  writeFileSync(path.join(OUT, "share.png"), buf);
  console.log(`share.png       ${w}x${h}  ${buf.length} bytes`);
  await ctx.close();
}
await browser.close();
