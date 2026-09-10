import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);
// Through the real control, so the storage key and its prefix come from the app.
await page.click('#btn-theme');
await page.waitForTimeout(800);
console.log('toggled to:', await page.evaluate(() => window.RadarLoop.runtime.theme));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
console.log('theme after fresh load:', await page.evaluate(() => ({
  runtime: window.RadarLoop.runtime.theme,
  dom: document.documentElement.dataset.theme,
  raw: Object.entries(localStorage).filter(([k]) => k.includes('theme')),
})));
await page.click('#btn-3d');
await page.waitForTimeout(11000);
console.log('3D style:', await page.evaluate(() => {
  const s = window.RadarLoop.gl()?.getStyle();
  return s ? s.name : null;
}));
await browser.close();
