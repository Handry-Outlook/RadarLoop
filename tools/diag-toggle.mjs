/**
 * Turns every layer group on, then off, and reports anything left on the map.
 * Used to find which product kinds fail to clear.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

// Start from a clean slate: everything off.
await page.evaluate(() => {
  for (const [, slot] of window.RadarLoop.slots) slot.enabled = false;
});
await page.waitForTimeout(1500);

const survey = () => page.evaluate(() => {
  const paneCounts = {};
  for (const pane of document.querySelectorAll('#map .leaflet-pane')) {
    const name = pane.className.replace('leaflet-pane leaflet-', '').trim();
    const n = pane.querySelectorAll('img, canvas, path, svg').length;
    if (n) paneCounts[name] = n;
  }
  const slotState = {};
  for (const [g, s] of window.RadarLoop.slots) {
    slotState[g] = { enabled: s.enabled, front: !!s.front, back: !!s.back, type: s.type };
  }
  return { paneCounts, slotState };
});

const GROUPS = ['radar', 'satellite', 'isobar', 'surfaceFront', 'wind', 'lightning',
  'tropicalStorms', 'rotation', 'observation', 'nowcast', 'warning'];

console.log('=== per-group on/off ===\n');
console.log('group           kind          onPanes                        leftAfterOff');

for (const group of GROUPS) {
  // Pick the group's first listed product.
  const info = await page.evaluate((g) => {
    const mod = window.__layers;
    const defs = mod.LAYER_CATALOG[g] || {};
    const order = (mod.LAYER_ORDER[g] || []).filter((e) => typeof e === 'string');
    const type = order.find((t) => defs[t]?.listed) || null;
    return { type, kind: type ? defs[type].kind : null };
  }, group);

  if (!info.type) {
    console.log(`${group.padEnd(15)} (no listed product)`);
    continue;
  }

  const before = await survey();

  // Turn on through the real path.
  await page.evaluate(({ g, t }) => window.RadarLoop.selectProduct(g, t), { g: group, t: info.type });
  await page.waitForTimeout(4500);
  const on = await survey();

  // Turn off through the real path.
  await page.evaluate((g) => window.RadarLoop.setLayerEnabled(g, false), group);
  await page.waitForTimeout(2500);
  const off = await survey();

  // Anything that grew while on and did not return to its baseline.
  const leaked = {};
  for (const [pane, count] of Object.entries(off.paneCounts)) {
    const base = before.paneCounts[pane] || 0;
    if (count > base) leaked[pane] = `${base} -> ${count}`;
  }

  const onPanes = Object.entries(on.paneCounts)
    .filter(([p, c]) => (before.paneCounts[p] || 0) < c)
    .map(([p, c]) => `${p}:${c}`).join(' ') || '(none)';

  const slot = off.slotState[group];
  const slotDirty = slot.front || slot.back;

  console.log(
    `${group.padEnd(15)} ${String(info.kind).padEnd(13)} ${onPanes.slice(0, 30).padEnd(30)} ` +
    `${Object.keys(leaked).length || slotDirty
      ? `LEAK ${JSON.stringify(leaked)}${slotDirty ? ' slot:' + JSON.stringify(slot) : ''}`
      : 'clean'}`,
  );
}

console.log('\n=== final state ===');
console.log(JSON.stringify((await survey()).paneCounts, null, 1));

await browser.close();
