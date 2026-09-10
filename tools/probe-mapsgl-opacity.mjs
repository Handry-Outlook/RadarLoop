import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-all-tile'));
await page.waitForTimeout(11000);
console.log(JSON.stringify(await page.evaluate(async () => {
  const c = window.__mapsglController;
  const shape = (o) => {
    if (!o) return null;
    const keys = new Set();
    for (let x = o; x && x !== Object.prototype; x = Object.getPrototypeOf(x)) {
      for (const k of Object.getOwnPropertyNames(x)) keys.add(k);
    }
    return [...keys].slice(0, 40);
  };
  const out = {};
  try { out.findLayer = shape(c.findLayer('lightning-all')); } catch (e) { out.findLayer = `threw: ${e.message}`; }
  try { out.getLayer = shape(c.getLayer('lightning-all')); } catch (e) { out.getLayer = `threw: ${e.message}`; }
  const canvas = [...(document.querySelector('.leaflet-overlay-pane')?.children || [])].find((n) => n.tagName === 'CANVAS');
  try { c.setPaintProperty('lightning-all', 'raster-opacity', 0.2); out.setPaint = 'called'; }
  catch (e) { out.setPaint = `threw: ${e.message}`; }
  await new Promise((r) => setTimeout(r, 1000));
  out.canvasOpacityAfterPaint = canvas ? getComputedStyle(canvas).opacity : null;
  // The direct route.
  if (canvas) canvas.style.opacity = '0.25';
  await new Promise((r) => setTimeout(r, 400));
  out.canvasOpacityAfterStyle = canvas ? getComputedStyle(canvas).opacity : null;
  if (canvas) { canvas.style.zIndex = '450'; out.zIndexAfterStyle = getComputedStyle(canvas).zIndex; }
  return out;
}), null, 2));
await browser.close();
