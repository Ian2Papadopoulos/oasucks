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
await browser.close();
