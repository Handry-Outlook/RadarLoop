/**
 * The satellite composite at a time the live endpoint no longer covers.
 *
 * Frames older than roughly sixteen hours are only served from the archive path,
 * and the archive keeps hourly frames only — so the layer has to switch endpoint
 * and snap the frame to the hour at the same time. This drives the timeline back
 * past that boundary and looks at what lands on the map.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const hoursBack = Number(process.argv[2] || 30);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
const requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => {
  if (r.url().includes('sat.windy.com')) requests.push({ archive: r.url().includes('/archive/'), status: r.status() });
});

await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.selectProduct('satellite', 'windy-visir');
  window.RadarLoop.setLayerEnabled('satellite', true);
  window.RadarLoop.map().setView([48, -8], 4);
});
await page.waitForTimeout(12000);
requests.length = 0;

const at = await page.evaluate((h) => {
  window.RadarLoop.playback.setHistorySpan(Math.ceil(h * 1.5));
  const target = Date.now() - h * 3600000;
  window.RadarLoop.playback.setTime(target, { immediate: true });
  return {
    asked: new Date(target).toISOString(),
    showing: new Date(window.RadarLoop.time.current).toISOString(),
  };
}, hoursBack);
await page.waitForTimeout(16000);

const live = requests.filter((r) => !r.archive);
const archive = requests.filter((r) => r.archive);
console.log(JSON.stringify({
  ...at,
  liveRequests: { total: live.length, ok: live.filter((r) => r.status === 200).length },
  archiveRequests: { total: archive.length, ok: archive.filter((r) => r.status === 200).length },
  painted: await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.windy-sat-tile canvas')].filter((t) => t.width > 0);
    let ink = 0;
    for (const t of tiles) {
      const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
      for (let i = 3; i < d.length; i += 400) if (d[i] > 8) ink += 1;
    }
    return { tiles: tiles.length, ink };
  }),
  errors: [...new Set(errors)],
}, null, 1));
await page.screenshot({ path: `shots/sat-archive-${hoursBack}h.png` });
await browser.close();
