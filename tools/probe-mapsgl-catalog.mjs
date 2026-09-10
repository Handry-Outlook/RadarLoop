/**
 * Asks the MapsGL SDK itself which weather layers exist.
 *
 * The documentation is the published list; this is what the loaded SDK and this
 * account will actually accept, which is the list worth putting in the picker.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

// Force the controller to exist, then look for whatever registry it carries.
const found = await page.evaluate(async () => {
  window.RadarLoop.selectProduct('lightning', 'lightning-density');
  await new Promise((r) => setTimeout(r, 7000));

  const ctrl = window.__mapsglController;
  const out = { hasController: !!ctrl, sources: {} };
  if (!ctrl) return out;

  const collect = (label, value) => {
    if (!value) return;
    if (Array.isArray(value)) out.sources[label] = value.slice();
    else if (value instanceof Map) out.sources[label] = [...value.keys()];
    else if (typeof value === 'object') out.sources[label] = Object.keys(value);
  };

  collect('controller.weatherLayers', ctrl.weatherLayers);
  collect('controller.weatherLayerIds', ctrl.weatherLayerIds);
  collect('controller.layers', ctrl.layers);
  for (const key of ['catalog', 'registry', 'weather', '_weather', 'config']) collect(`controller.${key}`, ctrl[key]);

  const ns = window.aerisweather?.mapsgl;
  if (ns) {
    out.namespace = Object.keys(ns);
    for (const key of Object.keys(ns)) {
      const v = ns[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function') {
        const keys = Object.keys(v);
        if (keys.length > 20) out.sources[`aerisweather.mapsgl.${key}`] = keys;
      }
    }
  }
  return out;
});

console.log('controller present:', found.hasController);
console.log('namespace keys:', JSON.stringify(found.namespace || []).slice(0, 400));
for (const [where, ids] of Object.entries(found.sources || {})) {
  console.log(`\n${where}: ${ids.length} entries`);
  console.log('  ' + ids.slice(0, 30).join(', '));
}
writeFileSync('mapsgl-catalog.json', JSON.stringify(found, null, 2));
console.log('\nwritten to mapsgl-catalog.json');
await browser.close();
