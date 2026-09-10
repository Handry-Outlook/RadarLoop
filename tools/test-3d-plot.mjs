/**
 * Tile products in 3D: fetched once, and 2D still works on the way back.
 *
 * A tile product is handed to GL as its own raster source, so GL has the tiles
 * by URL. The renderer used to load them into the hidden Leaflet map as well —
 * and *wait* for that copy — before handing GL the source, so every tile was
 * downloaded twice and the layer appeared only after the invisible copy had
 * finished. Radar took 2.4 s to appear in 2D and 6.5 s in 3D for that reason.
 *
 * The risk in skipping the Leaflet copy is the return journey: those slots never
 * had a layer on the map, so leaving 3D must rebuild them or the 2D view comes
 * back empty. That is most of what this checks.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);

await page.evaluate(() => {
  window.RadarLoop.selectProduct('radar', 'radar-global');
  window.RadarLoop.selectProduct('satellite', 'satellite');
});
await page.waitForTimeout(9000);

const tilesOnMap = () => page.evaluate(() =>
  document.querySelectorAll('#map .leaflet-pane img').length);

const before2d = await tilesOnMap();
console.log(`\n=== 2D ===`);
console.log(`  ${before2d} tiles on the Leaflet map`);
ok('both products draw in 2D', before2d > 0, `${before2d} tiles`);

/* ================================================================== *
 * 3D: GL fetches, Leaflet does not
 * ================================================================== */
console.log('\n=== 3D ===');
await page.click('#btn-3d');
await page.waitForTimeout(14000);

// Change frame so the slots re-render *inside* 3D, which is the path under test.
await page.evaluate(() => {
  const slider = document.querySelector('.timeline__scrub .range');
  slider.value = String(Number(slider.max) - 20);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(9000);

const inThree = await page.evaluate(() => {
  const gl = window.RadarLoop.gl();
  const ids = gl.getStyle().layers.map((l) => l.id);
  const slots = {};
  for (const [g, s] of window.RadarLoop.slots) {
    if (!s.enabled || !s.type) continue;
    slots[g] = { glDirect: !!s.glDirect, hasFront: !!s.front, onMap: !!s.front && window.RadarLoop.map().hasLayer(s.front) };
  }
  return { slots, glLayers: ids.filter((id) => id.startsWith('wx-')) };
});
console.log(`  slots: ${JSON.stringify(inThree.slots)}`);
console.log(`  GL layers: ${JSON.stringify(inThree.glLayers)}`);

ok('the radar reached GL', inThree.glLayers.includes('wx-radar'), JSON.stringify(inThree.glLayers));
ok('the satellite reached GL', inThree.glLayers.includes('wx-satellite'), JSON.stringify(inThree.glLayers));
ok('tile products took the GL-direct path',
   inThree.slots.radar?.glDirect === true && inThree.slots.satellite?.glDirect === true,
   JSON.stringify(inThree.slots));
ok('and were not also loaded into the hidden 2D map',
   inThree.slots.radar?.onMap === false && inThree.slots.satellite?.onMap === false,
   JSON.stringify(inThree.slots));

/* ================================================================== *
 * Back to 2D
 * ================================================================== */
console.log('\n=== back to 2D ===');
await page.click('#btn-3d');
await page.waitForTimeout(12000);

const after = await page.evaluate(() => ({
  tiles: document.querySelectorAll('#map .leaflet-pane img').length,
  slots: Object.fromEntries([...window.RadarLoop.slots]
    .filter(([, s]) => s.enabled && s.type)
    .map(([g, s]) => [g, { glDirect: !!s.glDirect, onMap: !!s.front && window.RadarLoop.map().hasLayer(s.front) }])),
  is3D: window.RadarLoop.runtime.is3D,
}));
console.log(`  ${after.tiles} tiles on the Leaflet map`);
console.log(`  slots: ${JSON.stringify(after.slots)}`);

ok('returned to 2D', after.is3D === false);
ok('the 2D map is populated again', after.tiles > 0, `${after.tiles} tiles`);
ok('the GL-direct flag is cleared',
   Object.values(after.slots).every((s) => s.glDirect === false), JSON.stringify(after.slots));
ok('every active layer is back on the map',
   Object.values(after.slots).every((s) => s.onMap === true), JSON.stringify(after.slots));

// And a second trip through 3D still works.
await page.click('#btn-3d');
await page.waitForTimeout(12000);
await page.click('#btn-3d');
await page.waitForTimeout(12000);
const secondTrip = await page.evaluate(() => ({
  tiles: document.querySelectorAll('#map .leaflet-pane img').length,
  is3D: window.RadarLoop.runtime.is3D,
}));
console.log(`  after a second round trip: ${JSON.stringify(secondTrip)}`);
ok('a second round trip also restores 2D',
   secondTrip.is3D === false && secondTrip.tiles > 0, JSON.stringify(secondTrip));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
