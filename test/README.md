# Tests

Playwright drives a real browser against a stubbed Worker, so a run touches
no network and no OASA quota. Every tile host is intercepted.

```bash
npm install                 # pulls playwright-core
npx playwright install chromium   # or set CHROME_PATH to a Chrome you have
node test/tiles.mjs
```

`tiles.mjs` covers the basemap: CARTO with a key on all three maps in the
app, the keyless OpenStreetMap fallback with its desaturating filter, and
the three shapes people paste a key in.

These live in the repo on purpose. An earlier run of suites lived only in a
scratch directory and went with the machine.
