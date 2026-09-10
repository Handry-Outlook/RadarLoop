/** A full day of global strikes, drawn. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
  window.RadarLoop.setLayerEnabled('lightning', true);
  window.RadarLoop.lightning.lifespanHours = 24;
  window.RadarLoop.playback.setHistorySpan(24);
  window.RadarLoop.map().setView([12, 20], 3);
});
for (let i = 0; i < 80; i += 1) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => window.__windyLightning.feedStats);
  if (s.framesLoaded >= s.framesWanted - 1) break;
}
const state = await page.evaluate(() => window.__windyLightning.feedStats);
console.log(JSON.stringify(state));
await page.evaluate(() => window.RadarLoop.slots.get('lightning').front._render());
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/lightning-24h.png', animations: 'disabled', timeout: 90000 });
console.log('written shots/lightning-24h.png');
await browser.close();
