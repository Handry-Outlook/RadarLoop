/**
 * What the deeper tile grid costs when scrubbing.
 *
 * Building real tiles past the provider's native zoom means a viewport holds
 * thirty of them at zoom 10 rather than two stretched ones, so a scrubbed frame
 * there now decodes as many tiles as a frame at zoom 7 always has.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

for (const zoom of [7, 10]) {
  for (const smooth of [false, true]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await page.evaluate(async ({ zoom, smooth }) => {
      window.__radarScale.setSmoothing(smooth);
      window.RadarLoop.selectProduct('radar', 'windy-radar');
      window.RadarLoop.setLayerEnabled('satellite', false);
      window.RadarLoop.map().setView([44.24, 19.94], zoom);
      await new Promise((r) => setTimeout(r, 14000));

      const idle = async () => {
        for (let i = 0; i < 400; i += 1) {
          if (window.RadarLoop.tileWorkers().inFlight === 0) return true;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => requestAnimationFrame(r));
        }
        return false;
      };

      const times = [];
      const before = window.RadarLoop.tileWorkers().decoded;
      for (let i = 1; i <= 5; i += 1) {
        await idle();
        const at = performance.now();
        window.RadarLoop.playback.setTime(Date.now() - i * 10 * 60000, { immediate: true });
        // Wait for the queue to fill, then drain.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 60));
        // eslint-disable-next-line no-await-in-loop
        await idle();
        times.push(Math.round(performance.now() - at));
      }
      return {
        tiles: document.querySelectorAll('canvas.windy-radar-tile').length,
        decoded: window.RadarLoop.tileWorkers().decoded - before,
        times,
      };
    }, { zoom, smooth });
    console.log(`z${zoom} smoothing ${smooth ? 'on ' : 'off'}  ${out.tiles} tiles, ${out.decoded} decoded  frames ${out.times.join(', ')} ms`);
  }
}
await browser.close();
