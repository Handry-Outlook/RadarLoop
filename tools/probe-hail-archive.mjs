/**
 * Does the radar sampler reach a storm from two weeks ago?
 *
 * The layer draws archived echoes; the sampler was asking the live endpoint for
 * everything, which serves about two hours. So a scrubbed supercell measured
 * nothing and the projection had no reflectivity to call hail on.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const at = Date.parse(process.argv[2] || '2026-08-27T16:00:00Z');
const report = await page.evaluate(async ({ atMs, lat, lon }) => {
  const { measureMotion, hailRisk } = window.__nowcast;
  const m = await measureMotion(lat, lon, atMs);
  if (!m) return { measured: false };
  return {
    measured: true,
    peakDbz: Math.round(m.peakDbz),
    coverage: +(m.coverage * 100).toFixed(1),
    hailArea: +(m.hailArea * 100).toFixed(2),
    largeHailArea: +(m.largeHailArea * 100).toFixed(3),
    quality: +m.quality.toFixed(2),
    speed: +m.speedKmH.toFixed(0),
    direction: Math.round(m.directionDeg),
    // What that would be called at a plausible supercell flash rate.
    at6: hailRisk({ flashesPerMinute: 6, peakDbz: m.peakDbz, largeHailArea: m.largeHailArea }),
    at20: hailRisk({ flashesPerMinute: 20, peakDbz: m.peakDbz, largeHailArea: m.largeHailArea }),
  };
}, { atMs: at, lat: 51.75, lon: -0.75 });

console.log(new Date(at).toISOString(), JSON.stringify(report, null, 1));
await browser.close();
