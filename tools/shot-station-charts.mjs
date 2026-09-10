/**
 * Every chart the picker offers, one screenshot each.
 *
 * The station card now shows one chart at a time, so the only way to see that
 * the wind arrows, the rainfall bars and the accumulations all render is to walk
 * the menu. A US station is used because it reports rain where most UK airfields
 * report only the hourly figure.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const [, , centre = '39.87,-75.24', zoom = '9'] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

const [lat, lon] = centre.split(',').map(Number);
await page.evaluate(([la, lo, z]) => window.RadarLoop.map().setView([la, lo], z), [lat, lon, Number(zoom)]);
await page.waitForTimeout(6000);
const opened = await page.evaluate(() => window.RadarLoop.openNearestStation());
await page.waitForTimeout(6000);

const titles = await page.evaluate(() => [...document.querySelectorAll('.wxcard__pick option')].map((o) => o.textContent));
console.log(JSON.stringify({ opened, titles }, null, 1));

for (let i = 0; i < titles.length; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.selectOption('.wxcard__pick', String(i));
  // eslint-disable-next-line no-await-in-loop
  await page.waitForTimeout(500);
  const slug = titles[i].toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const box = await page.locator('.wxcard').boundingBox();
  // eslint-disable-next-line no-await-in-loop
  await page.screenshot({ path: `shots/card-${slug}.png`, clip: box });
}

// And the crosshair, on whichever chart is showing.
await page.selectOption('.wxcard__pick', '1');
await page.waitForTimeout(300);
const svg = await page.locator('.wxcard__panels svg').boundingBox();
await page.mouse.move(svg.x + svg.width * 0.6, svg.y + svg.height * 0.4);
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/card-crosshair.png', clip: await page.locator('.wxcard').boundingBox() });

console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
