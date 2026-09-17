/* Cloudflare zone analytics, as a table you can paste into a conversation.
 *
 *     CF_ANALYTICS_TOKEN=... CF_ZONE_ID=... node tools/metrics.mjs [days]
 *
 * On Windows PowerShell:
 *     $env:CF_ANALYTICS_TOKEN="..."; $env:CF_ZONE_ID="..."; node tools/metrics.mjs 30
 *
 * Why this exists: the dashboard draws a pretty graph and gives you no
 * numbers, so "is that spike real users or a scanner" cannot be answered by
 * looking at it. This prints the numbers, including Cloudflare's own unique
 * visitor estimate — which is the closest thing to a userbase figure that
 * exists without tracking anybody.
 *
 * It reads nothing and changes nothing. The token needs Zone → Analytics →
 * Read and nothing else.
 */
/* Not CF_API_TOKEN: wrangler reads that name to authenticate, and an
   Analytics-only token in it breaks `npx wrangler deploy`. */
const TOKEN = process.env.CF_ANALYTICS_TOKEN || process.env.CF_API_TOKEN;
const ZONE = process.env.CF_ZONE_ID;
const DAYS = Math.min(90, Math.max(1, Number(process.argv[2]) || 30));

if (!TOKEN || !ZONE) {
  console.error("Set CF_ANALYTICS_TOKEN and CF_ZONE_ID. See DEPLOY.md → Reading the numbers.");
  process.exit(1);
}

const day = ms => new Date(ms).toISOString().slice(0, 10);
const until = day(Date.now());
const since = day(Date.now() - (DAYS - 1) * 86400e3);

/* httpRequests1dGroups is the daily rollup every plan gets, free included.
   `uniques` is Cloudflare's own visitor estimate, computed at the edge from
   addresses — no cookie, no script, nothing stored by us. It over-counts a
   phone that moves between wifi and mobile data and under-counts a whole
   household behind one address, so read it as a shape rather than a count. */
const query = `
  query ($zone: String!, $since: Date!, $until: Date!) {
    viewer {
      zones(filter: { zoneTag: $zone }) {
        httpRequests1dGroups(
          limit: 100
          filter: { date_geq: $since, date_leq: $until }
          orderBy: [date_ASC]
        ) {
          dimensions { date }
          sum { requests cachedRequests bytes threats }
          uniq { uniques }
        }
      }
    }
  }`;

const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { zone: ZONE, since, until } }),
});

const body = await res.json().catch(() => null);
if (!res.ok || !body) {
  console.error(`HTTP ${res.status}. Nothing usable came back.`);
  process.exit(1);
}
if (body.errors && body.errors.length) {
  // the usual cause is a token without Zone → Analytics → Read
  console.error("Cloudflare said no:");
  for (const e of body.errors) console.error("  -", e.message);
  process.exit(1);
}

const rows = body?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
if (!rows.length) {
  console.error("No rows. Check the zone id, and that the range is inside your plan's retention.");
  process.exit(1);
}

const n = x => String(x).padStart(9);
console.log(`\nZone ${ZONE}   ${since} → ${until}\n`);
console.log("date          requests     cached   uniques    threats   cache%");
console.log("-".repeat(68));
let tR = 0, tC = 0, tU = 0, tT = 0;
for (const r of rows) {
  const req = r.sum.requests, cac = r.sum.cachedRequests;
  const uni = r.uniq.uniques, thr = r.sum.threats;
  tR += req; tC += cac; tU += uni; tT += thr;
  const pct = req ? Math.round((cac / req) * 100) : 0;
  console.log(`${r.dimensions.date}  ${n(req)}  ${n(cac)}  ${n(uni)}  ${n(thr)}  ${String(pct).padStart(6)}%`);
}
console.log("-".repeat(68));
console.log(`total        ${n(tR)}  ${n(tC)}  ${n(tU)}  ${n(tT)}`);
console.log(`\n${rows.length} days. Mean ${Math.round(tR / rows.length)} requests/day, `
  + `${Math.round(tU / rows.length)} unique visitors/day.`);
console.log(
  "\nReading it: a flat baseline with isolated tall days is bots, not people —"
  + "\nreal users make a diffuse curve with commute peaks. `threats` is what"
  + "\nCloudflare blocked outright. A low cache% on a day with a spike means"
  + "\nsomething was asking for paths that do not exist, which is the signature"
  + "\nof a scanner walking a list.\n");
