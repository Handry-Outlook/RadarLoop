/**
 * The satellite composite's decode.
 *
 * This product is not a picture until two things are undone: alternate 16px
 * blocks are stored inverted, and the two halves of the 256x512 source are the
 * visible and infrared views of the same ground rather than two map rows. The
 * parity is not the same in both halves, which is what went wrong the first
 * time — the visible channel came out as a negative, so daylight cloud was black
 * and the sea was white.
 *
 * Nothing local can catch that: the two candidate decodes are exact negatives of
 * one another, so every measure of smoothness and every seam between tiles is
 * identical either way. It takes ground truth, which is why the last check here
 * is a desert and an ocean in the same frame.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};
const skipped = (name, why) => { skip += 1; console.log(`  skip ${name} — ${why}`); };

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

/* ================================================================== *
 * The rule itself
 * ================================================================== */
console.log('\n=== block inversion ===');

const rule = await page.evaluate(() => {
  const { deinvertBlocks } = window.__windySat;
  // A 32x64 stand-in: two 32x32 halves, two blocks across, two down. Every pixel
  // starts at 10, so after decoding, a pixel is either 10 (left alone) or 245.
  const image = new ImageData(32, 64);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 10; image.data[i + 1] = 10; image.data[i + 2] = 10; image.data[i + 3] = 255;
  }
  deinvertBlocks(image);
  const at = (x, y) => image.data[(y * 32 + x) * 4];
  return {
    // Top half: the even blocks are the inverted ones.
    topEven: at(0, 0), topOdd: at(16, 0), topBelow: at(0, 16), topDiagonal: at(16, 16),
    // Bottom half: the other way round.
    bottomEven: at(0, 32), bottomOdd: at(16, 32),
  };
});
console.log(`  ${JSON.stringify(rule)}`);
ok('the visible half inverts its even blocks', rule.topEven === 245 && rule.topOdd === 10,
   JSON.stringify(rule));
ok('and the checkerboard alternates down the image as well as across',
   rule.topBelow === 10 && rule.topDiagonal === 245, JSON.stringify(rule));
// The halves not sharing a parity is the whole finding; a future refactor that
// "tidies" it into one rule reintroduces the negative.
ok('the infrared half inverts the opposite blocks',
   rule.bottomEven === 10 && rule.bottomOdd === 245, JSON.stringify(rule));

/* ================================================================== *
 * Ground truth: a desert and an ocean in the same frame
 * ================================================================== */
console.log('\n=== which way up ===');

const truth = await page.evaluate(async () => {
  // z5/15/13 is the Atlantic coast of the western Sahara: bare desert in the
  // east of the tile, open ocean in the west. In a visible image the desert is
  // the brightest thing in frame and the sea nearly the darkest.
  const { deinvertBlocks, daylightGrid } = window.__windySat;
  const coords = { z: 5, x: 15, y: 13 };
  const daylight = daylightGrid(coords, Date.now());
  if (daylight.allNight) return { night: true };

  const stamp = new Date(Math.floor((Date.now() - 20 * 60000) / 600000) * 600000);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())}`
    + `-${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}00`;
  const maxt = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}`
    + `${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}00`;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = `https://sat.windy.com/satellite/composite/${iso}/5/15/13/visir.png?mosaic=true&maxt=${maxt}`;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const decoded = deinvertBlocks(ctx.getImageData(0, 0, c.width, c.height));
  const half = c.height / 2;
  const at = (x, y) => decoded.data[(y * c.width + x) * 4];

  const meanOf = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) { sum += at(x, y); n += 1; }
    }
    return +(sum / n).toFixed(1);
  };
  return {
    // Western third is ocean, eastern third is desert.
    ocean: meanOf(0, 70, 0, half),
    desert: meanOf(190, c.width, 0, half),
    size: [c.width, c.height],
  };
});
console.log(`  ${JSON.stringify(truth)}`);
if (truth.night) {
  skipped('the desert is brighter than the sea', 'the western Sahara is dark right now');
} else {
  ok('the source is one tile wide and two tall', String(truth.size) === '256,512', JSON.stringify(truth.size));
  // The failure this guards against inverted the whole channel, which swaps
  // these two by well over a hundred levels.
  ok('the desert is brighter than the sea, so the visible channel is not a negative',
     truth.desert > truth.ocean + 25, `desert ${truth.desert} vs ocean ${truth.ocean}`);
}

/* ================================================================== *
 * Live and archive endpoints
 * ================================================================== */
console.log('\n=== archive routing ===');

const routing = await page.evaluate(() => {
  const { toArchiveUrl, toLiveUrl, frameTimeFromUrl, isArchiveOnly, archiveFrameTime } = window.__windySat;
  const live = 'https://sat.windy.com/satellite/composite/2026-09-09-155000/6/31/22/visir.png?mosaic=true&maxt=20260909155400';
  const archive = toArchiveUrl(live);
  return {
    archive,
    roundTrip: toLiveUrl(archive),
    frame: frameTimeFromUrl(live),
    snapped: archiveFrameTime(frameTimeFromUrl(live)),
    oldIsArchiveOnly: isArchiveOnly(live, Date.parse('2026-09-11T12:00:00Z')),
    freshIsNot: isArchiveOnly(live, Date.parse('2026-09-09T16:10:00Z')),
  };
});
console.log(`  ${routing.archive}`);
ok('the archive path is used', routing.archive.includes('/satellite/archive/composite/'), routing.archive);
// The archive keeps hourly frames only; asking for :50 is asking for a frame
// that was never written, which is what made it look empty at first.
ok('and the frame is snapped down to the hour',
   routing.archive.includes('/composite/2026-09-09-150000/'), routing.archive);
ok('the freshness bound moves with it', /maxt=20260909150400/.test(routing.archive), routing.archive);
ok('a day-old frame is archive-only', routing.oldIsArchiveOnly === true);
ok('a fresh one is not', routing.freshIsNot === false);

/* ---- and it actually fetches ---- */
const fetched = await page.evaluate(async () => {
  const probe = async (url) => {
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      return r.status;
    } catch (e) {
      return String(e.message || e);
    }
  };
  const { toArchiveUrl } = window.__windySat;
  const pad = (n) => String(n).padStart(2, '0');
  const urlAt = (ms) => {
    const d = new Date(Math.floor(ms / 600000) * 600000);
    const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
      + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
    const maxt = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
      + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
    return `https://sat.windy.com/satellite/composite/${iso}/6/31/22/visir.png?mosaic=true&maxt=${maxt}`;
  };
  const out = {};
  for (const hours of [2, 30, 24 * 6]) {
    const live = urlAt(Date.now() - hours * 3600000);
    // eslint-disable-next-line no-await-in-loop
    out[`h${hours}`] = { live: await probe(live), archive: await probe(toArchiveUrl(live)) };
  }
  return out;
});
console.log(`  ${JSON.stringify(fetched)}`);
ok('a recent frame comes from the live endpoint', fetched.h2.live === 200, JSON.stringify(fetched.h2));
ok('a day-and-a-bit old frame comes from the archive',
   fetched.h30.archive === 200, JSON.stringify(fetched.h30));
ok('and so does one from last week', fetched.h144.archive === 200, JSON.stringify(fetched.h144));

/* ================================================================== *
 * On the map, and into 3D
 * ================================================================== */
console.log('\n=== the layer ===');

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.selectProduct('satellite', 'windy-visir');
  window.RadarLoop.setLayerEnabled('satellite', true);
  window.RadarLoop.map().setView([48, -6], 5);
});
await page.waitForTimeout(13000);

const drawn = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.windy-sat-tile canvas, canvas.windy-sat-tile')];
  const painted = tiles.filter((t) => t.width > 0).length;
  // Anything actually decoded is a picture, not a flat field.
  let spread = 0;
  const sample = tiles.find((t) => t.width > 0);
  if (sample) {
    const d = sample.getContext('2d').getImageData(0, 0, sample.width, sample.height).data;
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < d.length; i += 64) {
      if (d[i + 3] < 8) continue;
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    spread = hi - lo;
  }
  return { tiles: tiles.length, painted, spread, workers: window.RadarLoop.tileWorkers() };
});
console.log(`  ${JSON.stringify(drawn)}`);
ok('tiles are drawn', drawn.painted > 4, JSON.stringify(drawn));
ok('and decoded off the main thread', drawn.workers.decoded > 0 && drawn.workers.failed === 0,
   JSON.stringify(drawn.workers));
ok('the result is an image rather than a flat field', drawn.spread > 40, `range ${drawn.spread}`);

await page.click('#btn-3d');
const mirror = await page.evaluate(async () => {
  for (let i = 0; i < 60; i += 1) {
    const kind = window.RadarLoop.mirrorKind('satellite');
    if (kind) return kind;
    await new Promise((r) => setTimeout(r, 500));
  }
  return window.RadarLoop.mirrorKind('satellite');
});
console.log(`  3D mirror: ${mirror}`);
// A raster mirror would mean GL fetched the source tiles itself and drew the
// undecoded checkerboard.
ok('3D takes the decoded canvas, not the raw tiles', mirror === 'canvas', String(mirror));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0
  ? `ALL ${pass} CHECKS PASSED${skip ? ` (${skip} skipped)` : ''}`
  : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
