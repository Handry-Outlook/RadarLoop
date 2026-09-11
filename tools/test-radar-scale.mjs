/**
 * The rainfall scale, and its smoothing, belong to the two products that are
 * data rather than pictures.
 *
 * Every other radar product arrives already coloured by its provider, so a
 * colour editor beside one of those is an offer the app cannot keep.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// The last radar tile the layer asked for, so the smoothing check can decode a
// real one rather than an address built by hand.
let lastRadarTile = null;
page.on('request', (r) => {
  if (r.url().includes('rdr.windy.com/radar2')) lastRadarTile = r.url();
});

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

/* ---- who gets the controls ---- */
console.log('\n=== which products offer the scale ===');
const visibility = await page.evaluate(async () => {
  const panel = () => [...document.querySelectorAll('#panel details')]
    .find((d) => /Rainfall colour scale/i.test(d.textContent));
  const shown = () => {
    const p = panel();
    return !!p && !p.hidden;
  };
  const out = {};
  for (const type of ['windy-radar', 'opera-dbzh', 'radar', 'uk-precip-intensity']) {
    window.RadarLoop.selectProduct('radar', type);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 600));
    out[type] = shown();
  }
  return out;
});
console.log(`  ${JSON.stringify(visibility)}`);
ok('the global composite offers it', visibility['windy-radar'] === true);
ok('the European reflectivity grid offers it', visibility['opera-dbzh'] === true);
// These arrive already coloured; there is nothing here to recolour.
ok('a provider-coloured product does not', visibility.radar === false);
ok('nor another one', visibility['uk-precip-intensity'] === false);

/* ---- and what smoothing does ---- */

// A tile the layer has just asked for. Building the address by hand was a 404,
// and one captured at startup had expired by the time the checks above finished
// — the composite rolls every five minutes.
lastRadarTile = null;
await page.evaluate(() => {
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.map().setView([50.2, 17.5], 7);
});
await page.waitForTimeout(12000);
if (!lastRadarTile) throw new Error('no radar tile was requested');
await page.evaluate((u) => { window.__lastRadarTile = u; }, lastRadarTile);

console.log('\n=== smoothing ===');
const smoothing = await page.evaluate(async () => {
  const { decodeTile } = window.__windyPool;
  // Driven through the worker on one real tile, upscaled the way a zoom past
  // native does. Comparing rendered map canvases instead meant waiting on a
  // re-render, and a survey that quietly measured the same tiles twice looked
  // like proof that nothing had changed.
  const url = window.__lastRadarTile;
  const run = async (smooth) => {
    const { bitmap } = await decodeTile({
      urls: [url, url.replace('/radar2/composite/', '/radar2/archive/composite/')],
      dw: 512,
      dh: 512,
      crop: { ix: 0, iy: 0, scale: 2 },
      smooth,
    });
    const c = new OffscreenCanvas(512, 512);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, 512, 512).data;
    const colours = new Set();
    let lit = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      lit += 1;
      colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      hash = (hash * 31 + data[i] + data[i + 1] * 7 + i) % 2147483647;
    }
    return { lit, colours: colours.size, hash };
  };
  return { off: await run(false), on: await run(true) };
});
console.log(`  smoothing off: ${JSON.stringify(smoothing.off)}`);
console.log(`  smoothing on:  ${JSON.stringify(smoothing.on)}`);

ok('there is radar in the tile', smoothing.off.lit > 1000, `${smoothing.off.lit} lit`);
ok('smoothing changes the picture', smoothing.on.hash !== smoothing.off.hash,
   `${smoothing.off.hash} against ${smoothing.on.hash}`);
// The point of interpolating the data rather than the picture: the class
// boundaries move onto a smooth field, but the classes are the same ones, so no
// blended in-between shades appear.
ok('and introduces no colours the scale does not have',
   smoothing.on.colours === smoothing.off.colours,
   `${smoothing.off.colours} -> ${smoothing.on.colours}`);

/* ---- the switch is wired to it ---- */
const wired = await page.evaluate(async () => {
  document.getElementById('panel')?.removeAttribute('hidden');
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  await new Promise((r) => setTimeout(r, 600));
  const row = [...document.querySelectorAll('#panel .switch-row, #panel label')]
    .find((n) => /^\s*Smooth\b/.test(n.textContent));
  const input = row?.querySelector('input[type="checkbox"]');
  if (!input) return { found: false };
  const before = window.__radarScale.isSmoothing();
  input.click();
  await new Promise((r) => setTimeout(r, 400));
  const after = window.__radarScale.isSmoothing();
  input.click();
  await new Promise((r) => setTimeout(r, 400));
  return { found: true, before, after, restored: window.__radarScale.isSmoothing() };
});
console.log(`  ${JSON.stringify(wired)}`);
ok('the panel has a Smooth switch for this product', wired.found === true);
ok('and it drives the setting', wired.found && wired.after !== wired.before,
   `${wired.before} -> ${wired.after}`);
ok('both ways', wired.restored === wired.before, String(wired.restored));


console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
