/**
 * The day/night half of the satellite composite, and its trip into 3D.
 *
 * The visible channel is blank over the unlit hemisphere, so without the solar
 * blend the layer would lay a sheet of white over half the world. These views
 * cross the evening terminator and sit well inside the night side; the last one
 * checks the decoded canvas is what reaches the GL map.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.selectProduct('satellite', 'windy-visir');
  window.RadarLoop.setLayerEnabled('satellite', true);
});

// The evening terminator, then deep in the dark.
const sub = 15 * (12 - (new Date().getUTCHours() + new Date().getUTCMinutes() / 60));
for (const [name, lon] of [['terminator', sub + 90], ['night', sub + 150]]) {
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate((l) => window.RadarLoop.map().setView([25, ((l + 540) % 360) - 180], 4), lon);
  // eslint-disable-next-line no-await-in-loop
  await page.waitForTimeout(11000);
  // eslint-disable-next-line no-await-in-loop
  await page.screenshot({ path: `shots/sat-${name}.png` });
}

await page.evaluate(() => window.RadarLoop.map().setView([52, -2], 5));
await page.waitForTimeout(9000);
await page.click('#btn-3d');
await page.waitForTimeout(16000);
await page.screenshot({ path: 'shots/sat-3d.png' });

console.log(JSON.stringify({
  mirror: await page.evaluate(() => window.RadarLoop.mirrorKind('satellite')),
  workers: await page.evaluate(() => window.RadarLoop.tileWorkers()),
  errors: [...new Set(errors)],
}));
await browser.close();
