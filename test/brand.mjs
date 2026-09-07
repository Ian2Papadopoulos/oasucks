/* The app is OASAx. The old name was a pun that no longer applies, and it
   used to be spread across the page title, the manifest, the push fallback
   and the About copy — so this asserts it is gone from all of them rather
   than from whichever one someone remembered to check.
   The old name is assembled at runtime rather than written out, so this
   file does not trip its own search. */
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  ok("the mark keeps its original strike",
     /\.mark::after\{[^}]*rotate\(-7deg\)/s.test(idx));
  ok("...and gains a second, shorter stroke that crosses it",
     /\.mark::before\{[^}]*rotate\(52deg\)/s.test(idx));
  const after = idx.match(/\.mark::after\{[^}]*\}/s)[0];
  const before = idx.match(/\.mark::before\{[^}]*\}/s)[0];
  ok("...which is genuinely shorter, or it would not read as an x",
     /left:3px;right:3px/.test(after) && /width:22px/.test(before));
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
  const newer = ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]
    .map(f => statSync(path.join(REPO, "public", f)).mtimeMs);
  const idxTime = statSync(path.join(REPO, "public", "index.html")).mtimeMs;
  ok("they are not older than the rebrand itself",
     newer.every(t => t > idxTime - 7 * 86400e3), "regenerate them if this fails");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
