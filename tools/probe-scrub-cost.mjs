/** Attributes the cost of a scrubber step: 2D vs 3D, and where the time goes. */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
// Headless Chromium falls back to SwiftShader, so GL work is rasterised on the
// CPU and 3D timings there say more about the test runner than about the app.
// HEADED=1 runs on the real GPU.
const headed = process.env.HEADED === '1';
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// Count tile requests so network volume can be separated from mirror work.
let tileRequests = 0;
page.on('request', (r) => { if (/rdr\.windy\.com/.test(r.url())) tileRequests += 1; });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1000);
console.log('  renderer: ' + await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
}));
await page.waitForTimeout(10000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
});
await page.waitForTimeout(8000);

const measure = async (label, steps = 5) => {
  const before = tileRequests;
  const result = await page.evaluate(async (n) => {
    const slider = document.querySelector('.timeline__scrub .range');
    const out = [];
    let skipped = 0;

    // Only steps that actually change frame are timed. Two nearby slider
    // positions can resolve to the same 10-minute frame, in which case there is
    // no work to do and the old harness sat out its whole deadline — which is
    // where the "12 second stalls" in earlier runs came from.
    for (let i = 1; out.length < n && i < 60; i += 1) {
      const prevUrl = window.RadarLoop.slots.get('radar').lastUrl;
      const t0 = performance.now();
      slider.value = String(Number(slider.max) - i * 14);
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      const deadline = t0 + 20000;
      let changed = false;
      while (performance.now() < deadline) {
        const s = window.RadarLoop.slots.get('radar');
        if (s.lastUrl && s.lastUrl !== prevUrl && s.front) { changed = true; break; }
        // Nothing fetching and nothing changed: this position is the same frame.
        if (performance.now() - t0 > 1500 && !window.RadarLoop.tileWorkers().inFlight) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25));
      }

      if (changed) out.push({ ms: Math.round(performance.now() - t0), phases: window.RadarLoop.phases().radar });
      else skipped += 1;
    }
    return { out, skipped };
  }, steps);

  const timings = result.out;
  const tiles = tileRequests - before;
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`  ${label.padEnd(6)} median=${median}ms  tiles=${Math.round(tiles / (timings.length || 1))}/step  (${result.skipped} same-frame steps skipped)`);
  timings.forEach((t) => console.log(`         ${String(t.ms).padStart(6)}ms  phases=${JSON.stringify(t.phases)}`));
  return median;
};

console.log('\n=== cost of a scrubber step ===');
const twoD = await measure('2D');

await page.click('#btn-3d');
await page.waitForTimeout(12000);
const threeD = await measure('3D');

const stats = await page.evaluate(() => {
  const s = window.RadarLoop.mirrorStats();
  return { captured: s.captured, lastDrew: s.lastDrew, capture: s.lastCapture ? { w: s.lastCapture.width, h: s.lastCapture.height } : null };
});

console.log(`\n  mirror: ${JSON.stringify(stats)}`);
console.log(`  3D overhead over 2D: ${threeD - twoD}ms (${twoD ? ((threeD / twoD - 1) * 100).toFixed(0) : '?'}%)`);
console.log(threeD - twoD < 400
  ? '\n  => the cost is the frame fetch itself, not the 3D mirror'
  : '\n  => the 3D mirror is adding meaningful cost');

await browser.close();
