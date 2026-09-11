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

  // Where the colour changes along each scanline, and how much those positions
  // line up on a regular lattice.
  const changes = () => {
    const c = document.querySelector('canvas.opera-radar-canvas');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const W = c.width; const H = c.height;
    const at = (x, y) => { const i = (y * W + x) * 4; return data[i + 3] < 8 ? -1 : data[i] * 65536 + data[i + 1] * 256 + data[i + 2]; };
    const xs = [];
    for (let y = 0; y < H; y += 1) for (let x = 1; x < W; x += 1) if (at(x, y) !== at(x - 1, y)) xs.push(x);
    return xs;
  };
  const lock = (xs, m) => {
    const bins = new Array(m).fill(0);
    for (const x of xs) bins[x % m] += 1;
    return +((Math.max(...bins) / xs.length) * m).toFixed(2);
  };

  const result = {};
  for (const smooth of [false, true]) {
    window.__radarScale.setSmoothing(smooth);
    window.RadarLoop.map().setView([lat, lon], 10);
    await new Promise((r) => setTimeout(r, 2500));
    window.RadarLoop.renderAll(window.RadarLoop.time.current);
    await new Promise((r) => setTimeout(r, 5000));
    result[smooth ? 'on' : 'off'] = changes();
  }
  // Calibrate the period on the unsmoothed picture, then score both with it.
  let period = 0; let bestLock = 0;
  for (let m = 3; m <= 24; m += 1) {
    const l = lock(result.off, m);
    if (l > bestLock) { bestLock = l; period = m; }
  }
  return {
    period,
    off: { changes: result.off.length, lock: lock(result.off, period) },
    on: { changes: result.on.length, lock: lock(result.on, period) },
  };
});
console.log(JSON.stringify(out));
await browser.close();
