/**
 * What playback actually does per frame.
 *
 * The loop schedules the next step on a timer without waiting for the current
 * frame to reach the screen, so the interesting numbers are how often a step is
 * dropped for one already in flight, and how far the displayed frame lags the
 * clock the loop is driving.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let tiles = 0;
page.on('request', (r) => { if (r.resourceType() === 'image') tiles += 1; });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(9000);

for (const speed of [1, 2, 4]) {
  const before = tiles;
  const result = await page.evaluate(async (s) => {
    window.RadarLoop.time.speed = s;
    const seen = [];
    const start = performance.now();
    let lastUrl = window.RadarLoop.slots.get('radar').lastUrl;

    window.RadarLoop.playback.play();
    const poll = setInterval(() => {
      const slot = window.RadarLoop.slots.get('radar');
      if (slot.lastUrl && slot.lastUrl !== lastUrl) {
        seen.push(Math.round(performance.now() - start));
        lastUrl = slot.lastUrl;
      }
    }, 15);

    await new Promise((r) => setTimeout(r, 12000));
    clearInterval(poll);
    window.RadarLoop.playback.stop();

    const gaps = seen.slice(1).map((t, i) => t - seen[i]);
    gaps.sort((a, b) => a - b);
    return {
      frames: seen.length,
      medianGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      worstGap: gaps.length ? gaps[gaps.length - 1] : null,
      skipped: window.RadarLoop.runtime.stats.skippedFrames,
    };
  }, speed);

  const wanted = Math.round(12000 / (1000 / speed));
  console.log(
    `speed ${speed}x  wanted ~${String(wanted).padStart(2)} frames, drew ${String(result.frames).padStart(2)}`
    + `  median gap ${String(result.medianGap).padStart(5)}ms  worst ${String(result.worstGap).padStart(5)}ms`
    + `  tiles ${tiles - before}`,
  );
  await page.waitForTimeout(2500);
}
await browser.close();
