/** Does toggling smoothing actually change anything downstream? */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

const report = await page.evaluate(() => {
  const before = {
    flag: window.__radarScale.isSmoothing(),
    signature: window.__radarScale.signature?.().slice(0, 24) ?? 'n/a',
    frameKey: window.RadarLoop.slots.get('radar').frameKey,
  };
  window.__radarScale.setSmoothing(true);
  const after = {
    flag: window.__radarScale.isSmoothing(),
    signature: window.__radarScale.signature?.().slice(0, 24) ?? 'n/a',
    frameKey: window.RadarLoop.slots.get('radar').frameKey,
  };
  window.__radarScale.setSmoothing(false);
  return { before, after };
});
console.log(JSON.stringify(report, null, 1));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
