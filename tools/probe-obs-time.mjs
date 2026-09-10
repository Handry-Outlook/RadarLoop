/** Do the station models follow the scrubber? */
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const calls = [];
page.on('request', (r) => {
  if (!r.url().includes('api.synopticdata.com')) return;
  calls.push(/attime=(\d+)/.exec(r.url())?.[1] || 'latest');
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => {
  window.RadarLoop.map().setView([40.5, -76.0], 7, { animate: false });
  window.RadarLoop.setLayerEnabled('observations', true);
});
await page.waitForTimeout(10000);

const sample = () => page.evaluate(() => {
  const o = window.RadarLoop.observations();
  return { held: o.held, plotted: o.plotted, forTime: o.forTime, temps: o.sampleTemps };
});
console.log('live:', JSON.stringify(await sample()));

for (const back of [3, 9, 20]) {
  await page.evaluate(async (h) => {
    const slider = document.querySelector('.timeline__scrub .range');
    const max = Number(slider.max);
    const { start, end } = window.RadarLoop.playback.domain();
    const target = Date.now() - h * 3600 * 1000;
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    slider.value = String(Math.round(((target - start) / (end - start)) * max));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, back);
  await page.waitForTimeout(8000);
  console.log(`${String(back).padStart(2)}h back:`, JSON.stringify(await sample()));
}
console.log('requests:', JSON.stringify(calls));
await browser.close();
