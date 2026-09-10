/**
 * Does a Windy `visir` tile contain a recognisable picture at low zoom?
 *
 * At z6 over Scotland the pixels look like structured noise under a 16px
 * checkerboard, which could mean either an obfuscated encoding or simply a tile
 * with nothing in it. A low-zoom tile settles that: at z2/z3 a whole continent is
 * in frame, so a coherent picture is unmistakable and its absence is conclusive.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async ({ b, q }) => {
  const coords = [[2, 1, 1], [3, 3, 2], [4, 7, 5], [5, 15, 9]];
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;flex-wrap:wrap;gap:10px;padding:10px;z-index:99999;font:12px system-ui;color:#ddd';
  document.body.append(host);
  const out = [];

  for (const [z, x, y] of coords) {
    const url = `${b}/${z}/${x}/${y}/visir.png${q}`;
    let img;
    try {
      img = new Image();
      img.crossOrigin = 'anonymous';
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    } catch {
      out.push({ z, x, y, error: 'failed' });
      continue;
    }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const half = c.height / 2;
    for (const [name, yOff] of [['top', 0], ['bottom', half]]) {
      const view = document.createElement('canvas');
      view.width = c.width;
      view.height = half;
      view.getContext('2d').putImageData(ctx.getImageData(0, yOff, c.width, half), 0, 0);
      view.style.cssText = 'width:256px;height:256px;image-rendering:pixelated;border:1px solid #444';
      const box = document.createElement('div');
      box.append(view, Object.assign(document.createElement('div'), { textContent: `z${z}/${x}/${y} ${name}` }));
      host.append(box);
    }
    out.push({ z, x, y, size: [c.width, c.height] });
  }
  return out;
}, { b: base, q: query });

console.log(JSON.stringify(report));
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/windy-sat-zooms.png' });
console.log('written shots/windy-sat-zooms.png');
await browser.close();
