/** Why the station models draw nothing at the view the app opens on. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);

const look = async (label) => {
  const r = await page.evaluate(() => {
    const map = window.RadarLoop.map();
    const b = map.getBounds();
    const pane = map.getPane('synopticPane');
    const canvas = pane?.querySelector('canvas');
    let lit = 0;
    if (canvas?.width) {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 160) if (d[i] > 8) lit += 1;
    }
    return {
      zoom: map.getZoom(),
      centre: [+map.getCenter().lat.toFixed(2), +map.getCenter().lng.toFixed(2)],
      spanLon: +(b.getEast() - b.getWest()).toFixed(1),
      spanLat: +(b.getNorth() - b.getSouth()).toFixed(1),
      canvas: canvas ? [canvas.width, canvas.height] : null,
      lit,
      ...window.RadarLoop.observations(),
    };
  });
  console.log(`${label}: ${JSON.stringify(r)}`);
  return r;
};

await look('as opened');
await page.evaluate(() => window.RadarLoop.map().setView([53, -2], 6));
await page.waitForTimeout(7000);
await look('UK at z6');
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
