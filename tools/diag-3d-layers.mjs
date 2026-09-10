/**
 * Which products actually appear in 3D.
 *
 * Enabling a layer in 3D is not the same as seeing it: a product reaches GL only
 * if `mirrorTo3D` knows how to represent its kind, and products drawn by their
 * own engine (MapsGL, Xweather, the bespoke lightning feed) bypass the tile
 * pipeline entirely and so never get mirrored at all.
 *
 * For every listed product this switches to it in 3D and reports whether a GL
 * layer exists for its group, and what kind of GL source backs it. It also
 * checks the overlays that are not part of the layer slots at all — strikes, the
 * in-house nowcast, and HOCO polygons.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const only = process.env.GROUP || '';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  for (const [g] of window.RadarLoop.slots) window.RadarLoop.setLayerEnabled(g, false);
});
await page.waitForTimeout(1200);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

const cases = await page.evaluate((filter) => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  const out = [];
  for (const [group, defs] of Object.entries(LAYER_CATALOG)) {
    if (filter.length && !filter.includes(group)) continue;
    for (const entry of LAYER_ORDER[group] || []) {
      if (typeof entry !== 'string') continue;
      const def = defs[entry];
      if (!def?.listed) continue;
      out.push({ group, type: entry, kind: def.kind, label: def.label });
    }
  }
  return out;
}, only ? only.split(',').map((g) => g.trim()).filter(Boolean) : []);

console.log(`=== ${cases.length} listed products, checked in 3D ===\n`);
console.log('group          kind             product                              3D');

const missing = [];

for (const c of cases) {
  await page.evaluate(({ g, t }) => window.RadarLoop.selectProduct(g, t), { g: c.group, t: c.type });
  await page.waitForTimeout(3600);

  const state = await page.evaluate((g) => {
    const gl = window.RadarLoop.gl();
    const slot = window.RadarLoop.slots.get(g);
    const kind = window.RadarLoop.mirrorKind ? window.RadarLoop.mirrorKind(g) : null;
    // Any GL layer whose id belongs to this group.
    const ids = gl ? gl.getStyle().layers.map((l) => l.id).filter((id) => id.includes(`wx-${g}`)) : [];
    return { drew2d: !!slot?.front, kind, ids: ids.length };
  }, c.group);

  const verdict = state.kind ? `ok (${state.kind})`
    : state.drew2d ? 'NOT MIRRORED'
      : 'no data';
  if (!state.kind && state.drew2d) missing.push(c);

  console.log(`${c.group.padEnd(14)} ${String(c.kind).padEnd(16)} ${String(c.label).slice(0, 36).padEnd(37)} ${verdict}`);

  await page.evaluate((g) => window.RadarLoop.setLayerEnabled(g, false), c.group);
  await page.waitForTimeout(500);
}

/* ------------------------------------------------------------------ *
 * Overlays that are not layer slots
 * ------------------------------------------------------------------ */
console.log('\n=== overlays outside the layer slots ===');

const overlays = await page.evaluate(async () => {
  const gl = window.RadarLoop.gl();
  const layerIds = () => gl.getStyle().layers.map((l) => l.id);

  const out = {};
  out.strikeLayer = layerIds().filter((id) => /strike/i.test(id));
  out.strikeCount = window.RadarLoop.lightningFiltered().length;

  // Any GL layer that could carry nowcast cones or outlook polygons.
  out.nowcast = layerIds().filter((id) => /nowcast/i.test(id));
  out.hoco = layerIds().filter((id) => /hoco|outlook/i.test(id));

  // What exists on the 2D side, for comparison.
  out.leaflet2d = {
    nowcast: document.querySelectorAll('#map .leaflet-pane path').length,
  };
  out.allGlLayers = layerIds().filter((id) => id.startsWith('wx-') || /strike|nowcast|hoco/i.test(id));
  return out;
});

console.log(`  strikes:  GL layers ${JSON.stringify(overlays.strikeLayer)}  (${overlays.strikeCount} filtered strikes)`);
console.log(`  nowcast:  GL layers ${JSON.stringify(overlays.nowcast)}`);
console.log(`  HOCO:     GL layers ${JSON.stringify(overlays.hoco)}`);
console.log(`  all wx-*: ${JSON.stringify(overlays.allGlLayers)}`);

console.log('\n=== not mirrored, though 2D drew them ===');
if (!missing.length) console.log('  none');
for (const m of missing) console.log(`  ${m.group}/${m.type}  (${m.kind})  ${m.label}`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.slice(0, 10).forEach((e) => console.log(`  ${e}`));
else console.log('  none');

await browser.close();
