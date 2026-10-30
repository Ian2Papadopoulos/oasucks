/* Every OASA stop, by name, for the app to search on the phone.
 *
 *     node tools/build-stop-index.mjs <osy_gtfs.zip | stops.txt>
 *
 * The input is OASA's own GTFS for buses and trolleys, published on
 * data.gov.gr (the "Road Transport Routes" feed). Its timetable is not
 * used and does not need to be current — OASA's has been seen expired for
 * weeks — because only the stops are read: their codes, which are the
 * same codes the live arrivals API takes, their names and positions.
 *
 * Why the app needs this at all: a stop could only be found by name if it
 * was already on the board around you, or if a geocoder happened to know a
 * PLACE by that name. "14η ΝΤΑΜΑΡΙΑ" or "ΤΖΙΤΖΙΦΙΕΣ" across town could not
 * be found anywhere in the app. With this file the search runs on the
 * phone and costs no request per letter typed.
 *
 * Writes public/stops-index.json, and puts the new file's hash into
 * STOP_INDEX_URL in public/index.html: browsers keep the file for a week,
 * so a rebuilt index only reaches them under a new URL. No dependencies:
 * the zip is read with a twenty-line reader over node:zlib.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "public", "stops-index.json");
const APP = path.join(REPO, "public", "index.html");
const URL_RE = /(const STOP_INDEX_URL=")[^"]*(")/;

/* What the app should ask for: the file's own hash, so the URL changes
   exactly when the content does. test/search.mjs holds the two together. */
export const indexUrl = body => `./stops-index.json?v=${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;

/* The one file wanted out of a zip: find the central directory from its
   end record, walk it to the entry, inflate the data behind its header. */
export function readZipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (entry === name || entry.endsWith("/" + name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported compression ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${name} not in the zip`);
}

/* GTFS is CSV with quoting; stop names do contain commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function buildIndex(stopsTxt) {
  const [head, ...rows] = parseCsv(stopsTxt.replace(/^\uFEFF/, ""));
  const col = n => head.indexOf(n);
  const [ci, cn, cla, clo] = ["stop_id", "stop_name", "stop_lat", "stop_lon"].map(col);
  if ([ci, cn, cla, clo].some(x => x < 0)) throw new Error("stops.txt is missing a column");
  const stops = [];
  for (const r of rows) {
    const lat = Number(r[cla]), lng = Number(r[clo]);
    const name = String(r[cn] || "").replace(/\s+/g, " ").trim();
    // the box is Attica's, generously: anything outside it is a data error
    if (!/^\d+$/.test(r[ci]) || !name || !(lat > 37.5 && lat < 38.6 && lng > 22.9 && lng < 24.4)) continue;
    stops.push([String(r[ci]), name, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
  }
  stops.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  return stops;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const src = process.argv[2];
  if (!src) { console.error("usage: node tools/build-stop-index.mjs <osy_gtfs.zip | stops.txt>"); process.exit(1); }
  const buf = readFileSync(src);
  const text = /\.zip$/i.test(src) ? readZipEntry(buf, "stops.txt").toString("utf8") : buf.toString("utf8");
  const stops = buildIndex(text);
  const body = JSON.stringify({ v: 1, built: new Date().toISOString().slice(0, 10), source: path.basename(src), stops });
  const html = readFileSync(APP, "utf8");
  if (!URL_RE.test(html)) { console.error("STOP_INDEX_URL not found in public/index.html"); process.exit(1); }
  writeFileSync(OUT, body);
  writeFileSync(APP, html.replace(URL_RE, `$1${indexUrl(body)}$2`));
  console.log(`${stops.length} stops → ${path.relative(REPO, OUT)} (${Math.round(body.length / 1024)} KB), `
    + `app now asks for ${indexUrl(body)}`);
}
