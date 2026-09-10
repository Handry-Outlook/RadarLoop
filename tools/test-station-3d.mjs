/**
 * A station card opened from the GL view.
 *
 * The plots reach 3D as a captured picture, so nothing there can be hit-tested
 * and Leaflet never sees the click; the card has to be opened from the GL map's
 * own click, against projected station positions. This checks that a click on a
 * plotted station opens the card, that the card carries its charts, and that the
 * picker offers more than one.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.map().setView([52.5, -1.5], 7);
});
await page.waitForTimeout(5000);
await page.click('#btn-3d');
await page.waitForTimeout(15000);

// Click where a plotted station actually projects to on the GL canvas.
const target = await page.evaluate(() => {
  const gl = window.RadarLoop.gl();
  const size = gl.getCanvas();
  const middle = { x: size.clientWidth / 2, y: size.clientHeight / 2 };
  let best = null;
  let bestD = Infinity;
  for (const s of window.RadarLoop.plottedStations()) {
    const p = gl.project([s.lon, s.lat]);
    if (p.x < 80 || p.y < 80 || p.x > size.clientWidth - 80 || p.y > size.clientHeight - 80) continue;
    const d = Math.hypot(p.x - middle.x, p.y - middle.y);
    if (d < bestD) { bestD = d; best = { id: s.id, x: p.x, y: p.y }; }
  }
  return best;
});
console.log(`target: ${JSON.stringify(target)}`);
if (!target) throw new Error('no station projected into the GL view');

const box = await page.locator('#map-3d').boundingBox();
await page.mouse.click(box.x + target.x, box.y + target.y);
await page.waitForTimeout(7000);

const card = await page.evaluate(() => {
  const shell = document.querySelector('.mapboxgl-popup .wxcard');
  if (!shell) return { opened: false };
  return {
    opened: true,
    name: shell.querySelector('.wxcard__name')?.textContent,
    charts: shell.querySelectorAll('svg.wxchart').length,
    options: [...shell.querySelectorAll('.wxcard__pick option')].map((o) => o.textContent),
    readings: shell.querySelectorAll('.wxcard__reading').length,
  };
});
console.log(JSON.stringify(card, null, 1));
await page.screenshot({ path: 'shots/station-card-3d.png' });
console.log(JSON.stringify({ errors: [...new Set(errors)] }));

await browser.close();
process.exit(card.opened && card.charts === 1 && card.options.length > 1 && !errors.length ? 0 : 1);
