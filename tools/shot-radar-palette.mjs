/** The radar composite on real rain, for judging the scale by eye. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.setLayerEnabled('lightning', false);
  window.RadarLoop.lightning.nowcast = false;
  window.RadarLoop.lightning.showLayer = false;
  window.RadarLoop.observations().enabled = false;
  window.RadarLoop.setLayerEnabled('observations', false);
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.setLayerEnabled('radar', true);
  window.RadarLoop.setBasemap('mapbox-light');
});
await page.waitForTimeout(6000);

// Somewhere with real convection right now.
const where = process.argv[2] ? process.argv[2].split(',').map(Number) : [3.5, 12];
await page.evaluate(([lat, lon, z]) => window.RadarLoop.map().setView([lat, lon], z),
  [where[0], where[1], where[2] || 6]);
await page.waitForTimeout(12000);
await page.screenshot({ path: `shots/radar-palette-${process.argv[3] || 'new'}.png` });
console.log(`written shots/radar-palette-${process.argv[3] || 'new'}.png`);
await browser.close();
