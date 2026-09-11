/** The nowcast on a real convective day, as it is actually drawn. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
for (let i = 0; i < 40; i += 1) {
  const n = await page.evaluate(() => window.RadarLoop.lightningAll().length);
  if (n > 1000000) break;
  await page.waitForTimeout(1500);
}

const at = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  const hours = new Map();
  for (const s of all) {
    const h = Math.floor(s.ms / 3600000);
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  return hour * 3600000 + 3600000;
});

await page.evaluate((end) => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.lightning.nowcast = true;
  window.RadarLoop.lightning.lifespanHours = 3;
  window.RadarLoop.lightning.nowcastConfidence = 0.1;
  window.RadarLoop.focusWindow(new Date(end - 3 * 3600000), new Date(end));
  window.RadarLoop.playback.setTime(end, { immediate: true });
  window.RadarLoop.map().setView([55, 0.5], 7);
}, at);
await page.waitForTimeout(9000);

const drawn = await page.evaluate(() => {
  const map = window.RadarLoop.map();
  const ink = (pane) => {
    const canvas = map.getPane(pane)?.querySelector('canvas');
    if (!canvas?.width) return 0;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 200) if (d[i] > 8) lit += 1;
    return lit;
  };
  return {
    at: new Date(window.RadarLoop.time.current).toISOString(),
    loaded: window.RadarLoop.lightningAll().length,
    strikesInWindow: window.RadarLoop.lightningFiltered().length,
    fillInk: ink('nowcastFillPane'),
    outlineInk: ink('nowcastOutlinePane'),
  };
});
console.log(JSON.stringify(drawn));
await page.screenshot({ path: 'shots/nowcast-real.png' });
console.log('written shots/nowcast-real.png');
await browser.close();
