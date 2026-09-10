/** Opens a station card and photographs it, in both themes. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.map().setView([40.0, -75.3], 9, { animate: false });
});
await page.waitForTimeout(11000);

const opened = await page.evaluate(() => {
  const o = window.RadarLoop.observations();
  const hit = window.RadarLoop.openNearestStation();
  return { enabled: o.enabled, held: o.held, plotted: o.plotted, opened: hit };
});
console.log('state:', JSON.stringify(opened));
await page.waitForTimeout(11000);

const card = await page.evaluate(() => {
  const c = document.querySelector('.wxcard');
  if (!c) return null;
  return {
    charts: c.querySelectorAll('svg.wxchart').length,
    linePoints: [...c.querySelectorAll('.wxchart__line')].map((n) => (n.getAttribute('d').match(/[ML]/g) || []).length),
    lines: c.querySelectorAll('.wxchart__line').length,
    legends: c.querySelectorAll('.wxchart__legend').length,
    readings: c.querySelectorAll('.wxcard__reading').length,
    hasTable: !!c.querySelector('.wxcard__table'),
    text: c.textContent.replace(/\s+/g, ' ').slice(0, 150),
  };
});
console.log('card:', JSON.stringify(card));
// The popup wrapper, not the card: the card is inset and clipping to it cuts
// the header.
const box = await page.locator('.wxcard-shell .leaflet-popup-content-wrapper').boundingBox().catch(() => null);
console.log('popup box:', JSON.stringify(box));
console.log('card scrollTop:', await page.evaluate(() => {
  const c = document.querySelector('.wxcard');
  return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
}));
await page.screenshot({ path: 'shots/station-card-context.png' });
if (box) {
  await page.screenshot({ path: 'shots/station-card-dark.png', clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: box.height + 24 } });
  await page.click('#btn-theme');
  await page.waitForTimeout(1200);
  const box2 = await page.locator('.wxcard-shell .leaflet-popup-content-wrapper').boundingBox();
  await page.screenshot({ path: 'shots/station-card-light.png', clip: { x: Math.max(0, box2.x - 12), y: Math.max(0, box2.y - 12), width: box2.width + 24, height: box2.height + 24 } });
  console.log('written shots/station-card-dark.png and -light.png');
}
await browser.close();
