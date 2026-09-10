/** Renders the two halves of a Windy `visir` tile side by side, plus candidates. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const tile = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1380, height: 420 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(async (url) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const src = document.createElement('canvas');
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const half = src.height / 2;
  const top = sctx.getImageData(0, 0, src.width, half);
  const bottom = sctx.getImageData(0, half, src.width, half);

  // If the checkerboard is block interleaving, taking only the even blocks and
  // only the odd blocks should each yield a coherent picture.
  const deinterleave = (src2, block, parity) => {
    const out = new ImageData(src2.width, src2.height);
    for (let y = 0; y < src2.height; y += 1) {
      for (let x = 0; x < src2.width; x += 1) {
        const cell = (Math.floor(x / block) + Math.floor(y / block)) % 2;
        const i = (y * src2.width + x) * 4;
        const v = cell === parity ? src2.data[i] : 128;
        out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
      }
    }
    return out;
  };

  const panels = [
    ['top half', null, top],
    ['top, even 16', null, deinterleave(top, 16, 0)],
    ['top, odd 16', null, deinterleave(top, 16, 1)],
    ['top, even 32', null, deinterleave(top, 32, 0)],
    ['top, odd 32', null, deinterleave(top, 32, 1)],
  ];

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;gap:12px;padding:12px;z-index:99999;font:12px system-ui;color:#ddd';
  for (const [label, fn, ready] of panels) {
    const out = document.createElement('canvas');
    out.width = src.width; out.height = half;
    const octx = out.getContext('2d');
    octx.putImageData(ready, 0, 0);
    const box = document.createElement('div');
    box.append(out, Object.assign(document.createElement('div'), { textContent: label }));
    host.append(box);
  }
  document.body.append(host);
}, tile);

await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/windy-sat-halves.png' });
console.log('written shots/windy-sat-halves.png');
await browser.close();
