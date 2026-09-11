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

/* ---- one tile with rain in it, for everything that follows ---- */

/**
 * Which tile to measure on.
 *
 * Whether any given tile has rain in it depends on the weather, and an empty
 * tile has a blockiness of zero — which every version of the code passes. So the
 * tiles the layer asked for are searched for the one with the most rain, and the
 * eighth of it that holds the most, which is the crop a zoom past native cuts.
 */
const picked = await page.evaluate(async (addresses) => {
  const { decodeTile } = window.__windyPool;
  const pair = (u) => [u, u.replace('/radar2/composite/', '/radar2/archive/composite/')];
  let best = { url: null, ix: 0, iy: 0, lit: -1, tileLit: 0 };
  for (const candidate of addresses) {
    // eslint-disable-next-line no-await-in-loop
    const decoded = await decodeTile({ urls: pair(candidate), dw: 256, dh: 256, crop: null, smooth: false })
      .catch(() => null);
    if (!decoded) continue;
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d');
    ctx.drawImage(decoded.bitmap, 0, 0);
    decoded.bitmap.close();
    const d = ctx.getImageData(0, 0, 256, 256).data;
    let tileLit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) tileLit += 1;
    for (let cy = 0; cy < 8; cy += 1) {
      for (let cx = 0; cx < 8; cx += 1) {
        let lit = 0;
        for (let y = cy * 32; y < cy * 32 + 32; y += 1) {
          for (let x = cx * 32; x < cx * 32 + 32; x += 1) {
            if (d[(y * 256 + x) * 4 + 3] > 8) lit += 1;
          }
        }
        if (lit > best.lit) best = { url: candidate, ix: cx, iy: cy, lit, tileLit };
      }
    }
    // Three quarters of the crop covered is more than enough to measure.
    if (best.lit > 760) break;
  }
  window.__rainTile = best;
  return best;
}, [...radarTiles]);
console.log(`  measuring on a tile with ${picked.tileLit} lit pixels, densest eighth ${picked.ix},${picked.iy} at ${picked.lit} of 1024`);
if (!picked.url) throw new Error('no radar tile with any rain in it was found');


console.log('\n=== smoothing ===');
const smoothing = await page.evaluate(async () => {
  const { decodeTile } = window.__windyPool;
  // Driven through the worker on one real tile, upscaled the way a zoom past
  // native does. Comparing rendered map canvases instead meant waiting on a
  // re-render, and a survey that quietly measured the same tiles twice looked
  // like proof that nothing had changed.
  const url = window.__rainTile.url;
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

  const best = window.__rainTile;
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


/* ================================================================== *
 * Where two tiles meet
 * ================================================================== */
console.log('\n=== the joins between tiles ===');

// Smoothing averages a neighbourhood. A tile that can only read itself averages
// half a neighbourhood along each edge and leans inward, its neighbour leans the
// other way, and the step between them is a seam down every join. Inside a
// parent tile there is always more data to read; on the parent's own edge there
// is not, which is where this showed.
const joins = await page.evaluate(async (addresses) => {
  const { decodeTile } = window.__windyPool;
  const pair = (u) => [u, u.replace('/radar2/composite/', '/radar2/archive/composite/')];
  const shift = (u, dx, dy = 0) => u.replace(//(d+)/(d+)/(d+)/reflectivity/,
    (m, z, x, y) => `/${z}/${Number(x) + dx}/${Number(y) + dy}/reflectivity`);
  // The same eight addresses the layer hands the worker.
  const around = (u) => {
    const out = {};
    for (let gy = -1; gy <= 1; gy += 1) {
      for (let gx = -1; gx <= 1; gx += 1) {
        if (gx || gy) out[`${gx},${gy}`] = pair(shift(u, gx, gy));
      }
    }
    return out;
  };
  const grab = async (u, crop, size = 512, neighbours = null) => {
    const { bitmap } = await decodeTile({
      urls: pair(u), neighbours: neighbours || around(u), dw: size, dh: size, crop, smooth: true,
    });
    const c = new OffscreenCanvas(size, size);
    const x = c.getContext('2d');
    x.drawImage(bitmap, 0, 0);
    bitmap.close();
    return x.getImageData(0, 0, size, size);
  };

  // A parent with a band of rain right across it, so both sides of every join
  // have something to disagree about.
  let chosen = null;
  for (const u of addresses) {
    // eslint-disable-next-line no-await-in-loop
    const img = await grab(u, null, 256).catch(() => null);
    if (!img) continue;
    for (let cy = 0; cy < 8 && !chosen; cy += 1) {
      let lit = 0;
      for (let y = cy * 32; y < cy * 32 + 32; y += 1) {
        for (let x = 0; x < 256; x += 1) if (img.data[(y * 256 + x) * 4 + 3] > 8) lit += 1;
      }
      if (lit > 4000) chosen = { url: u, iy: cy };
    }
    if (chosen) break;
  }
  if (!chosen) return { skipped: true };

  const column = (img, x) => {
    const col = [];
    for (let y = 0; y < 512; y += 1) {
      const i = (y * 512 + x) * 4;
      col.push(img.data[i + 3] < 8 ? -1 : img.data[i] * 65536 + img.data[i + 1] * 256 + img.data[i + 2]);
    }
    return col;
  };
  const differ = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

  const { url, iy } = chosen;
  // Measured both ways on the same tiles and the same frame. How large a step
  // is normal depends entirely on what the weather is doing where the join
  // happens to fall, so the number only means something against itself.
  const alone = {};
  const step = async (neighbours) => {
    const c = await grab(url, { ix: 7, iy, scale: 8 }, 512, neighbours);
    const d = await grab(shift(url, 1), { ix: 0, iy, scale: 8 }, 512, neighbours);
    return differ(column(c, 511), column(d, 0));
  };
  alone.across = await step({});
  const withNeighbours = await step(null);

  const a = await grab(url, { ix: 3, iy, scale: 8 });
  const b = await grab(url, { ix: 4, iy, scale: 8 });
  return {
    // Two children of one parent, which have always had data on both sides.
    inside: { join: differ(column(a, 511), column(b, 0)), ordinary: differ(column(a, 510), column(a, 511)) },
    // And two that meet across the parent's own edge, where they did not.
    across: { alone: alone.across, withNeighbours },
  };
}, [picked.url, ...radarTiles]);

console.log(`  ${JSON.stringify(joins)}`);
if (joins.skipped) {
  console.log('  -- no tile with a band of rain across it; joins not measured');
} else {
  // Repeatedly measured under ten rows, against an ordinary step of a handful.
  ok('children of one parent meet cleanly', joins.inside.join <= 40,
     `${joins.inside.join} rows of 512 differ, against ${joins.inside.ordinary} for an ordinary step`);
  ok('a tile that can only read itself leaves a real step at a parent boundary',
     joins.across.alone > 60, `${joins.across.alone} rows of 512`);
  ok('and reading its neighbours takes most of it away',
     joins.across.withNeighbours <= joins.across.alone * 0.45,
     `${joins.across.alone} rows of 512 alone, ${joins.across.withNeighbours} with neighbours`);
}

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

  // Somewhere with weather under it. A fixed point is a dry field on most days,
  // and a dry field measures nothing.
  const layer = [...Object.values(window.RadarLoop.map()._layers)].find((l) => l._isOperaLayer);
  if (!layer) return { missing: true };
  const { _values: v, _sw: sw, _sh: sh } = layer;
  let busiest = { x: sw >> 1, y: sh >> 1, score: -1 };
  for (let y = 8; y < sh - 8; y += 16) {
    for (let x = 8; x < sw - 8; x += 16) {
      let score = 0;
      for (let j = -8; j <= 8; j += 2) {
        for (let i = -8; i <= 8; i += 2) {
          const e = v[(y + j) * sw + (x + i)];
          if (e !== 255 && e > 80) score += e;
        }
      }
      if (score > busiest.score) busiest = { x, y, score };
    }
  }
  const [minX, minY, maxX, maxY] = layer._extent;
  const px = minX + ((busiest.x + 0.5) / sw) * (maxX - minX);
  const py = maxY - ((busiest.y + 0.5) / sh) * (maxY - minY);
  const [lon, lat] = proj4(layer._projection, 'EPSG:4326', [px, py]);
  window.RadarLoop.map().setView([lat, lon], 10);
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
ok('with no shades the scale does not have',
   !!opera.on && opera.on.colours <= opera.off.colours + 1,
   `${opera.off?.colours} -> ${opera.on?.colours}`);

// The straight-run measure above is calibrated on the composite, where one
// sample is sixteen output pixels across. This grid's cells are six or seven,
// and at that size the measure inverts — a smooth contour running gently across
// the screen scores higher than a lattice of blocks — so the interpolation
// itself is what gets checked.
const sampler = await page.evaluate(() => {
  const layer = [...Object.values(window.RadarLoop.map()._layers)].find((l) => l._isOperaLayer);
  if (!layer) return null;
  const { _values: v, _sw: sw, _sh: sh } = layer;

  // A cell with a real step across it, which is where blockiness shows.
  let found = null;
  for (let y = 1; y < sh - 1 && !found; y += 1) {
    for (let x = 1; x < sw - 1; x += 1) {
      const a = v[y * sw + x];
      const b = v[y * sw + x + 1];
      if (a === 255 || b === 255 || a < 60) continue;
      if (Math.abs(a - b) >= 20) { found = { x, y, a, b }; break; }
    }
  }
  if (!found) return { found: false };

  // Across one cell, from its centre to the next centre.
  const readings = [];
  for (let t = 0; t <= 10; t += 1) readings.push(layer._sampleSmooth(found.x + t / 10, found.y));
  const neighbours = [];
  for (let j = 0; j <= 1; j += 1) for (let i = 0; i <= 1; i += 1) neighbours.push(v[(found.y + j) * sw + found.x + i]);
  const real = neighbours.filter((n) => n !== 255);
  return {
    found: true,
    steps: new Set(readings).size,
    ends: [readings[0], readings[10]],
    corners: [Math.min(...real), Math.max(...real)],
    outside: readings.filter((r) => r < Math.min(...real) || r > Math.max(...real)).length,
    monotone: readings.every((r, i) => i === 0 || (readings[10] >= readings[0] ? r >= readings[i - 1] : r <= readings[i - 1])),
  };
});
console.log(`  across one cell: ${JSON.stringify(sampler)}`);
ok('the grid is read between its cells, not cell by cell',
   !!sampler && sampler.found && sampler.steps >= 5, JSON.stringify(sampler));
// Which is what makes it safe to do at all: a cubic would ring, and a ring on a
// rainfall scale is a heavier band than the radar ever measured.
ok('and never past the cells it read',
   !!sampler && sampler.outside === 0 && sampler.monotone === true, JSON.stringify(sampler));

await page.screenshot({ path: 'shots/radar-smooth-deep.png' });
await page.evaluate(() => window.__radarScale.setSmoothing(false));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
