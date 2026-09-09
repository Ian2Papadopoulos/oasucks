/* The value the app writes to localStorage once the first-run carousel has
   been seen.

   It carries the tour's version, not a bare "1", so that bumping the cards
   shows them once more to people who already saw the old set. Suites that
   only want the carousel out of the way read it from the source here
   instead of hard-coding it, or a bump would silently un-skip the tour in
   six files at once and every one of them would fail on a modal nobody
   asked for. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const m = /TOUR_VER\s*=\s*"([^"]+)"/.exec(src);
if (!m) throw new Error("TOUR_VER not found in public/index.html");

export const TOUR_FLAG = m[1];
