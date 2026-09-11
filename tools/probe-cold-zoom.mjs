/**
 * What a first zoom into a fresh area actually produces.
 *
 * "A mess when I zoom in, fine after zooming out and in a few times" points at
 * something that only goes wrong while nothing is cached, so this drives exactly
 * that: a page that has never seen the area, one zoom straight in, and a count
 * of what came back empty.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const failed = [];
page.on('requestfailed', (r) => { if (r.url().includes('radar2')) failed.push(r.url()); });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const survey = async (label) => {
  const out = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 12000));
    const tiles = [...document.querySelectorAll('canvas.windy-radar-tile')];
    let empty = 0;
    let drawn = 0;
    for (const t of tiles) {
      if (!t.width) { empty += 1; continue; }
      const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 400) if (d[i] > 8) lit += 1;
      if (lit === 0) empty += 1; else drawn += 1;
    }
    return { tiles: tiles.length, drawn, empty, pool: window.RadarLoop.tileWorkers() };
  });
  console.log(`${label}: ${JSON.stringify(out)}`);
};

await page.evaluate(() => {
  window.__radarScale.setSmoothing(true);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.setLayerEnabled('satellite', false);
});
// Straight in, no stops, to an area the page has never drawn.
await page.evaluate(() => window.RadarLoop.map().setView([50.1, 19.9], 10));
await survey('first zoom in ');

for (let i = 0; i < 3; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate(() => window.RadarLoop.map().setZoom(7));
  // eslint-disable-next-line no-await-in-loop
  await page.waitForTimeout(4000);
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate(() => window.RadarLoop.map().setZoom(10));
  // eslint-disable-next-line no-await-in-loop
  await page.waitForTimeout(4000);
}
await survey('after zooming');
console.log(`failed requests: ${failed.length}`);
await page.screenshot({ path: 'shots/cold-zoom.png' });
await browser.close();
