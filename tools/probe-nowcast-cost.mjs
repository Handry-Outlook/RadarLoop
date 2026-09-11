/**
 * What the nowcast costs, and which part of it.
 *
 * The input budget went from 700 strikes to 6000 and the clustering gained a
 * second pass and a splitting step, so there are several candidates. Timing them
 * separately is the only way to know which one to fix.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const report = await page.evaluate(async () => {
  const { calculateNowcast, resetNowcastHistory, resetRadarHints, seedRadarHint } = window.__nowcast;
  const all = window.RadarLoop.lightningAll();
  const hours = new Map();
  for (const s of all) hours.set(Math.floor(s.ms / 3600000), (hours.get(Math.floor(s.ms / 3600000)) || 0) + 1);
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  const end = hour * 3600000 + 3600000;
  const window3h = all.filter((s) => s.ms > end - 3 * 3600000 && s.ms <= end);

  const time = (label, fn) => {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      resetNowcastHistory();
      const at = performance.now();
      fn();
      runs.push(performance.now() - at);
    }
    return { label, median: +runs.sort((a, b) => a - b)[1].toFixed(1), runs: runs.map((n) => +n.toFixed(0)) };
  };

  // Without radar: the two-pass path, which is what most runs take.
  resetRadarHints();
  const twoPass = time('no radar (two clustering passes)', () =>
    calculateNowcast(window3h, new Date(end + Math.random())));

  // With radar seeded: one clustering pass.
  let lat = 0;
  let lon = 0;
  for (const s of window3h) { lat += s.lat; lon += s.lon; }
  const onePass = time('radar seeded (one pass)', () => {
    resetRadarHints();
    for (let la = 48; la <= 62; la += 0.2) {
      for (let lo = -12; lo <= 8; lo += 0.2) {
        seedRadarHint(la, lo, { speedKmH: 45, directionDeg: 60, quality: 0.6, trend: 1, peakDbz: 50 }, end);
      }
    }
    calculateNowcast(window3h, new Date(end + Math.random()));
  });

  return { strikes: window3h.length, twoPass, onePass };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
