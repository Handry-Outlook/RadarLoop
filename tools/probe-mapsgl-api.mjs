/**
 * What the MapsGL controller actually exposes, and where its canvas sits.
 *
 * Two reported problems: the opacity slider does nothing for MapsGL products,
 * and they always draw underneath everything else. This enumerates the SDK's
 * methods (the opacity call is wrapped in a swallowing try/catch, so a missing
 * method looks identical to a working one) and reports the canvas's stacking
 * context against the weather panes.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-all-tile'));
await page.waitForTimeout(10000);

const report = await page.evaluate(() => {
  const c = window.__mapsglController;
  if (!c) return { error: 'no controller' };

  // Every callable on the controller and its prototype chain.
  const methods = new Set();
  for (let o = c; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      try { if (typeof c[k] === 'function') methods.add(k); } catch { /* getter threw */ }
    }
  }
  const interesting = [...methods].filter((m) => /opacity|layer|weather|order|move|before|paint|style/i.test(m)).sort();

  const canvases = [...(document.querySelector('.leaflet-overlay-pane')?.children || [])]
    .filter((n) => n.tagName === 'CANVAS')
    .map((n) => {
      const s = getComputedStyle(n);
      return { cls: n.className || '(none)', zIndex: s.zIndex, position: s.position, opacity: s.opacity };
    });

  const panes = ['satellitePane', 'radarPane', 'lightningPane'].map((name) => {
    const p = window.RadarLoop.map().getPane(name);
    return [name, p ? getComputedStyle(p).zIndex : null];
  });

  // Does a weather layer object come back, and what can it do?
  let layerApi = null;
  try {
    const got = c.getWeatherLayer?.('lightning-all');
    if (got) {
      const keys = new Set();
      for (let o = got; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
      }
      layerApi = { keys: [...keys].filter((k) => /opacity|option|paint|set|id/i.test(k)).sort(), opacity: got.opacity, ids: got.id ?? got.layerId ?? null };
    }
  } catch (e) {
    layerApi = `threw: ${e.message}`;
  }

  let glLayers = null;
  try {
    const m = c.map || c._map || c.mapController?.map;
    glLayers = m?.getStyle?.().layers?.map((l) => `${l.id}:${l.type}`) ?? null;
  } catch (e) { glLayers = `threw: ${e.message}`; }
  return { interesting, canvases, panes, layerApi, glLayers };
});

console.log('\n=== controller methods (opacity / layer / order) ===');
console.log(report.error || report.interesting?.join(', '));
console.log('\n=== weather layer object API ===');
console.log(JSON.stringify(report.layerApi));
console.log('\n=== canvases directly under overlayPane ===');
console.log(JSON.stringify(report.canvases, null, 2));
console.log('\n=== weather pane z-index for comparison ===');
console.log(JSON.stringify(report.panes));
console.log('\n=== GL style layers owned by the controller ===');
console.log(JSON.stringify(report.glLayers));

/* Does calling the documented opacity setter change anything? */
const effect = await page.evaluate(async () => {
  const c = window.__mapsglController;
  const canvas = [...(document.querySelector('.leaflet-overlay-pane')?.children || [])]
    .find((n) => n.tagName === 'CANVAS');
  const before = canvas ? getComputedStyle(canvas).opacity : null;
  const tried = {};
  for (const [name, call] of [
    ['setLayerOpacity', () => c.setLayerOpacity?.('lightning-all', 0.2)],
    ['setWeatherLayerOpacity', () => c.setWeatherLayerOpacity?.('lightning-all', 0.2)],
    ['layer.setOpacity', () => c.getWeatherLayer?.('lightning-all')?.setOpacity?.(0.2)],
    ['layer.opacity=', () => { const l = c.getWeatherLayer?.('lightning-all'); if (l) l.opacity = 0.2; }],
  ]) {
    try { call(); tried[name] = 'called'; } catch (e) { tried[name] = `threw: ${e.message}`; }
  }
  await new Promise((r) => setTimeout(r, 1200));
  return { before, after: canvas ? getComputedStyle(canvas).opacity : null, tried };
});
console.log('\n=== opacity attempts ===');
console.log(JSON.stringify(effect, null, 2));

await browser.close();
