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
const radarTiles = new Set();
page.on('request', (r) => {
  if (!r.url().includes('rdr.windy.com/radar2')) return;
  lastRadarTile = r.url();
  radarTiles.add(r.url());
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
await page.evaluate((list) => { window.__radarTiles = list; }, [...radarTiles]);

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
   smoothing.on.colours <= smoothing.off.colours,
   `${smoothing.off.colours} -> ${smoothing.on.colours}`);

/* ---- the switch is wired to it ---- */
const wired = await page.evaluate(async () => {
  document.getElementById('panel')?.removeAttribute('hidden');
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  await new Promise((r) => setTimeout(r, 600));
  const row = [...document.querySelectorAll('#panel .switch-row, #panel label')]
    .find((n) => n.textContent.trim().startsWith('Smooth'));
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



/* ================================================================== *
 * Zoomed in, where the complaint was
 * ================================================================== */
console.log('\n=== blockiness at a deep zoom ===');

const deep = await page.evaluate(async () => {
  const { decodeTile } = window.__windyPool;
  const url = window.__lastRadarTile;

  /**
   * How much of the picture's structure is a grid.
   *
   * Every boundary between two rainfall classes is walked, and the ones that
   * run dead straight for longer than a source sample are counted. Rain does
   * not have straight edges; a stretched grid of samples has almost nothing
   * else, so the share of boundary that is straight is a direct reading of how
   * blocky the tile looks.
   */
  const survey = (data, size) => {
    const at = (x, y) => {
      const i = (y * size + x) * 4;
      return data[i + 3] < 8 ? -1 : data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
    };
    let boundary = 0;
    let straight = 0;
    const colours = new Set();
    for (let y = 0; y < size - 1; y += 1) {
      let run = 0;
      for (let x = 0; x < size; x += 1) {
        const here = at(x, y);
        if (here >= 0) colours.add(here);
        const edge = here !== at(x, y + 1);
        if (edge) { boundary += 1; run += 1; continue; }
        if (run >= 12) straight += run;
        run = 0;
      }
      if (run >= 12) straight += run;
    }
    return { boundary, straightShare: +(straight / Math.max(1, boundary)).toFixed(3), colours: colours.size };
  };

  // Which tile, and which eighth of it. Both are found by looking: whether any
  // given tile has rain in it depends on the weather, and an empty tile has a
  // blockiness of zero, which every version of the code passes.
  const addresses = (window.__radarTiles || []).includes(url)
    ? window.__radarTiles : [url, ...(window.__radarTiles || [])];
  let best = { url, ix: 0, iy: 0, lit: -1 };
  for (const candidate of addresses) {
    const pair = [candidate, candidate.replace('/radar2/composite/', '/radar2/archive/composite/')];
    // eslint-disable-next-line no-await-in-loop
    const parent = await decodeTile({ urls: pair, dw: 256, dh: 256, crop: null, smooth: false })
      .catch(() => null);
    if (!parent) continue;
    const pc = new OffscreenCanvas(256, 256);
    const pctx = pc.getContext('2d');
    pctx.drawImage(parent.bitmap, 0, 0);
    parent.bitmap.close();
    const pd = pctx.getImageData(0, 0, 256, 256).data;
    for (let cy = 0; cy < 8; cy += 1) {
      for (let cx = 0; cx < 8; cx += 1) {
        let lit = 0;
        for (let y = cy * 32; y < cy * 32 + 32; y += 1) {
          for (let x = cx * 32; x < cx * 32 + 32; x += 1) {
            if (pd[(y * 256 + x) * 4 + 3] > 8) lit += 1;
          }
        }
        if (lit > best.lit) best = { url: candidate, ix: cx, iy: cy, lit };
      }
    }
    // A third of the crop covered is more than enough to measure.
    if (best.lit > 340) break;
  }
  const urls = [best.url, best.url.replace('/radar2/composite/', '/radar2/archive/composite/')];

  // A z10 tile as the map builds one: an eighth of the parent in each axis,
  // stretched across a full retina tile. Sixteen output pixels per sample.
  const run = async (smooth) => {
    const started = performance.now();
    const { bitmap } = await decodeTile({
      urls,
      dw: 512,
      dh: 512,
      crop: { ix: best.ix, iy: best.iy, scale: 8 },
      smooth,
    });
    const ms = performance.now() - started;
    const c = new OffscreenCanvas(512, 512);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { ...survey(ctx.getImageData(0, 0, 512, 512).data, 512), ms: +ms.toFixed(0) };
  };

  return { cell: best, off: await run(false), on: await run(true) };
});
console.log(`  densest eighth: ${JSON.stringify(deep.cell)}`);
console.log(`  smoothing off: ${JSON.stringify(deep.off)}`);
console.log(`  smoothing on:  ${JSON.stringify(deep.on)}`);

ok('the deep crop has rainfall in it', deep.off.boundary > 500, `${deep.off.boundary} boundary pixels`);
// The measurement that stands in for the complaint. Unsmoothed, a stretched
// sample grid is almost all straight edges.
ok('unsmoothed, the picture is mostly straight edges', deep.off.straightShare > 0.35,
   `${deep.off.straightShare}`);
ok('smoothing removes most of them', deep.on.straightShare < deep.off.straightShare * 0.4,
   `${deep.off.straightShare} -> ${deep.on.straightShare}`);
// And the other half of the promise: no blending, so the bands stay hard.
ok('without inventing shades between the classes', deep.on.colours <= deep.off.colours,
   `${deep.off.colours} -> ${deep.on.colours}`);
ok('and a tile still decodes quickly', deep.on.ms < 250, `${deep.on.ms}ms`);

/* ---- and the map actually builds tiles that deep ---- */
console.log('\n=== the tile grid past native zoom ===');
const grid = await page.evaluate(async () => {
  window.__radarScale.setSmoothing(true);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  window.RadarLoop.map().setView([50.2, 17.5], 10);
  await new Promise((r) => setTimeout(r, 12000));
  const layer = [...Object.values(window.RadarLoop.map()._layers)]
    .find((l) => l._url && /radar2/.test(String(l._url)));
  const tiles = [...document.querySelectorAll('canvas.windy-radar-tile')];
  return {
    tileZoom: layer?._tileZoom ?? null,
    tiles: tiles.length,
    rendering: [...new Set(tiles.map((t) => t.style.imageRendering))],
  };
});
console.log(`  ${JSON.stringify(grid)}`);
// With the grid capped at 7 the map laid one zoom-7 tile over the whole screen
// and let CSS blow it up eight times, which no amount of care inside the tile
// could undo.
ok('the map builds real tiles at zoom 10', grid.tileZoom === 10, String(grid.tileZoom));
ok('several of them, not one stretched one', grid.tiles > 6, `${grid.tiles} tiles`);
ok('and they are not scaled nearest-neighbour while smoothing',
   grid.rendering.length === 1 && grid.rendering[0] === 'auto', JSON.stringify(grid.rendering));

/* ================================================================== *
 * The European grid, which is drawn a different way entirely
 * ================================================================== */
console.log('\n=== the European reflectivity grid ===');
const opera = await page.evaluate(async () => {
  const read = () => {
    const c = document.querySelector('canvas.opera-radar-canvas');
    if (!c || !c.width) return null;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const size = c.width;
    let boundary = 0;
    let straight = 0;
    const colours = new Set();
    const at = (x, y) => {
      const i = (y * size + x) * 4;
      return data[i + 3] < 8 ? -1 : data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
    };
    for (let y = 0; y < c.height - 1; y += 1) {
      let run = 0;
      for (let x = 0; x < size; x += 1) {
        const here = at(x, y);
        if (here >= 0) colours.add(here);
        if (here !== at(x, y + 1)) { boundary += 1; run += 1; continue; }
        if (run >= 8) straight += run;
        run = 0;
      }
      if (run >= 8) straight += run;
    }
    return { boundary, straightShare: +(straight / Math.max(1, boundary)).toFixed(3), colours: colours.size };
  };

  window.RadarLoop.selectProduct('radar', 'opera-dbzh');
  await new Promise((r) => setTimeout(r, 14000));
  window.RadarLoop.map().setView([50.2, 17.5], 10);
  await new Promise((r) => setTimeout(r, 6000));

  const out = {};
  for (const smooth of [false, true]) {
    window.__radarScale.setSmoothing(smooth);
    window.RadarLoop.renderAll(window.RadarLoop.time.current);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5000));
    out[smooth ? 'on' : 'off'] = read();
  }
  return out;
});
console.log(`  smoothing off: ${JSON.stringify(opera.off)}`);
console.log(`  smoothing on:  ${JSON.stringify(opera.on)}`);
ok('the grid drew something', !!opera.off && opera.off.boundary > 500,
   JSON.stringify(opera.off));
// It is not a tile layer — it resamples straight onto the screen, so the canvas
// smoothing flag never touched it and the switch did nothing here.
ok('and smoothing takes the grid out of it too',
   !!opera.on && opera.on.straightShare < opera.off.straightShare * 0.6,
   `${opera.off?.straightShare} -> ${opera.on?.straightShare}`);
ok('with no shades the scale does not have',
   !!opera.on && opera.on.colours <= opera.off.colours + 1,
   `${opera.off?.colours} -> ${opera.on?.colours}`);

await page.screenshot({ path: 'shots/radar-smooth-deep.png' });
await page.evaluate(() => window.__radarScale.setSmoothing(false));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
