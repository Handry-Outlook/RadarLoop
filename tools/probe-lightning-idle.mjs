/** Is the strike layer redrawing when nothing is happening? */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
  window.RadarLoop.setLayerEnabled('lightning', true);
  window.RadarLoop.lightning.lifespanHours = 3;
  window.RadarLoop.map().setView([20, 10], 3);
});
await page.waitForTimeout(25000);

const idle = await page.evaluate(async () => {
  const layer = window.RadarLoop.slots.get('lightning').front;
  let renders = 0;
  const real = layer._render.bind(layer);
  layer._render = function counted() { renders += 1; return real(); };
  let frames = 0;
  const tick = () => { frames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, 4000));
  return { rendersIn4s: renders, animationFramesIn4s: frames, feed: window.__windyLightning.feedStats };
});
console.log(JSON.stringify(idle, null, 1));
await browser.close();
