/** What the existing strike archive actually covers, in time and in space. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

const report = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  if (!all.length) return { loaded: 0 };
  let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
  const months = new Map();
  const step = Math.max(1, Math.floor(all.length / 60000));
  for (let i = 0; i < all.length; i += step) {
    const s = all[i];
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
    const d = new Date(s.ms);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.set(k, (months.get(k) || 0) + 1);
  }
  return {
    loaded: all.length,
    from: new Date(all[0].ms).toISOString().slice(0, 10),
    to: new Date(all[all.length - 1].ms).toISOString().slice(0, 10),
    lat: [+minLat.toFixed(1), +maxLat.toFixed(1)],
    lon: [+minLon.toFixed(1), +maxLon.toFixed(1)],
    months: [...months.entries()].sort(),
  };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
