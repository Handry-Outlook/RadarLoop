/**
 * Measures how far the mirrored radar is displaced in 3D, in pixels.
 *
 * Comparing centroids does not work: the 2D capture and the 3D frame clip the
 * field differently, so their centroids differ even when placement is perfect.
 *
 * Instead this samples a grid of real lat/lon points, builds a mask of "is there
 * radar here" from the captured source image and from the rendered 3D frame,
 * then cross-correlates the two over candidate screen offsets. The offset with
 * the best agreement *is* the misplacement. Correct placement peaks at (0, 0).
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.evaluate(() => {
  // Radar only — other imagery would pollute the "is this radar" test.
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
});
await page.waitForTimeout(7000);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

// Flatten the camera and match the Leaflet view so screen space is comparable.
await page.evaluate(() => {
  const gl = window.RadarLoop.gl();
  const m = window.RadarLoop.map();
  const c = m.getCenter();
  gl.jumpTo({ center: [c.lng, c.lat], zoom: m.getZoom() - 1, pitch: 0, bearing: 0 });
});
await page.waitForTimeout(9000);

const result = await page.evaluate(async () => {
  const gl = window.RadarLoop.gl();
  const m = window.RadarLoop.map();
  const capture = window.RadarLoop.mirrorStats().lastCapture;
  if (!capture) return { error: 'no capture recorded' };

  const isRadar = (d, i) => {
    if (d[i + 3] < 110) return false;
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    const max = Math.max(r, g, b);
    return max >= 90 && max - Math.min(r, g, b) >= 70;
  };

  /* ---- source image ---- */
  // The capture is now a live canvas, so its pixels are read directly.
  const sc = capture.canvas;
  const src = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;

  /* ---- rendered 3D frame ---- */
  const canvas = gl.getCanvas();
  const gc = document.createElement('canvas');
  gc.width = canvas.width; gc.height = canvas.height;
  gc.getContext('2d').drawImage(canvas, 0, 0);
  const glData = gc.getContext('2d').getImageData(0, 0, gc.width, gc.height).data;
  const dpr = canvas.width / gl.getContainer().clientWidth;

  /* ---- sample grid over the captured bounds, inset to stay on screen ---- */
  const b = capture.bounds;
  const COLS = 70;
  const ROWS = 46;
  const inset = 0.12;
  const samples = [];

  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const fx = inset + (c / (COLS - 1)) * (1 - 2 * inset);
      const fy = inset + (r / (ROWS - 1)) * (1 - 2 * inset);

      // Source pixel -> projected -> lat/lon, in the capture's own frame.
      const px = fx * capture.width;
      const py = fy * capture.height;
      // Capture pixels are scaled down from projected pixels; undo that.
      const ll = m.unproject(
        L.point(capture.originX + px / capture.scale, capture.originY + py / capture.scale),
        capture.zoom,
      );

      const si = ((py | 0) * sc.width + (px | 0)) * 4;
      const screen = gl.project([ll.lng, ll.lat]);
      samples.push({ src: isRadar(src, si), sx: screen.x, sy: screen.y });
    }
  }

  const srcHits = samples.filter((s) => s.src).length;
  if (srcHits < 40) return { error: `too little radar to correlate (${srcHits} samples)` };

  /* ---- cross-correlate over candidate offsets ---- */
  const sampleGl = (x, y) => {
    const gx = Math.round(x * dpr);
    const gy = Math.round(y * dpr);
    if (gx < 0 || gy < 0 || gx >= gc.width || gy >= gc.height) return null;
    return isRadar(glData, (gy * gc.width + gx) * 4);
  };

  const RANGE = 72;
  const STEP = 3;
  let best = { dx: 0, dy: 0, score: -1 };
  let zero = 0;
  const scores = [];

  for (let dy = -RANGE; dy <= RANGE; dy += STEP) {
    for (let dx = -RANGE; dx <= RANGE; dx += STEP) {
      let both = 0;
      let either = 0;
      for (const s of samples) {
        const g = sampleGl(s.sx + dx, s.sy + dy);
        if (g === null) continue;
        if (s.src && g) both += 1;
        if (s.src || g) either += 1;
      }
      const score = either ? both / either : 0;
      scores.push(score);
      if (dx === 0 && dy === 0) zero = score;
      if (score > best.score) best = { dx, dy, score };
    }
  }

  scores.sort((a, b) => a - b);
  return {
    srcHits,
    total: samples.length,
    best,
    zeroScore: zero,
    // Agreement at a typical wrong offset — the noise floor this run.
    medianScore: scores[Math.floor(scores.length / 2)],
    offset: Math.hypot(best.dx, best.dy),
  };
});

console.log('\n=== radar placement in 3D (cross-correlation) ===');
if (result.error) {
  ok(`the placement check could run (${result.error})`, false, result.error);
} else {
  console.log(`  radar samples      ${result.srcHits} of ${result.total}`);
  console.log(`  best agreement at  dx=${result.best.dx} dy=${result.best.dy}  (score ${result.best.score.toFixed(3)})`);
  console.log(`  agreement at (0,0) ${result.zeroScore.toFixed(3)}  (noise floor ${result.medianScore.toFixed(3)})`);
  console.log(`  displacement       ${result.offset.toFixed(1)} px`);

  // Scale-free on purpose. Absolute agreement depends on how much echo happens
  // to be on screen — a quiet day leaves a few small cells whose edges dominate
  // the overlap — so what is asserted is that aligning the two views agrees far
  // better than misaligning them does.
  ok('aligning the two views agrees far better than any wrong offset',
     result.zeroScore >= Math.max(0.08, result.medianScore * 3),
     `zero ${result.zeroScore.toFixed(3)} vs noise floor ${result.medianScore.toFixed(3)}`);
  ok('agreement peaks at zero offset (the radar is not displaced)',
     result.offset <= 6, `peak at ${result.best.dx},${result.best.dy}`);
  ok('placing it unshifted is as good as the best shift',
     result.zeroScore >= result.best.score * 0.9,
     `zero=${result.zeroScore.toFixed(3)} best=${result.best.score.toFixed(3)}`);
}

try { await page.screenshot({ path: 'shots/3d-placement.png' }); } catch {}

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
