/**
 * Shows the decoded satellite product on the map, in both modes.
 *
 * The decode was worked out against isolated tiles; this is the check that it
 * survives contact with the layer stack — that the daylight blend lands in the
 * right place, that the alpha ramp leaves the base map legible, and that the
 * mirror copies the decoded canvas into 3D rather than the raw source.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const product = process.argv[3] || 'windy-visir';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(async (p) => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.selectProduct('satellite', p);
  window.RadarLoop.setLayerEnabled('satellite', true);
  window.RadarLoop.map().setView([54, -3], 5);
}, product);
await page.waitForTimeout(12000);
await page.screenshot({ path: `shots/sat-${product}-2d.png` });

// Zoomed out far enough to have the terminator in frame.
await page.evaluate(() => window.RadarLoop.map().setView([30, -20], 3));
await page.waitForTimeout(12000);
await page.screenshot({ path: `shots/sat-${product}-wide.png` });

console.log(JSON.stringify({
  workers: await page.evaluate(() => window.RadarLoop.tileWorkers()),
  errors: [...new Set(errors)],
}));
await browser.close();
