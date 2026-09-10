import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const urls = [];
page.on('request', (r) => { if (/manta-current-direction/.test(r.url())) urls.push(r.url()); });
page.on('response', (r) => { if (/manta-current-direction/.test(r.url())) urls.push(`  <- ${r.status()} ${r.url().slice(-60)}`); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.RadarLoop.selectProduct('wind', 'fcst-manta-current-direction-grid'));
await page.waitForTimeout(14000);
console.log('slot:', JSON.stringify(await page.evaluate(() => {
  const s = window.RadarLoop.slots.get('wind');
  return { enabled: s.enabled, type: s.type, front: !!s.front, lastUrl: s.lastUrl, ts: s.lastTimestamp };
})));
console.log('def:', JSON.stringify(await page.evaluate(() =>
  window.__layers.LAYER_CATALOG.wind['fcst-manta-current-direction-grid'])));
console.log('probes:', await page.evaluate(() => window.RadarLoop.runtime.stats.probes));
console.log('requests seen:', urls.slice(0, 8));
await browser.close();
