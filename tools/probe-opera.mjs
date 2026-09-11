import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

await page.evaluate(async () => {
  window.RadarLoop.selectProduct('radar', 'opera-dbzh');
  await new Promise((r) => setTimeout(r, 14000));
});

// Find a busy spot in the grid so the crop has weather in it.
const spot = await page.evaluate(() => {
  const layer = [...Object.values(window.RadarLoop.map()._layers)].find((l) => l._isOperaLayer);
  if (!layer) return null;
  const { _values: v, _sw: sw, _sh: sh } = layer;
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 8; y < sh - 8; y += 16) {
    for (let x = 8; x < sw - 8; x += 16) {
      let score = 0;
      for (let j = -8; j <= 8; j += 2) for (let i = -8; i <= 8; i += 2) {
        const e = v[(y + j) * sw + (x + i)];
        if (e !== 255 && e > 80) score += e;
      }
      if (score > best.score) best = { x, y, score };
    }
  }
  const [minX, minY, maxX, maxY] = layer._extent;
  const px = minX + ((best.x + 0.5) / sw) * (maxX - minX);
  const py = maxY - ((best.y + 0.5) / sh) * (maxY - minY);
  const [lon, lat] = proj4(layer._projection, 'EPSG:4326', [px, py]);
  return { lat, lon, score: best.score };
});
console.log('busiest spot', JSON.stringify(spot));

for (const smooth of [false, true]) {
  await page.evaluate(async ({ smooth, spot }) => {
    window.__radarScale.setSmoothing(smooth);
    window.RadarLoop.map().setView([spot.lat, spot.lon], 10);
    await new Promise((r) => setTimeout(r, 2000));
    window.RadarLoop.renderAll(window.RadarLoop.time.current);
    await new Promise((r) => setTimeout(r, 5000));
  }, { smooth, spot });
  await page.screenshot({ path: `shots/opera-smooth-${smooth ? 'on' : 'off'}.png`,
    clip: { x: 450, y: 280, width: 420, height: 320 } });
}
await browser.close();
console.log('shots written');
