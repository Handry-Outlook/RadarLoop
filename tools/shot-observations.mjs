/** A look at the station plot, at two zooms. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.map().setView([40.6, -76.0], 7, { animate: false });
  window.RadarLoop.setLayerEnabled('observations', true);
});
await page.waitForTimeout(12000);
await page.screenshot({ path: 'shots/observations-z7.png' });
await page.evaluate(() => window.RadarLoop.map().setView([40.0, -75.4], 9, { animate: false }));
await page.waitForTimeout(9000);
await page.screenshot({ path: 'shots/observations-z9.png' });
console.log('written shots/observations-z7.png and shots/observations-z9.png');
console.log(JSON.stringify(await page.evaluate(() => window.RadarLoop.observations())));
await browser.close();
