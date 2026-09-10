/**
 * The polarity rule, read off at several zooms.
 *
 * The two candidate decodes are exact negatives of one another, so no measure of
 * smoothness or seam continuity can separate them — the difference between two
 * pixels is the same either way. Only physics can: over the Atlantic coast of
 * the western Sahara the desert is the brightest thing a visible channel sees
 * and the open ocean is nearly the darkest, and in the infrared the baking sand
 * is the darkest and the cold cloud tops the brightest.
 *
 * Rendered here at several zooms and for both halves, because an earlier reading
 * at z3 and one at z5 disagreed.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1560, height: 1100 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.evaluate(async ({ b, q }) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px;z-index:99999;font:11px system-ui;color:#ddd';
  document.body.append(host);

  // The same patch of the western Sahara coast, at four zooms.
  for (const [z, x, y] of [[3, 3, 3], [4, 7, 6], [5, 15, 13], [6, 31, 26]]) {
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

    for (const [name, yOff] of [['VIS?', 0], ['IR?', half]]) {
      for (const invertOdd of [true, false]) {
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
        view.style.cssText = 'width:100%;image-rendering:pixelated;border:1px solid #444';
        const box = document.createElement('div');
        box.append(view, Object.assign(document.createElement('div'), {
          textContent: `z${z} ${name} invert ${invertOdd ? 'odd' : 'even'}`,
        }));
        host.append(box);
      }
    }
  }
}, { b: base, q: query });

await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/windy-sat-zoomparity.png' });
console.log('written shots/windy-sat-zoomparity.png');
await browser.close();
