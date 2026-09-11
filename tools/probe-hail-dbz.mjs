/**
 * What peak reflectivity this composite actually reports over storms.
 *
 * The hail thresholds were taken from the single-polarisation textbook — 50 dBZ
 * worth mentioning, 60 likely large. Those assume a native radar. This is a
 * global mosaic, quantised into a byte and resampled, and if it does not reach
 * those numbers then the thresholds can never fire however severe the storm.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const report = await page.evaluate(async () => {
  const { measureMotion } = window.__nowcast;
  // Where the live feed says it is flashing hardest, inside radar coverage.
  const payload = await (await fetch('https://node.windy.com/blitz/v3/hot', { cache: 'no-store' })).json();
  const G = 1 << 18;
  const strikes = payload.hotQueue.values.map((r) => ({
    lat: (r[2] / G) * 180 - 90,
    lon: (r[1] / G) * 360 - 180,
  }));

  // Half-degree cells, busiest first, restricted to where this radar has data.
  const inCoverage = (lat, lon) =>
    (lat > 35 && lat < 70 && lon > -12 && lon < 35)
    || (lat > 24 && lat < 52 && lon > -126 && lon < -66)
    || (lat > -45 && lat < -10 && lon > 112 && lon < 155)
    || (lat > 30 && lat < 46 && lon > 128 && lon < 146);
  const cells = new Map();
  for (const s of strikes) {
    if (!inCoverage(s.lat, s.lon)) continue;
    const key = `${Math.round(s.lat * 2)}|${Math.round(s.lon * 2)}`;
    const cell = cells.get(key) || { lat: 0, lon: 0, n: 0 };
    cell.lat += s.lat; cell.lon += s.lon; cell.n += 1;
    cells.set(key, cell);
  }
  const busiest = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 8);

  const out = [];
  for (const cell of busiest) {
    const lat = cell.lat / cell.n;
    const lon = cell.lon / cell.n;
    // eslint-disable-next-line no-await-in-loop
    const measured = await measureMotion(lat, lon, Date.now());
    out.push({
      at: [+lat.toFixed(1), +lon.toFixed(1)],
      strikes: cell.n,
      peakDbz: measured ? Math.round(measured.peakDbz) : null,
      hailArea: measured ? +(measured.hailArea * 100).toFixed(2) : null,
      largeHailArea: measured ? +(measured.largeHailArea * 100).toFixed(3) : null,
      coverage: measured ? +(measured.coverage * 100).toFixed(1) : null,
    });
  }
  return { cellsFound: cells.size, out };
});

console.log(`busiest lightning cells inside radar coverage: ${report.cellsFound}`);
console.log('\n  position          strikes  peak dBZ  >=50 dBZ %  >=60 dBZ %  convective %');
for (const r of report.out) {
  console.log(`  ${String(r.at).padEnd(16)} ${String(r.strikes).padStart(6)}  ${String(r.peakDbz).padStart(8)}  ${String(r.hailArea).padStart(10)}  ${String(r.largeHailArea).padStart(10)}  ${String(r.coverage).padStart(12)}`);
}
await browser.close();
