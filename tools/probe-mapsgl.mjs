/** Inspects the Aeris MapsGL controller API so teardown uses the real method. */

import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.argv[2] || 'http://localhost:8080/index.html',
  { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

const info = await page.evaluate(() => new Promise((resolve) => {
  window.RadarLoop.selectProduct('lightning', 'lightning-all-tile');
  setTimeout(() => {
    const c = window.__mapsglController;
    if (!c) return resolve({ error: 'controller not exposed' });

    // Walk the whole prototype chain — the API is inherited, not own.
    const methods = new Set();
    for (let p = c; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) {
        try { if (typeof c[n] === 'function') methods.add(n); } catch { /* getter threw */ }
      }
    }

    const layers = c.layers;
    let layerInfo = null;
    if (layers) {
      layerInfo = {
        ctor: layers.constructor?.name,
        isMap: layers instanceof Map,
        size: layers.size ?? (Array.isArray(layers) ? layers.length : Object.keys(layers).length),
        keys: layers instanceof Map ? [...layers.keys()]
          : (Array.isArray(layers) ? layers.map((l) => l?.id) : Object.keys(layers)),
        protoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(layers) || {}),
      };
    }

    resolve({
      weatherMethods: [...methods].filter((m) => /weather|layer|source|remove|add/i.test(m)).sort(),
      layerInfo,
      canvases: document.querySelectorAll('#map canvas').length,
    });
  }, 7000);
}));

console.log(JSON.stringify(info, null, 1));

// Try each plausible removal call and see which actually clears the canvas.
const attempts = await page.evaluate(() => new Promise((resolve) => {
  const c = window.__mapsglController;
  const before = document.querySelectorAll('#map canvas').length;
  const tried = [];
  const id = 'lightning-all';

  for (const name of ['removeWeatherLayer', 'removeLayer', 'remove']) {
    if (typeof c?.[name] !== 'function') { tried.push(`${name}: absent`); continue; }
    try {
      c[name](id);
      tried.push(`${name}: called ok`);
    } catch (e) {
      tried.push(`${name}: threw ${e.message.slice(0, 60)}`);
    }
  }
  setTimeout(() => resolve({
    tried,
    before,
    after: document.querySelectorAll('#map canvas').length,
  }), 2500);
}));

console.log('\n=== removal attempts ===');
console.log(JSON.stringify(attempts, null, 1));

await browser.close();
