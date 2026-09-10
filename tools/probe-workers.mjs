/**
 * Diagnostic for the Windy tile worker pool.
 *
 * Reports whether tiles are being decoded off the main thread, what the render
 * phases cost, what resolution tiles are rendered at, and — because the colour
 * scale reaches the workers as a lookup table rather than as code — that changing
 * the palette actually changes the pixels.
 *
 * Pass a URL to point it at the bundled build, where workers start from a Blob
 * URL rather than a module URL:
 *
 *   node tools/probe-workers.mjs http://localhost:8080/dist/radarloop.html
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') errs.push(`[${m.type()}] ${m.text()}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
});
await page.waitForTimeout(9000);

console.log('tileWorkers:', JSON.stringify(await page.evaluate(() => window.RadarLoop.tileWorkers())));
console.log('phases:', JSON.stringify(await page.evaluate(() => window.RadarLoop.phases().radar)));
console.log('tiles:', JSON.stringify(await page.evaluate(() => {
  const els = [...document.querySelectorAll('canvas.windy-radar-tile')];
  return { count: els.length, backing: els[0]?.width, dpr: window.devicePixelRatio };
})));

/* A palette change has to reach the workers' lookup table, not just the legend. */
const fingerprint = () => page.evaluate(() => {
  // Sum the colour channels of a tile that has echo in it, so the number moves
  // when the scale changes but not when tiles merely re-arrive.
  for (const el of document.querySelectorAll('canvas.windy-radar-tile')) {
    const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      lit += 1;
      sum += d[i] * 7 + d[i + 1] * 11 + d[i + 2] * 13;
    }
    if (lit > 500) return { sum, lit };
  }
  return null;
});

const before = await fingerprint();

// Driven through the real control rather than a debug hook, so this also covers
// the panel wiring.
const switched = await page.evaluate(() => {
  const select = [...document.querySelectorAll('.field')]
    .find((f) => f.querySelector('.field__label')?.textContent.includes('Preset colour scheme'))
    ?.querySelector('select');
  if (!select || select.options.length < 2) return null;
  const other = [...select.options].find((o) => o.value !== select.value);
  select.value = other.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return other.value;
});

if (before && switched) {
  await page.waitForTimeout(6000);
  const after = await fingerprint();
  console.log(`palette: ${switched}  before=${before.sum} after=${after ? after.sum : 'none'}`);
  console.log(after && after.sum !== before.sum
    ? '  ok   changing the scale recoloured the tiles'
    : '  FAIL the scale change did not reach the workers');
} else {
  console.log(`palette: skipped (echo=${!!before}, control=${switched})`);
}

console.log('errors:', [...new Set(errs)].slice(0, 8));
await browser.close();
