/**
 * Both polarities of the same tile, over a coastline.
 *
 * Tile z5/15/13 holds the Atlantic coast of the western Sahara: bare desert on
 * one side, open ocean on the other, and a coastline between them that no cloud
 * field imitates. In a visible image the desert is the brightest thing in frame
 * and the sea is nearly the darkest, so one of these two renderings is obviously
 * right and the other is obviously a negative.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 760 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(async ({ b, q }) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;flex-wrap:wrap;gap:8px;padding:8px;z-index:99999;font:12px system-ui;color:#ddd';
  document.body.append(host);

  for (const [z, x, y] of [[5, 15, 13]]) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `${b}/${z}/${x}/${y}/visir.png${q}`; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, c.width, c.height).data;
    const half = c.height / 2;

    for (const invertOdd of [true, false]) {
      for (const [name, yOff] of [['top', 0], ['bottom', half]]) {
        const out = new ImageData(c.width, half);
        for (let py = 0; py < half; py += 1) {
          for (let px = 0; px < c.width; px += 1) {
            const odd = ((((px / 16) | 0) + (((py + yOff) / 16) | 0)) % 2) === 1;
            const v0 = raw[((py + yOff) * c.width + px) * 4];
            const v = (odd === invertOdd) ? 255 - v0 : v0;
            const i = (py * c.width + px) * 4;
            out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
          }
        }
        const view = document.createElement('canvas');
        view.width = c.width;
        view.height = half;
        view.getContext('2d').putImageData(out, 0, 0);
        view.style.cssText = 'width:330px;height:330px;image-rendering:pixelated;border:1px solid #444';
        const box = document.createElement('div');
        box.append(view, Object.assign(document.createElement('div'), {
          textContent: `${name} half, invert ${invertOdd ? 'odd' : 'even'} blocks`,
        }));
        host.append(box);
      }
    }
  }
}, { b: base, q: query });

await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/windy-sat-polarity.png' });
console.log('written shots/windy-sat-polarity.png');
await browser.close();
