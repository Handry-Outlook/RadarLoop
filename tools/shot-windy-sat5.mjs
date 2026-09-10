/**
 * Confirms the Windy `visir` decode: every other 16px block is inverted.
 *
 * The giveaway was a tile with an empty quadrant, where the checkerboard rendered
 * as pure black against pure white — the two ways a value of zero can appear if
 * alternate blocks carry `255 - v`. Undoing that should turn structured noise
 * into cloud.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1080 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(async ({ b, q }) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;flex-wrap:wrap;gap:8px;padding:8px;z-index:99999;font:12px system-ui;color:#ddd';
  document.body.append(host);

  for (const [z, x, y] of [[2, 1, 1], [3, 3, 2], [6, 31, 19]]) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `${b}/${z}/${x}/${y}/visir.png${q}`; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const half = c.height / 2;

    for (const [name, yOff] of [['top', 0], ['bottom', half]]) {
      const px = ctx.getImageData(0, yOff, c.width, half);
      const d = px.data;
      for (let py = 0; py < half; py += 1) {
        for (let pxx = 0; pxx < c.width; pxx += 1) {
          if (((Math.floor(pxx / 16) + Math.floor((py + yOff) / 16)) % 2) === 0) continue;
          const i = (py * c.width + pxx) * 4;
          d[i] = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
      }
      const view = document.createElement('canvas');
      view.width = c.width;
      view.height = half;
      view.getContext('2d').putImageData(px, 0, 0);
      view.style.cssText = 'width:300px;height:300px;image-rendering:pixelated;border:1px solid #444';
      const box = document.createElement('div');
      box.append(view, Object.assign(document.createElement('div'), { textContent: `z${z}/${x}/${y} ${name}, de-inverted` }));
      host.append(box);
    }
  }
}, { b: base, q: query });

await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/windy-sat-decoded.png' });
console.log('written shots/windy-sat-decoded.png');
await browser.close();
