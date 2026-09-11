/** Does the worker draw differently when asked to smooth? */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

const seen = [];
page.on('request', (r) => { if (r.url().includes("rdr.windy.com/radar2")) seen.push(r.url()); });
await page.evaluate(() => {
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.setLayerEnabled('radar', true);
  window.RadarLoop.map().setView([50.2, 17.5], 7);
});
await page.waitForTimeout(12000);
if (!seen.length) throw new Error('no radar tiles were requested');
console.log(`sampling ${seen[Math.floor(seen.length / 2)]}`);

const report = await page.evaluate(async (url) => {
  const { decodeTile } = window.__windyPool;

  const run = async (smooth) => {
    const { bitmap } = await decodeTile({
      urls: [url], dw: 512, dh: 512, crop: { ix: 0, iy: 0, scale: 2 }, smooth,
    });
    const c = new OffscreenCanvas(512, 512);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, 512, 512).data;
    const colours = new Set();
    let edges = 0;
    let lit = 0;
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 511; x += 1) {
        const i = (y * 512 + x) * 4;
        if (data[i + 3] < 8) continue;
        lit += 1;
        colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        const j = i + 4;
        if (data[j + 3] > 8 && (data[i] !== data[j] || data[i + 1] !== data[j + 1])) edges += 1;
      }
    }
    return { lit, colours: colours.size, edges };
  };

  const off = await run(false);
  const on = await run(true);
  return { off, on };
}, seen[Math.floor(seen.length / 2)]);
console.log(JSON.stringify(report, null, 1));
await browser.close();
