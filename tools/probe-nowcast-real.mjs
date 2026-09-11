/**
 * What the nowcast does on a real convective day.
 *
 * The synthetic checks pass, so whatever is wrong is not in the cases they
 * describe. This drives the archive instead: find the busiest hour in the
 * eighteen months of stored strikes, put the timeline there, and report what
 * the clustering actually produced against what the strikes actually look like.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(14000);

const busiest = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  if (!all.length) return null;
  // Strikes per hour, over the whole archive.
  const hours = new Map();
  for (const s of all) {
    const h = Math.floor(s.ms / 3600000);
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const [hour, count] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  return { at: hour * 3600000, count, iso: new Date(hour * 3600000).toISOString() };
});
console.log(`busiest hour: ${JSON.stringify(busiest)}`);

const report = await page.evaluate(async (at) => {
  const { calculateNowcast, resetNowcastHistory, resetRadarHints } = window.__nowcast;
  const all = window.RadarLoop.lightningAll();
  const end = at + 3600000;
  const window3h = all.filter((s) => s.ms > end - 3 * 3600000 && s.ms <= end);
  resetNowcastHistory();
  resetRadarHints();
  const clusters = calculateNowcast(window3h, new Date(end));

  // What the strikes themselves look like, for comparison.
  let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
  for (const s of window3h) {
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
  }
  return {
    internals: window.__nowcast.nowcastInternals(),
    strikes: window3h.length,
    extent: [[+minLat.toFixed(2), +minLon.toFixed(2)], [+maxLat.toFixed(2), +maxLon.toFixed(2)]],
    clusters: clusters.map((c) => ({
      // Largest dimension of the drawn footprint: a cell is tens of kilometres,
      // a merged system is hundreds.
      hullKm: (() => {
        const ring = c.hullGeometry?.geometry?.coordinates?.[0];
        if (!ring) return null;
        let max = 0;
        for (let i = 0; i < ring.length; i += 1) {
          for (let j = i + 1; j < ring.length; j += 1) {
            const dLat = (ring[i][1] - ring[j][1]) * 111;
            const dLon = (ring[i][0] - ring[j][0]) * 111 * Math.cos(ring[i][1] * Math.PI / 180);
            max = Math.max(max, Math.hypot(dLat, dLon));
          }
        }
        return Math.round(max);
      })(),
      size: c.clusterSize,
      at: [+c.baseLat.toFixed(2), +c.baseLon.toFixed(2)],
      dir: +c.directionDeg.toFixed(0),
      speed: +c.speedKmH.toFixed(0),
      conf: +c.confidence.toFixed(2),
      life: c.lifeMinutes,
      source: c.motionSource,
    })),
  };
}, busiest.at);
console.log('internals:', JSON.stringify(report.internals));
console.log('strikes:', report.strikes, 'extent:', JSON.stringify(report.extent));
console.log('clusters:', JSON.stringify(report.clusters));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
