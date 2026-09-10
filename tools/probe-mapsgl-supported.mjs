/**
 * Which documented MapsGL layers this SDK build and account actually accept.
 *
 * The docs list what exists; this asks the controller. `addWeatherLayer` looks
 * the id up in the SDK's own configuration, so an unknown or unlicensed id fails
 * immediately and cheaply — no tiles are fetched — which makes trying the whole
 * list practical.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';

const ids = JSON.parse(readFileSync(process.argv[3] || 'mapsgl-ids.json', 'utf8'));
const url = process.argv[2] || 'http://localhost:8080/index.html';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

// Bring the controller up once.
await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-density'));
await page.waitForTimeout(8000);
// The layer stays on: switching it off releases the controller, and the probe
// needs it alive.

const result = await page.evaluate(async (list) => {
  const ctrl = window.__mapsglController;
  if (!ctrl) return { error: 'no controller' };
  const ok = [];
  const bad = {};
  for (const id of list) {
    try {
      ctrl.addWeatherLayer(id);
      ok.push(id);
      try { ctrl.removeWeatherLayer(id); } catch { /* nothing to remove */ }
    } catch (error) {
      bad[id] = String(error?.message || error).slice(0, 90);
    }
  }
  return { ok, bad };
}, ids);

if (result.error) {
  console.log(result.error);
} else {
  console.log(`accepted: ${result.ok.length} of ${ids.length}`);
  const reasons = {};
  for (const [id, why] of Object.entries(result.bad)) (reasons[why] ||= []).push(id);
  for (const [why, list] of Object.entries(reasons)) {
    console.log(`\nrejected (${list.length}): ${why}`);
    console.log('  ' + list.slice(0, 12).join(', ') + (list.length > 12 ? ' …' : ''));
  }
  writeFileSync('mapsgl-supported.json', JSON.stringify(result.ok, null, 2));
  console.log('\nwritten to mapsgl-supported.json');
}
await browser.close();
