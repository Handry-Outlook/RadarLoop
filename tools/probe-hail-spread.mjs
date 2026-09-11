/**
 * Does the intensity reading tell one storm from its neighbours?
 *
 * Read over the whole correlation window it did not: every cluster within a
 * hundred kilometres of a supercell reported the supercell's core. This measures
 * each cluster's own position and prints what the hail scale makes of it.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
await page.waitForFunction(() => {
  const n = window.RadarLoop?.lightningAll?.().length ?? 0;
  const settled = n > 0 && n === window.__lastCount;
  window.__lastCount = n;
  return settled;
}, { timeout: 90000, polling: 3000 });

const at = Date.parse(process.argv[2] || '2026-08-27T16:20:00Z');
const report = await page.evaluate(async (atMs) => {
  const { calculateNowcast, resetNowcastHistory, resetRadarHints, measureMotion, hailRisk } = window.__nowcast;
  const all = window.RadarLoop.lightningAll();
  const window2h = all.filter((s) => s.ms > atMs - 2 * 3600000 && s.ms <= atMs);
  resetRadarHints();
  resetNowcastHistory();
  const clusters = calculateNowcast(window2h, new Date(atMs));

  const out = [];
  for (const c of clusters) {
    // eslint-disable-next-line no-await-in-loop
    const m = await measureMotion(c.baseLat, c.baseLon, atMs);
    const verdict = m ? hailRisk({
      flashesPerMinute: c.flashesPerMinute,
      peakDbz: m.peakDbz,
      largeHailArea: m.largeHailArea,
    }) : null;
    out.push({
      size: c.clusterSize,
      rate: +c.flashesPerMinute.toFixed(1),
      at: [+c.baseLat.toFixed(2), +c.baseLon.toFixed(2)],
      peakDbz: m ? Math.round(m.peakDbz) : null,
      bigCore: m ? +(m.largeHailArea * 100).toFixed(2) : null,
      risk: verdict ? +verdict.risk.toFixed(2) : null,
      label: verdict ? verdict.label : null,
      speed: Math.round(c.speedKmH),
      dir: Math.round(c.directionDeg),
      motion: c.motionSource,
      impact: c.impact.level,
    });
  }
  return out;
}, at);

console.log('  size  rate/min   peak dBZ  >=60 %   risk  verdict            speed  dir  motion');
for (const r of report) {
  console.log(`  ${String(r.size).padStart(4)}  ${String(r.rate).padStart(8)}   ${String(r.peakDbz ?? '—').padStart(8)}  ${String(r.bigCore ?? '—').padStart(6)}  ${String(r.risk ?? '—').padStart(5)}  ${String(r.label ?? '—').padEnd(18)} ${String(r.speed).padStart(5)}  ${String(r.dir).padStart(3)}  ${r.motion}`);
}
await browser.close();
