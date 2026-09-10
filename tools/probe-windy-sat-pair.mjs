/**
 * Does a Windy `visir` tile pack two map rows, or two channels?
 *
 * If it is two rows, the bottom half of tile (x, y) is the same picture as the
 * top half of tile (x, y+1). If it is two channels of one row, it will not be.
 * One comparison settles it.
 */
import { chromium } from 'playwright';

const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async ({ b, q }) => {
  const grab = async (url) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };

  const a = await grab(`${b}/6/31/19/visir.png${q}`);
  const below = await grab(`${b}/6/31/20/visir.png${q}`);
  const right = await grab(`${b}/6/32/19/visir.png${q}`);

  /** Mean absolute difference between two equally sized regions. */
  const compare = (A, aY, B, bY, rows) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < A.w; x += 1) {
        sum += Math.abs(A.data[((aY + y) * A.w + x) * 4] - B.data[((bY + y) * B.w + x) * 4]);
        n += 1;
      }
    }
    return +(sum / n).toFixed(2);
  };

  const half = a.h / 2;
  return {
    size: [a.w, a.h],
    // The question: is (31,19)'s lower half the same as (31,20)'s upper half?
    bottomOfThisVsTopOfBelow: compare(a, half, below, 0, half),
    // Controls: the same region against itself, and against something unrelated.
    topOfThisVsTopOfThis: compare(a, 0, a, 0, half),
    topOfThisVsTopOfRight: compare(a, 0, right, 0, half),
    topOfThisVsBottomOfThis: compare(a, 0, a, half, half),
    bottomOfThisVsBottomOfBelow: compare(a, half, below, half, half),
  };
}, { b: base, q: query });

console.log(JSON.stringify(report, null, 1));
await browser.close();
