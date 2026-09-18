/* Finding a browser to drive, without downloading one.
 *
 * playwright-core ships no browsers on purpose — that is the difference
 * between it and `playwright`, and it is why the repo's install is small.
 * The cost is that `chromium.launch()` fails on a fresh machine with a
 * message telling you to run `npx playwright install`, which downloads a
 * second Chromium next to the one already sitting in Program Files.
 *
 * So: use CHROME_PATH if it is set, otherwise look where a browser
 * actually lives on this platform, and only then give up — with the two
 * ways out rather than one.
 */
import { existsSync } from "node:fs";

const CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ],
};

export function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CANDIDATES[process.platform] || []) if (p && existsSync(p)) return p;
  return null;
}

/* The message a fresh machine should get instead of a stack trace. */
export function noBrowserHelp() {
  const eg = process.platform === "win32"
    ? '$env:CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
    : 'export CHROME_PATH=/usr/bin/chromium';
  return "\nNo browser found to drive.\n\n"
    + "  Point at one you already have:\n"
    + `      ${eg}\n\n`
    + "  Or let Playwright fetch its own (a second Chromium, ~150MB):\n"
    + "      npx playwright install chromium\n";
}

/* For the callers that cannot usefully continue without one. Throws with
   the help text rather than letting Playwright's own message send someone
   to download a browser they already have. */
export function mustFindBrowser() {
  const exe = findBrowser();
  if (exe) return exe;
  console.error(noBrowserHelp());
  process.exit(2);
}
