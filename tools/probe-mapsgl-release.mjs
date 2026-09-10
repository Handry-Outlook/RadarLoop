/** Traces MapsGL teardown step by step. */

import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('console', (m) => {
  const t = m.text();
  if (/mapsgl|MapsGL/.test(t)) console.log(`  [console] ${t.slice(0, 200)}`);
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(process.argv[2] || 'http://localhost:8080/index.html',
  { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

const trace = await page.evaluate(async () => {
  const snap = (tag) => ({
    tag,
    canvases: document.querySelectorAll('#map canvas').length,
    controller: !!window.__mapsglController,
    // MapsGL puts its surface in its own container.
    mapsglCanvas: document.querySelectorAll('#map canvas.mapsgl-canvas, #map .mapsgl-container canvas').length,
    overlayCanvases: document.querySelectorAll('#map .leaflet-overlay-pane canvas').length,
  });

  const out = [snap('start')];

  window.RadarLoop.selectProduct('lightning', 'lightning-all-tile');
  await new Promise((r) => setTimeout(r, 8000));
  out.push(snap('after add'));

  window.RadarLoop.setLayerEnabled('lightning', false);
  await new Promise((r) => setTimeout(r, 1000));
  out.push(snap('+1s'));
  await new Promise((r) => setTimeout(r, 3000));
  out.push(snap('+4s'));
  await new Promise((r) => setTimeout(r, 5000));
  out.push(snap('+9s'));

  // What is the extra canvas, if any?
  const canvases = [...document.querySelectorAll('#map canvas')].map((c) => ({
    cls: c.className || '(none)',
    parent: c.parentElement?.className || '(none)',
    w: c.width, h: c.height,
  }));
  const byParent = {};
  for (const c of canvases) byParent[c.parent] = (byParent[c.parent] || 0) + 1;

  return { out, byParent };
});

console.log('=== teardown trace ===');
for (const s of trace.out) {
  console.log(`  ${s.tag.padEnd(10)} canvases=${s.canvases} controller=${s.controller} overlay=${s.overlayCanvases}`);
}
console.log('\n=== canvases by parent ===');
console.log(JSON.stringify(trace.byParent, null, 1));

await browser.close();
