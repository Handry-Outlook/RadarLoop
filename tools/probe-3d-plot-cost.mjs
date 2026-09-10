/**
 * How long a layer takes to appear in 3D against 2D, and what it costs.
 *
 * A tile product is handed to GL as its own raster source, so the tiles are
 * fetched a second time by Mapbox rather than reused from the Leaflet layer
 * that already has them. For the EUMETSAT WMS the second set is not even the
 * same request: the template is rewritten from EPSG:4326 to EPSG:3857, so every
 * tile GL asks for is a fresh GeoServer render that nothing has cached.
 *
 * A fresh context per run, because a warmed HTTP cache hides exactly the cost
 * being measured.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

const PRODUCTS = [
  ['satellite', 'eumetsat-geocolor', 'EUMETSAT WMS'],
  ['satellite', 'satellite', 'Satellite (plain tiles)'],
  ['radar', 'radar-global', 'Radar (plain tiles)'],
];

async function run({ group, type, label, mode }) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  const hosts = new Map();
  page.on('request', (r) => {
    if (r.resourceType() !== 'image') return;
    const host = new URL(r.url()).host;
    hosts.set(host, (hosts.get(host) || 0) + 1);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(11000);
  await page.evaluate(() => {
    for (const [g] of window.RadarLoop.slots) window.RadarLoop.setLayerEnabled(g, false);
  });
  await page.waitForTimeout(1500);

  if (mode === '3D') {
    await page.click('#btn-3d');
    await page.waitForTimeout(15000);
  }

  hosts.clear();
  const t0 = Date.now();
  await page.evaluate(({ g, t }) => window.RadarLoop.selectProduct(g, t), { g: group, t: type });

  // Time to the first pixels: the 2D layer committing, and in 3D the GL source
  // having actually rendered something.
  let committed = null;
  let painted = null;
  for (let i = 0; i < 90; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const state = await page.evaluate((g) => {
      const slot = window.RadarLoop.slots.get(g);
      const gl = window.RadarLoop.gl?.();
      let glPainted = false;
      if (gl) {
        try {
          glPainted = gl.isSourceLoaded(`wx-${g}-src`);
        } catch { glPainted = false; }
      }
      return { committed: !!slot.front, glPainted };
    }, group);
    if (state.committed && committed === null) committed = Date.now() - t0;
    if (mode === '2D' && committed !== null) { painted = committed; break; }
    if (mode === '3D' && state.glPainted && committed !== null) { painted = Date.now() - t0; break; }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
  }

  const total = [...hosts.values()].reduce((n, v) => n + v, 0);
  const busiest = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([h, n]) => `${h.replace(/^([^.]*\.){0,1}/, '')} ${n}`).join(', ');

  console.log(
    `  ${label.padEnd(24)} ${mode}  2D layer ${String(committed ?? -1).padStart(5)}ms  `
    + `visible ${String(painted ?? -1).padStart(5)}ms  ${String(total).padStart(4)} image requests  [${busiest}]`,
  );
  await context.close();
  return { committed, painted, total };
}

console.log('\n=== time to plot, cold cache each run ===');
for (const [group, type, label] of PRODUCTS) {
  const flat = await run({ group, type, label, mode: '2D' });
  const solid = await run({ group, type, label, mode: '3D' });
  const ratio = flat.total ? (solid.total / flat.total).toFixed(1) : '?';
  console.log(`  ${''.padEnd(24)}      -> 3D fetched ${ratio}x the images of 2D\n`);
}

await browser.close();
