/** What the satellite slot actually resolves to when the timeline goes back. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const seen = [];
page.on('request', (r) => { if (r.url().includes('sat.windy.com')) seen.push(r.url()); });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.selectProduct('satellite', 'windy-visir');
  window.RadarLoop.setLayerEnabled('satellite', true);
  window.RadarLoop.map().setView([48, -8], 4);
});
await page.waitForTimeout(12000);
seen.length = 0;

const hours = Number(process.argv[2] || 30);
const info = await page.evaluate((h) => {
  const target = Date.now() - h * 3600000;
  window.RadarLoop.focusWindow(target - 3 * 3600000, target + 3 * 3600000);
  window.RadarLoop.playback.setTime(target, { immediate: true });
  return { asked: new Date(target).toISOString() };
}, hours);
await page.waitForTimeout(16000);

const state = await page.evaluate(() => {
  const slot = window.RadarLoop.slots.get('satellite');
  return {
    type: slot?.type,
    enabled: slot?.enabled,
    frameKey: slot?.frameKey,
    hasLayer: !!slot?.front,
    shownAt: new Date(window.RadarLoop.time.current).toISOString(),
    tiles: document.querySelectorAll('canvas.windy-sat-tile').length,
    anyTiles: document.querySelectorAll('.leaflet-tile-pane canvas').length,
  };
});
console.log(JSON.stringify({ ...info, ...state }, null, 1));
console.log('first requests:');
for (const u of seen.slice(0, 4)) console.log(`  ${u.split('?')[0]}`);
console.log(`  ... ${seen.length} total, ${seen.filter((u) => u.includes('/archive/')).length} to the archive`);
await browser.close();
