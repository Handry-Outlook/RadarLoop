import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(async () => {
  window.RadarLoop.selectProduct('radar', 'opera-dbzh');
  await new Promise((r) => setTimeout(r, 14000));
});
const out = await page.evaluate(async () => {
  const layer = [...Object.values(window.RadarLoop.map()._layers)].find((l) => l._isOperaLayer);
  const { _values: v, _sw: sw, _sh: sh } = layer;
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 8; y < sh - 8; y += 16) for (let x = 8; x < sw - 8; x += 16) {
    let score = 0;
    for (let j = -8; j <= 8; j += 2) for (let i = -8; i <= 8; i += 2) {
      const e = v[(y + j) * sw + (x + i)];
      if (e !== 255 && e > 80) score += e;
    }
    if (score > best.score) best = { x, y, score };
  }
  const [minX, minY, maxX, maxY] = layer._extent;
  const px = minX + ((best.x + 0.5) / sw) * (maxX - minX);
  const py = maxY - ((best.y + 0.5) / sh) * (maxY - minY);
  const [lon, lat] = proj4(layer._projection, 'EPSG:4326', [px, py]);

  const read = () => {
    const c = document.querySelector('canvas.opera-radar-canvas');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const W = c.width; const H = c.height;
    const at = (x, y) => { const i = (y * W + x) * 4; return data[i + 3] < 8 ? -1 : data[i] * 65536 + data[i + 1] * 256 + data[i + 2]; };
    const thresholds = [6, 8, 12, 16, 24];
    let boundary = 0;
    const straight = Object.fromEntries(thresholds.map((t) => [t, 0]));
    for (let y = 0; y < H - 1; y += 1) {
      let run = 0;
      for (let x = 0; x < W; x += 1) {
        if (at(x, y) !== at(x, y + 1)) { boundary += 1; run += 1; continue; }
        for (const t of thresholds) if (run >= t) straight[t] += run;
        run = 0;
      }
      for (const t of thresholds) if (run >= t) straight[t] += run;
    }
    return { W, H, boundary, share: Object.fromEntries(thresholds.map((t) => [t, +(straight[t] / Math.max(1, boundary)).toFixed(3)])) };
  };

  const result = {};
  for (const smooth of [false, true]) {
    window.__radarScale.setSmoothing(smooth);
    window.RadarLoop.map().setView([lat, lon], 10);
    await new Promise((r) => setTimeout(r, 2500));
    window.RadarLoop.renderAll(window.RadarLoop.time.current);
    await new Promise((r) => setTimeout(r, 5000));
    result[smooth ? 'on' : 'off'] = read();
  }
  return result;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
