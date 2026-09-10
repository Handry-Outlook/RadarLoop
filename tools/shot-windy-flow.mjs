/**
 * What is in the four quadrants of an `opticalflow.jpg` tile.
 *
 * It is 512x512 for a 256x256 map tile, so it packs four planes. If any of them
 * is a picture it is worth showing; if they are all fields centred on mid-grey
 * they are motion vectors, which are an input to frame interpolation and not
 * something to draw on a map.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 780 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const stats = await page.evaluate(async () => {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(Math.floor((Date.now() - 30 * 60000) / 600000) * 600000);
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  const maxt = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = `https://sat.windy.com/satellite/composite/${iso}/5/15/10/opticalflow.jpg?maxt=${maxt}`;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const w = c.width / 2;
  const h = c.height / 2;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#111;display:flex;gap:10px;padding:10px;z-index:99999;font:12px system-ui;color:#ddd';
  document.body.append(host);

  const out = [];
  for (const [name, ox, oy] of [['top-left', 0, 0], ['top-right', w, 0], ['bottom-left', 0, h], ['bottom-right', w, h]]) {
    const px = ctx.getImageData(ox, oy, w, h);
    let lo = 255;
    let hi = 0;
    let sum = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      const v = px.data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    const mean = sum / (px.data.length / 4);
    // Stretched, so a flat-looking field still reveals whatever structure it has.
    const view = new ImageData(w, h);
    const span = hi > lo ? 255 / (hi - lo) : 1;
    for (let i = 0; i < px.data.length; i += 4) {
      const v = (px.data[i] - lo) * span;
      view.data[i] = v; view.data[i + 1] = v; view.data[i + 2] = v; view.data[i + 3] = 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(view, 0, 0);
    canvas.style.cssText = 'width:340px;height:340px;image-rendering:pixelated;border:1px solid #444';
    const box = document.createElement('div');
    box.append(canvas, Object.assign(document.createElement('div'), {
      textContent: `${name}  min ${lo} max ${hi} mean ${mean.toFixed(1)}`,
    }));
    host.append(box);
    out.push({ name, lo, hi, mean: +mean.toFixed(1) });
  }
  return { size: [c.width, c.height], quadrants: out };
});

console.log(JSON.stringify(stats, null, 1));
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/windy-flow.png' });
await browser.close();
