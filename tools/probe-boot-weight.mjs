/** What the third-party scripts cost at boot, and which are needed for first paint. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

const scripts = [];
page.on('response', async (r) => {
  const type = r.request().resourceType();
  if (type !== 'script' && type !== 'stylesheet') return;
  let bytes = 0;
  try { bytes = (await r.body()).length; } catch { /* from cache */ }
  scripts.push({ name: r.url().split('/').pop().split('?')[0].slice(0, 42), type, bytes, url: r.url() });
});

const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('.rail__btn', { timeout: 40000 });
const shell = Date.now() - t0;
await page.waitForTimeout(3000);

const thirdParty = scripts.filter((s) => !s.url.includes('localhost'));
const local = scripts.filter((s) => s.url.includes('localhost'));
const total = thirdParty.reduce((n, s) => n + s.bytes, 0);

console.log(`shell ready in ${shell} ms`);
console.log(`\nthird-party assets: ${thirdParty.length}, ${(total / 1024).toFixed(0)} KB`);
for (const s of thirdParty.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${String((s.bytes / 1024).toFixed(0)).padStart(6)} KB  ${s.type.padEnd(10)} ${s.name}`);
}
console.log(`\nlocal modules: ${local.length}, ${(local.reduce((n, s) => n + s.bytes, 0) / 1024).toFixed(0)} KB`);

// Which globals does the shell actually need before anything is drawn?
const used = await page.evaluate(() => ({
  L: typeof L,
  proj4: typeof proj4,
  turf: typeof turf,
  toGeoJSON: typeof toGeoJSON,
  mapboxgl: typeof mapboxgl,
  maptilersdk: typeof maptilersdk,
  aerisweather: typeof aerisweather,
  firebase: typeof firebase,
  drawUsed: !!(window.L && L.Control && L.Control.Draw),
  heatUsed: !!(window.L && L.heatLayer),
  vectorGrid: !!(window.L && L.vectorGrid),
  esri: !!(window.L && L.esri),
}));
console.log('\nglobals present after boot:', JSON.stringify(used, null, 2));
await browser.close();
