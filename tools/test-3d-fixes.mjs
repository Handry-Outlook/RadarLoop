/**
 * The two reported 3D issues:
 *   - the coastline / labels overlay is present in 3D
 *   - the recoloured Global High Resolution radar follows the time scrubber
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(6000);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

/* ---------------- coastline ---------------- */
console.log('\n=== coastline overlay in 3D ===');
const ref = await page.evaluate(() => {
  const gl = window.RadarLoop.gl?.();
  const style = gl?.getStyle?.();
  const layers = (style?.layers || []).map((l) => l.id);
  const refIndex = layers.indexOf('wx-reference');
  const radarIndex = layers.indexOf('wx-radar');
  return {
    hasSource: !!style?.sources?.['wx-reference-src'],
    hasLayer: refIndex >= 0,
    tileSize: style?.sources?.['wx-reference-src']?.tileSize ?? null,
    aboveRadar: refIndex >= 0 && radarIndex >= 0 ? refIndex > radarIndex : null,
  };
});
console.log(`  ${JSON.stringify(ref)}`);
ok('the coastline source exists in 3D', ref.hasSource);
ok('the coastline layer exists in 3D', ref.hasLayer);
ok('it uses 512px tiles', ref.tileSize === 512, `tileSize=${ref.tileSize}`);
ok('it draws above the weather', ref.aboveRadar !== false, `aboveRadar=${ref.aboveRadar}`);

/* ---------------- 2D map stays laid out ---------------- */
console.log('\n=== the 2D map stays laid out in 3D ===');
const layout = await page.evaluate(() => {
  const m = document.getElementById('map');
  const cs = getComputedStyle(m);
  return { display: cs.display, visibility: cs.visibility, w: m.clientWidth, h: m.clientHeight };
});
console.log(`  ${JSON.stringify(layout)}`);
ok('the 2D map is not display:none', layout.display !== 'none', layout.display);
ok('the 2D map keeps its size (so captures work)', layout.w > 0 && layout.h > 0,
   `${layout.w}x${layout.h}`);

/* ---------------- radar follows the scrubber ---------------- */
console.log('\n=== radar follows the scrubber in 3D ===');

// Compare what is actually on screen. The serialised GL style does not reflect
// updateImage(), so checking the source url would measure the wrong thing.
const clip = { x: 420, y: 60, width: 900, height: 700 };
const shots = [];
let lastStats = null;

const grab = async () => {
  shots.push(await page.screenshot({ clip }));
  lastStats = await page.evaluate(() => window.RadarLoop.mirrorStats());
};

await grab();
for (const fraction of [0.92, 0.84, 0.76, 0.68]) {
  await page.evaluate((f) => {
    const s = document.querySelector('.timeline__scrub .range');
    s.value = String(Math.round(Number(s.max) * f));
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
  await page.waitForTimeout(6000);
  await grab();
}

console.log(`  captures: ${JSON.stringify(lastStats)}`);
ok('every scrubber position produced a capture', lastStats.captured >= 5, JSON.stringify(lastStats));
ok('no capture was blocked or empty',
   lastStats.tainted === 0 && lastStats.noneDrawn === 0, JSON.stringify(lastStats));

const hashes = shots.map((buffer) => {
  let h = 0;
  for (let i = 0; i < buffer.length; i += 101) h = ((h * 31 + buffer[i]) | 0);
  return h;
});
const distinct = new Set(hashes).size;
console.log(`  rendered-frame signatures: ${JSON.stringify(hashes)}`);
ok('the 3D view repaints as the scrubber moves', distinct >= 4,
   `${distinct} distinct renders across ${shots.length} positions`);

try { await page.screenshot({ path: 'shots/3d-coastline.png' }); } catch {}
await page.click('#btn-3d');
await page.waitForTimeout(2500);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
