/**
 * Exhaustive on/off check: every *kind* of product, not just the first listed
 * one per group. MapsGL and Xweather products live behind different teardown
 * paths and were never reached by the first-product-only sweep.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  for (const [g] of window.RadarLoop.slots) window.RadarLoop.setLayerEnabled(g, false);
});
await page.waitForTimeout(1500);

// One representative product per (group, kind).
const cases = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  const out = [];
  for (const [group, defs] of Object.entries(LAYER_CATALOG)) {
    const seen = new Set();
    for (const entry of LAYER_ORDER[group] || []) {
      if (typeof entry !== 'string') continue;
      const def = defs[entry];
      if (!def?.listed || seen.has(def.kind)) continue;
      seen.add(def.kind);
      out.push({ group, type: entry, kind: def.kind, label: def.label });
    }
  }
  return out;
});

console.log(`=== ${cases.length} cases (one per group x kind) ===\n`);
console.log('group          kind             product                             result');

const survey = () => page.evaluate(() => {
  const counts = {};
  for (const pane of document.querySelectorAll('#map .leaflet-pane')) {
    const name = pane.className.replace('leaflet-pane leaflet-', '').trim();
    const n = pane.querySelectorAll('img, canvas, path').length;
    if (n) counts[name] = n;
  }
  const markers = document.querySelectorAll('#map .leaflet-marker-icon').length;
  const slot = {};
  for (const [g, s] of window.RadarLoop.slots) if (s.front || s.back) slot[g] = true;
  return { counts, markers, slot };
});

let failures = 0;

for (const c of cases) {
  const before = await survey();

  await page.evaluate(({ g, t }) => window.RadarLoop.selectProduct(g, t), { g: c.group, t: c.type });
  await page.waitForTimeout(4200);
  const on = await survey();

  await page.evaluate((g) => window.RadarLoop.setLayerEnabled(g, false), c.group);
  await page.waitForTimeout(2200);
  const off = await survey();

  const grew = [];
  for (const [pane, n] of Object.entries(off.counts)) {
    const base = before.counts[pane] || 0;
    if (n > base) grew.push(`${pane} ${base}->${n}`);
  }
  if (off.markers > before.markers) grew.push(`markers ${before.markers}->${off.markers}`);
  if (off.slot[c.group]) grew.push('slot still holds a layer');

  const drew = Object.entries(on.counts).some(([p, n]) => (before.counts[p] || 0) < n) ||
    on.markers > before.markers;

  const verdict = grew.length ? `LEAK: ${grew.join(', ')}` : (drew ? 'clean' : 'clean (drew nothing)');
  if (grew.length) failures += 1;

  console.log(
    `${c.group.padEnd(14)} ${c.kind.padEnd(16)} ${c.label.slice(0, 34).padEnd(35)} ${verdict}`,
  );
}

console.log(`\n${failures === 0 ? 'NO LEAKS' : `${failures} LEAKING CASE(S)`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
