/**
 * What the two halves of a Windy `visir` tile actually contain.
 *
 * The tile is 256x512 8-bit greyscale — one tile's width, two tiles' height —
 * which is not a shape any slippy-map client expects, so the arrangement has to
 * be worked out before the layer can draw it.
 */
import { chromium } from 'playwright';

const tile = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async (url) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const at = (x, y) => data[(y * c.width + x) * 4];

  const half = c.height / 2;
  const stats = (y0, y1) => {
    let min = 255;
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const v = at(x, y);
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
        n += 1;
      }
    }
    return { min, max, mean: +(sum / n).toFixed(1) };
  };

  /** Mean absolute difference between neighbouring pixels — texture, roughly. */
  const roughness = (y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1 - 1; y += 1) {
      for (let x = 0; x < c.width - 1; x += 1) {
        sum += Math.abs(at(x, y) - at(x + 1, y));
        n += 1;
      }
    }
    return +(sum / n).toFixed(2);
  };

  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0; let syy = 0; let n = 0;
  for (let y = 0; y < half; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const a = at(x, y);
      const b = at(x, y + half);
      n += 1; sx += a; sy += b; sxy += a * b; sxx += a * a; syy += b * b;
    }
  }
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));

  return {
    size: [c.width, c.height],
    top: { ...stats(0, half), roughness: roughness(0, half) },
    bottom: { ...stats(half, c.height), roughness: roughness(half, c.height) },
    correlation: den ? +((n * sxy - sx * sy) / den).toFixed(3) : null,
  };
}, tile);

console.log(JSON.stringify(report, null, 1));
await browser.close();
