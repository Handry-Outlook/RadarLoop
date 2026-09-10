/**
 * Which half of the checkerboard is the inverted one.
 *
 * Both parities decode to a coherent picture — one is the photographic negative
 * of the other — so the choice cannot be made by looking for structure. It can
 * be made against ground truth: at midday a cloud-free Sahara is the brightest
 * thing in a visible image and open ocean under clear sky is among the darkest.
 * Whichever parity puts the desert above the sea is the right one.
 */
import { chromium } from 'playwright';

const [, , base, query] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const report = await page.evaluate(async ({ b, q }) => {
  const tileOf = (lat, lon, z) => {
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    return {
      z,
      x: Math.floor(((lon + 180) / 360) * n),
      y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
    };
  };

  const places = [
    ['Sahara (bright land)', 23, 10],
    ['Arabian desert', 22, 45],
    ['South Atlantic (dark sea)', -25, -20],
    ['Indian Ocean', -20, 70],
  ];

  const out = [];
  for (const [name, lat, lon] of places) {
    const t = tileOf(lat, lon, 5);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `${b}/${t.z}/${t.x}/${t.y}/visir.png${q}`;
      });
    } catch {
      out.push({ name, error: 'tile failed', ...t });
      continue;
    }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const half = c.height / 2;

    // Mean of the visible half under each parity assumption.
    let asIs = 0;
    let flipped = 0;
    let n = 0;
    for (let y = 0; y < half; y += 1) {
      const rowParity = ((y / 16) | 0) % 2;
      for (let x = 0; x < c.width; x += 1) {
        const v = d[(y * c.width + x) * 4];
        const odd = (((x / 16) | 0) + rowParity) % 2 === 1;
        asIs += odd ? 255 - v : v;
        flipped += odd ? v : 255 - v;
        n += 1;
      }
    }
    out.push({ name, ...t, invertOdd: +(asIs / n).toFixed(1), invertEven: +(flipped / n).toFixed(1) });
  }
  return out;
}, { b: base, q: query });

console.log(JSON.stringify(report, null, 1));
await browser.close();
