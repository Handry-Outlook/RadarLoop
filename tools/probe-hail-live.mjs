/**
 * What the hail estimate sees, cluster by cluster, on live data.
 *
 * A storm with an obviously intense core and frequent lightning is not being
 * called hail, so the question is which of the three terms is failing: the
 * reflectivity it measured, the flash rate it computed, or the thresholds.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(14000);

const report = await page.evaluate(async () => {
  const l = window.RadarLoop.lightning;
  const horizon = Date.now() - 11 * 3600000;
  const hours = new Map();
  for (const s of l.all) {
    if (s.ms < horizon) continue;
    const h = Math.floor(s.ms / 3600000);
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const ranked = [...hours.entries()].sort((a, b) => b[1] - a[1]);
  const at = ranked.length ? ranked[0][0] * 3600000 + 3600000 : Date.now();
  const recent = l.all.filter((s) => s.ms > at - 3 * 3600000 && s.ms <= at);
  const clusters = window.RadarLoop.nowcastClusters?.() ?? [];

  // And a direct reading of the radar wherever the strikes are densest.
  const { measureMotion, hailRisk } = window.__nowcast;
  const cells = new Map();
  for (const s of recent) {
    const key = `${Math.round(s.lat * 2)}|${Math.round(s.lon * 2)}`;
    const c = cells.get(key) || { lat: 0, lon: 0, n: 0 };
    c.lat += s.lat; c.lon += s.lon; c.n += 1;
    cells.set(key, c);
  }
  const busiest = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 4);
  const direct = [];
  for (const cell of busiest) {
    const lat = cell.lat / cell.n;
    const lon = cell.lon / cell.n;
    // eslint-disable-next-line no-await-in-loop
    const m = await measureMotion(lat, lon, at);
    const ratePerMin = cell.n / 180;
    direct.push({
      at: [+lat.toFixed(1), +lon.toFixed(1)],
      strikes3h: cell.n,
      ratePerMin: +ratePerMin.toFixed(2),
      peakDbz: m ? Math.round(m.peakDbz) : null,
      coverage: m ? +(m.coverage * 100).toFixed(1) : null,
      hailArea: m ? +(m.hailArea * 100).toFixed(2) : null,
      largeHailArea: m ? +(m.largeHailArea * 100).toFixed(3) : null,
      quality: m ? +m.quality.toFixed(2) : null,
      verdict: m ? hailRisk({ flashesPerMinute: ratePerMin, peakDbz: m.peakDbz, largeHailArea: m.largeHailArea }) : null,
    });
  }

  return {
    measuredAt: new Date(at).toISOString(),
    strikesLast3h: recent.length,
    clusters: clusters.map((c) => ({
      size: c.clusterSize,
      rate: +c.flashesPerMinute.toFixed(1),
      peakDbz: c.peakDbz === null ? null : Math.round(c.peakDbz),
      hail: c.hail ? `${c.hail.label} (${c.hail.risk.toFixed(2)})` : null,
      level: c.impact.level,
    })),
    direct,
  };
});
console.log(JSON.stringify(report, null, 1));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
