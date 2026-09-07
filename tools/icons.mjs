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
 * it looks for the mark's yellow in the icons' actual pixels. */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "public");

const PAPER = "#F7F7F5", TONER = "#17171A", PAPER_INK = "#F7F7F5", MARKER = "#FFE24A";
const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';

/* `scale` is the share of the canvas the black block spans. A launcher
 * may crop a maskable icon to a circle, so that one keeps its content
 * well inside the safe zone and lets the paper run to the edges. */
/* Every measurement is expressed against the font size, exactly as the
 * header does it, so the icon is the header mark enlarged and not a
 * second design that merely resembles it. In `.mark` those work out as:
 * 12px text, 5px above, 10px below, a 19px X centred at 74% of the box —
 * i.e. 0.42em, 0.83em, 1.58em. Keep these in step with the CSS. */
const EM = { padTop: 0.42, padBottom: 0.83, padSide: 0.35, x: 1.58, xTop: 0.74, nudge: 0.16 };

function page(size, scale) {
  const block = size * scale;
  // OASA is 4 mono characters at ~0.6em advance plus 0.1em tracking, so
  // the text is ~2.8em wide; the side padding makes up the rest.
  const fs = block / (2.8 + EM.padSide * 2);
  const px = n => (n * fs).toFixed(2) + "px";
  return `<style>
    html,body{margin:0;width:${size}px;height:${size}px;background:${PAPER};
      display:grid;place-items:center;overflow:hidden}
    .mark{background:${TONER};color:${PAPER_INK};font-family:${MONO};font-weight:700;
      font-size:${fs.toFixed(2)}px;letter-spacing:.1em;line-height:1;position:relative;
      padding:${px(EM.padTop)} ${px(EM.padSide)} ${px(EM.padBottom)};
      text-indent:.1em}
    .mark::after{content:"X";position:absolute;left:calc(50% - ${px(EM.nudge)});
      top:${EM.xTop * 100}%;transform:translate(-50%,-50%);
      font:700 ${px(EM.x)}/1 ${MONO};letter-spacing:0;color:${MARKER};
      -webkit-text-stroke:${(EM.x * fs * 0.13).toFixed(2)}px ${TONER};
      paint-order:stroke fill}
  </style><div class="mark">OASA</div>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [file, size, scale] of [
  ["icon-192.png", 192, 0.84],
  ["icon-512.png", 512, 0.84],
  // 62% keeps every corner of the block inside a circular mask
  ["icon-maskable-512.png", 512, 0.62],
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
await browser.close();
