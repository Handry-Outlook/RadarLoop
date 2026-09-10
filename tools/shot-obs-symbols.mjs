/**
 * The present-weather symbol on the station plots.
 *
 * It goes where the notation puts it — left of the sky circle, between the
 * temperature and the dew point — so this is also the check that it does not sit
 * on top of either of them.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.map().setView([53.2, -2.0], 7);
});
await page.waitForTimeout(8000);

const report = await page.evaluate(() => {
  const seen = new Map();
  for (const s of window.RadarLoop.plottedStations()) {
    if (s.weather) seen.set(s.weather, (seen.get(s.weather) || 0) + 1);
  }
  return { reporting: [...seen], ...window.RadarLoop.observations() };
});
console.log(JSON.stringify(report, null, 1));
await page.screenshot({ path: 'shots/obs-symbols.png', clip: { x: 420, y: 100, width: 700, height: 600 } });
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
