/**
 * Is the 16px checkerboard in a Windy `visir` tile a per-block offset?
 *
 * The halves look like one smooth picture with alternating light and dark 16px
 * blocks laid over it. If the block mean is the thing that alternates, removing
 * each block's own mean should leave a seamless image — and the smooth bottom
 * half is then the obvious candidate for the low-frequency part that was taken
 * out. These panels test both halves of that idea at once.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const tile = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async (url) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const src = document.createElement('canvas');
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const W = src.width;
  const all = sctx.getImageData(0, 0, W, src.height).data;
  const half = src.height / 2;
  const at = (x, y) => all[(y * W + x) * 4];

  /** Mean of the BLOCK-sized cell containing (x, y) in the given half. */
  const blockMean = (yOff, block) => {
    const n = 256 / block;
    const means = new Float32Array(n * n);
    for (let by = 0; by < n; by += 1) {
      for (let bx = 0; bx < n; bx += 1) {
        let sum = 0;
        for (let y = 0; y < block; y += 1) {
          for (let x = 0; x < block; x += 1) sum += at(bx * block + x, yOff + by * block + y);
        }
        means[by * n + bx] = sum / (block * block);
      }
    }
    return { means, n, block };
  };

  const topBlocks = blockMean(0, 16);
  const mean16 = (m, x, y) => m.means[Math.floor(y / m.block) * m.n + Math.floor(x / m.block)];

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
    ['top, block mean removed', panel((x, y) => at(x, y) - mean16(topBlocks, x, y) + 128, true)],
    ['bottom + top detail', panel((x, y) => at(x, y + half) + (at(x, y) - mean16(topBlocks, x, y)), true)],
    ['block means of top (16x)', panel((x, y) => mean16(topBlocks, x, y), true)],

  ];

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;gap:10px;padding:10px;z-index:99999;font:12px system-ui;color:#ddd';
  for (const [label, data] of panels) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    c.getContext('2d').putImageData(data, 0, 0);
    c.style.cssText = 'width:384px;height:384px;image-rendering:pixelated;border:1px solid #444';
    const box = document.createElement('div');
    box.append(c, Object.assign(document.createElement('div'), { textContent: label }));
    host.append(box);
  }
  document.body.append(host);

  // Do the 16px block means actually alternate in a checker pattern?
  const m = topBlocks.means;
  let even = 0;
  let odd = 0;
  for (let by = 0; by < topBlocks.n; by += 1) {
    for (let bx = 0; bx < topBlocks.n; bx += 1) {
      if ((bx + by) % 2) odd += m[by * topBlocks.n + bx];
      else even += m[by * topBlocks.n + bx];
    }
  }
  const cells = (topBlocks.n * topBlocks.n) / 2;
  return { evenBlockMean: +(even / cells).toFixed(1), oddBlockMean: +(odd / cells).toFixed(1) };
}, tile);

console.log(JSON.stringify(report));
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/windy-sat-blocks.png' });
console.log('written shots/windy-sat-blocks.png');
await browser.close();
