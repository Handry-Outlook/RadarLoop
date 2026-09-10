/**
 * Does the checkerboard parity depend on which tile you are in?
 *
 * Ground truth said two different things — a Sahara tile decoded bright under
 * one parity, a South Atlantic tile decoded dark only under the other — which is
 * only consistent if the parity is not a property of the pixel grid alone.
 *
 * Tile seams settle it without any meteorology. Two horizontally adjacent tiles
 * show the same sky at the same instant, so their touching columns must nearly
 * match. Decoded with the same rule they either agree (`same`) or come out as
 * each other's negative (`flip`), and whichever is smaller says whether the
 * neighbour's parity is the same one.
 */
import { chromium } from 'playwright';

const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async ({ b, q }) => {
  const grab = async (z, x, y) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `${b}/${z}/${x}/${y}/visir.png${q}`; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, c.width, c.height).data;
    // Decoded with one fixed rule: invert the odd blocks of this tile's own grid.
    const at = (px, py) => {
      const v = raw[(py * c.width + px) * 4];
      return ((((px / 16) | 0) + ((py / 16) | 0)) % 2) ? 255 - v : v;
    };
    return { at, w: c.width, h: c.height };
  };

  const out = [];
  // Daylit, cloudy, and away from any satellite seam: the eastern Atlantic.
  const z = 5;
  for (const [x, y] of [[14, 12], [15, 12], [14, 13], [15, 13]]) {
    const a = await grab(z, x, y);
    const right = await grab(z, x + 1, y);
    const below = await grab(z, x, y + 1);
    const half = a.h / 2;

    const edge = (f, g, n) => {
      let same = 0;
      let flip = 0;
      for (let i = 0; i < n; i += 1) {
        const p = f(i);
        const s = g(i);
        same += Math.abs(p - s);
        flip += Math.abs(p - (255 - s));
      }
      return { same: +(same / n).toFixed(1), flip: +(flip / n).toFixed(1) };
    };

    out.push({
      tile: [x, y],
      toRight: edge((i) => a.at(a.w - 1, i), (i) => right.at(0, i), half),
      below: edge((i) => a.at(i, half - 1), (i) => below.at(i, 0), a.w),
    });
  }
  return out;
}, { b: base, q: query });

console.log(JSON.stringify(report, null, 1));
await browser.close();
