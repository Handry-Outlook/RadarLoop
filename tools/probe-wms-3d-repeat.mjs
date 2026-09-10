/** EUMETSAT time-to-visible in 3D, repeated, because the service is very variable. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const runs = Number(process.env.RUNS || 3);
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

const times = [];
for (let i = 0; i < runs; i += 1) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(11000);
  await page.evaluate(() => {
    for (const [g] of window.RadarLoop.slots) window.RadarLoop.setLayerEnabled(g, false);
  });
  await page.waitForTimeout(1200);
  await page.click('#btn-3d');
  await page.waitForTimeout(15000);

  const t0 = Date.now();
  await page.evaluate(() => window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor'));
  let visible = -1;
  for (let k = 0; k < 120; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await page.evaluate(() => {
      const gl = window.RadarLoop.gl?.();
      try { return !!gl && gl.isSourceLoaded('wx-satellite-src'); } catch { return false; }
    });
    if (ok) { visible = Date.now() - t0; break; }
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
  }
  times.push(visible);
  console.log(`  run ${i + 1}: visible in ${visible} ms`);
  await context.close();
}

const good = times.filter((t) => t > 0).sort((a, b) => a - b);
console.log(`  median ${good.length ? good[Math.floor(good.length / 2)] : 'n/a'} ms  (${times.join(', ')})`);
await browser.close();
