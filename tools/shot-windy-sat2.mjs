/**
 * Looks at a Windy `visir` tile every way it might be meant.
 *
 * The tile is 256x512 greyscale where a slippy map wants 256x256, and the two
 * halves are statistically different (roughness 10.5 against 3.2). Stretching the
 * contrast of each candidate is what makes the answer visible: a narrow-range
 * half looks flat at native contrast whether it is a picture or noise.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const tile = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 620 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const stats = await page.evaluate(async (url) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const src = document.createElement('canvas');
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const W = src.width;
  const H = src.height;
  const half = H / 2;
  const all = sctx.getImageData(0, 0, W, H).data;
  const at = (x, y) => all[(y * W + x) * 4];
  const alphaAt = (x, y) => all[(y * W + x) * 4 + 3];

  /** Builds a 256x256 panel from a per-pixel function, optionally stretched. */
  const panel = (fn, stretch) => {
    const vals = new Float32Array(256 * 256);
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const v = fn(x, y);
        vals[y * 256 + x] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const out = new ImageData(256, 256);
    const span = stretch && hi > lo ? 255 / (hi - lo) : 1;
    for (let i = 0; i < vals.length; i += 1) {
      const v = stretch ? (vals[i] - lo) * span : vals[i];
      out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
    }
    return out;
  };

  const panels = [
    ['top half, as-is', panel((x, y) => at(x, y), false)],
    ['top half, stretched', panel((x, y) => at(x, y), true)],
    ['bottom half, as-is', panel((x, y) => at(x, y + half), false)],
    ['bottom half, stretched', panel((x, y) => at(x, y + half), true)],
    ['top - bottom, stretched', panel((x, y) => at(x, y) - at(x, y + half) + 128, true)],
    ['top, odd pixels blanked', panel((x, y) => (((x + y) % 2) ? 128 : at(x, y)), false)],
  ];

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;gap:10px;padding:10px;z-index:99999;font:12px system-ui;color:#ddd';
  for (const [label, data] of panels) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    c.getContext('2d').putImageData(data, 0, 0);
    c.style.cssText = 'width:256px;height:256px;image-rendering:pixelated;border:1px solid #444';
    const box = document.createElement('div');
    box.append(c, Object.assign(document.createElement('div'), { textContent: label }));
    host.append(box);
  }
  document.body.append(host);

  // Is the checkerboard at 1px, and does alpha carry anything?
  let sameParity = 0;
  let crossParity = 0;
  let n = 0;
  let alphaMin = 255;
  let alphaMax = 0;
  for (let y = 1; y < half - 1; y += 1) {
    for (let x = 1; x < W - 2; x += 1) {
      sameParity += Math.abs(at(x, y) - at(x + 2, y));
      crossParity += Math.abs(at(x, y) - at(x + 1, y));
      n += 1;
      const a = alphaAt(x, y);
      if (a < alphaMin) alphaMin = a;
      if (a > alphaMax) alphaMax = a;
    }
  }
  return {
    size: [W, H],
    neighbourDiffSameParity: +(sameParity / n).toFixed(2),
    neighbourDiffCrossParity: +(crossParity / n).toFixed(2),
    alpha: [alphaMin, alphaMax],
  };
}, tile);

console.log(JSON.stringify(stats, null, 1));
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/windy-sat-candidates.png' });
console.log('written shots/windy-sat-candidates.png');
await browser.close();
