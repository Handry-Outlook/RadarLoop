/**
 * What peak reflectivity this radar composite actually reaches.
 *
 * The hail thresholds were taken from the textbook — 50 dBZ for hail, 60 for
 * large — which assume a native radar. This is a global mosaic, smoothed and
 * resampled, and if it tops out below those numbers no storm will ever clear
 * them. So the scale wants setting from what the data does, not from what a
 * radar ought to do.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const out = await page.evaluate(async () => {
  const { measureMotion } = window.__nowcast;
  // A spread of convective places; whichever have storms right now will answer.
  const spots = [
    ['UK', 52, -1.5], ['Alps', 45.8, 9], ['Iberia', 40, -4],
    ['US plains', 35, -97], ['Florida', 28, -82], ['Amazon', -3, -60],
    ['Argentina', -31, -61], ['Congo', -2, 22], ['Sahel', 12, 5],
    ['India', 21, 79], ['Indonesia', -2, 113], ['Queensland', -20, 145],
  ];
  const rows = [];
  for (const [name, lat, lon] of spots) {
    // eslint-disable-next-line no-await-in-loop
    const m = await measureMotion(lat, lon, Date.now());
    if (!m) continue;
    rows.push({
      name,
      peak: m.peakDbz,
      conv: +(m.coverage * 100).toFixed(2),
      hail50: +(m.hailArea * 1000).toFixed(2),
      large60: +(m.largeHailArea * 1000).toFixed(2),
      quality: +m.quality.toFixed(2),
    });
  }
  return rows;
});
console.log('  place        peak dBZ   conv%   >=50 (per mille)   >=60   motion q');
for (const r of out) {
  console.log(`  ${r.name.padEnd(12)} ${String(r.peak).padStart(5)}  ${String(r.conv).padStart(7)}  ${String(r.hail50).padStart(10)}  ${String(r.large60).padStart(8)}  ${r.quality}`);
}
console.log(`\npeak seen anywhere: ${Math.max(...out.map((r) => r.peak), 0)}`);
await browser.close();
