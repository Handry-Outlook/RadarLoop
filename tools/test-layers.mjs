/**
 * This round of work:
 *   - the wind group has products again
 *   - MapsGL layers actually turn off
 *   - the layer manager lists, reorders (drag + keyboard) and removes
 *   - 3D uses the right tile scheme and mirrors every kind it can
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

/* ================================================================== *
 * 1. Wind products restored
 * ================================================================== */
console.log('\n=== wind group ===');
const wind = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  const defs = LAYER_CATALOG.wind || {};
  const listed = (LAYER_ORDER.wind || []).filter((e) => typeof e === 'string' && defs[e]?.listed);
  return { count: listed.length, first: listed[0], label: defs[listed[0]]?.label };
});
ok('wind has products', wind.count >= 9, `count=${wind.count}`);
console.log(`  first: ${wind.first} (${wind.label})`);

// Several products in turn, not only the first. This check exists because the
// whole wind group was once empty, and a single product going dead upstream is
// a different thing that should not read as that — `wind-dir-dk` answers 400 for
// every timestamp at the time of writing.
const windCandidates = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  const defs = LAYER_CATALOG.wind || {};
  return (LAYER_ORDER.wind || [])
    .filter((e) => typeof e === 'string' && defs[e]?.listed && defs[e].kind === 'raster')
    .slice(0, 5);
});
const windDraws = await page.evaluate(async (types) => {
  for (const type of types) {
    window.RadarLoop.selectProduct('wind', type);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5000));
    const slot = window.RadarLoop.slots.get('wind');
    if (slot.enabled && slot.front) return { drew: type, tried: types.indexOf(type) + 1 };
  }
  return { drew: null, tried: types.length };
}, windCandidates);
console.log(`  drew ${windDraws.drew} after trying ${windDraws.tried}`);
ok('a wind product renders', !!windDraws.drew, JSON.stringify(windDraws));
await page.evaluate(() => window.RadarLoop.setLayerEnabled('wind', false));
await page.waitForTimeout(1500);

/* ================================================================== *
 * 2. MapsGL turns off
 * ================================================================== */
console.log('\n=== MapsGL teardown ===');
const mapsgl = await page.evaluate(async () => {
  const before = document.querySelectorAll('#map canvas').length;
  window.RadarLoop.selectProduct('lightning', 'lightning-all-tile');
  await new Promise((r) => setTimeout(r, 8000));

  const c = window.__mapsglController;
  const onState = {
    canvases: document.querySelectorAll('#map canvas').length,
    hasLayer: typeof c?.hasWeatherLayer === 'function' ? c.hasWeatherLayer('lightning-all') : null,
    controller: !!c,
  };

  window.RadarLoop.setLayerEnabled('lightning', false);
  await new Promise((r) => setTimeout(r, 6000));

  const c2 = window.__mapsglController;
  return {
    before,
    onState,
    offCanvases: document.querySelectorAll('#map canvas').length,
    offHasLayer: typeof c2?.hasWeatherLayer === 'function' ? c2.hasWeatherLayer('lightning-all') : null,
    controllerGone: !c2,
  };
});
console.log(`  ${JSON.stringify(mapsgl)}`);
ok('the MapsGL layer was added', mapsgl.onState.hasLayer === true || mapsgl.onState.canvases > mapsgl.before);
ok('the MapsGL layer is gone after switching off',
   mapsgl.offHasLayer !== true, `hasWeatherLayer=${mapsgl.offHasLayer}`);
ok('the controller and its canvas are released',
   mapsgl.controllerGone && mapsgl.offCanvases <= mapsgl.before,
   `controllerGone=${mapsgl.controllerGone} canvases ${mapsgl.before}->${mapsgl.offCanvases}`);

/* ================================================================== *
 * 3. Layer manager
 * ================================================================== */
console.log('\n=== layer manager ===');
await page.evaluate(() => {
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor');
  window.RadarLoop.selectProduct('isobar', 'pressure_two');
});
await page.waitForTimeout(6000);

await page.click('.rail__btn[data-group="layers"]');
await page.waitForTimeout(1500);

const listed = await page.evaluate(() =>
  [...document.querySelectorAll('.layer-row')].map((r) => r.dataset.group));
console.log(`  rows: ${JSON.stringify(listed)}`);
ok('the manager lists the active layers', listed.length >= 3, JSON.stringify(listed));

const zBefore = await page.evaluate(() => {
  const out = {};
  for (const [g, s] of window.RadarLoop.slots) if (s.enabled) out[g] = s.zIndex;
  return out;
});

// Keyboard reorder: move the last row up one.
const last = listed[listed.length - 1];
await page.evaluate((g) => {
  const row = document.querySelector(`.layer-row[data-group="${g}"]`);
  const handle = row.querySelector('.layer-row__handle');
  handle.focus();
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
}, last);
await page.waitForTimeout(1200);

const afterKb = await page.evaluate(() =>
  [...document.querySelectorAll('.layer-row')].map((r) => r.dataset.group));
console.log(`  after ArrowUp on "${last}": ${JSON.stringify(afterKb)}`);
ok('keyboard reordering moves the row up',
   afterKb.indexOf(last) === listed.indexOf(last) - 1,
   `${listed.indexOf(last)} -> ${afterKb.indexOf(last)}`);

const zAfter = await page.evaluate(() => {
  const out = {};
  for (const [g, s] of window.RadarLoop.slots) if (s.enabled) out[g] = s.zIndex;
  return out;
});
ok('reordering changes the z-indexes',
   JSON.stringify(zBefore) !== JSON.stringify(zAfter),
   `${JSON.stringify(zBefore)} -> ${JSON.stringify(zAfter)}`);

// Pane z-index must follow the slot.
const paneZ = await page.evaluate(() => ({
  radar: getComputedStyle(document.querySelector('.leaflet-radarPane') || document.body).zIndex,
  satellite: getComputedStyle(document.querySelector('.leaflet-satellitePane') || document.body).zIndex,
}));
console.log(`  pane z: ${JSON.stringify(paneZ)}`);

// The up button.
const topBefore = afterKb[0];
await page.click(`.layer-row[data-group="${afterKb[1]}"] button[aria-label="Move up"]`);
await page.waitForTimeout(1200);
const afterBtn = await page.evaluate(() =>
  [...document.querySelectorAll('.layer-row')].map((r) => r.dataset.group));
ok('the up button reorders', afterBtn[0] !== topBefore, JSON.stringify(afterBtn));

// The remove button.
const removeTarget = afterBtn[0];
await page.click(`.layer-row[data-group="${removeTarget}"] button[aria-label="Turn off"]`);
await page.waitForTimeout(2000);
const afterRemove = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.layer-row')].map((r) => r.dataset.group),

}));
ok('the remove button turns the layer off',
   !afterRemove.rows.includes(removeTarget), JSON.stringify(afterRemove.rows));

try { await page.screenshot({ path: 'shots/layer-manager.png' }); } catch {}

/* ================================================================== *
 * 4. 3D coverage and tile scheme
 * ================================================================== */
console.log('\n=== 3D ===');
await page.evaluate(() => {
  // A DTN satellite product — the flipped-Y case that needs scheme: tms.
  window.RadarLoop.selectProduct('satellite', 'europe-vis');
  window.RadarLoop.selectProduct('radar', 'windy-radar');
});
await page.waitForTimeout(7000);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

const three = await page.evaluate(() => {
  const gl = window.RadarLoop.gl?.();
  const style = gl?.getStyle?.();
  const sources = {};
  for (const [id, src] of Object.entries(style?.sources || {})) {
    if (!id.startsWith('wx-')) continue;
    sources[id] = { type: src.type, scheme: src.scheme ?? null };
  }
  return {
    is3D: window.RadarLoop.runtime.is3D,
    wxLayers: (style?.layers || []).filter((l) => l.id.startsWith('wx-')).map((l) => l.id),
    sources,
  };
});
console.log(`  ${JSON.stringify(three, null, 1)}`);

ok('3D is active', three.is3D === true);
ok('radar is mirrored', three.wxLayers.some((l) => l.includes('radar')), JSON.stringify(three.wxLayers));
ok('satellite is mirrored', three.wxLayers.some((l) => l.includes('satellite')), JSON.stringify(three.wxLayers));

const satSrc = three.sources['wx-satellite-src'];
ok('the DTN satellite source uses the tms scheme',
   satSrc?.scheme === 'tms',
   `scheme=${satSrc?.scheme} (xyz here means the imagery renders flipped)`);

try { await page.screenshot({ path: 'shots/3d-layers.png' }); } catch {}
await page.click('#btn-3d');
await page.waitForTimeout(2500);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
