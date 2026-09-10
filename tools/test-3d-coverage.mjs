/**
 * The reported scenario, reproduced: zoom into Bristol in 2D with the Global
 * High Resolution radar on, switch to 3D, then zoom back out.
 *
 * The mirrored composite is a still captured from the 2D map, so if the 2D map
 * is left where it was on entry, zooming out in 3D shows radar only over Bristol
 * and nothing anywhere else — and the texture's pixel size drifts with every
 * zoom, because it is pinned at the scale the 2D map happened to be at.
 *
 * Two things are checked:
 *   1. the mirrored still covers what the camera can see after the camera moves;
 *   2. the capture's ground resolution stays in the same band across zooms,
 *      rather than degrading by the zoom factor.
 *
 * Also verifies the lightning lifespan is not silently persisted by focusing an
 * outlook — see tools/test-outlook-focus.mjs for the focus behaviour itself.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
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
await page.waitForTimeout(9000);

/* ================================================================== *
 * 1. Lightning lifespan is not inherited from a previous session
 * ================================================================== */
console.log('\n=== strike lifespan on a fresh load ===');

const initial = await page.evaluate(() => ({
  lifespan: window.RadarLoop.lightningLifespan(),
  stored: localStorage.getItem('lightningLifespan'),
}));
console.log(`  lifespan=${initial.lifespan}  stored=${initial.stored}`);
ok('a fresh load does not start at an outlook-sized lifespan',
   initial.lifespan < 12, `${initial.lifespan} h`);

// Focus an outlook window directly, the way clicking one does.
const afterFocus = await page.evaluate(() => {
  const start = new Date(Date.now() - 24 * 3600 * 1000);
  const end = new Date(Date.now() + 0.02 * 3600 * 1000);
  window.RadarLoop.focusWindow(start, end);
  return {
    lifespan: window.RadarLoop.lightningLifespan(),
    stored: localStorage.getItem('lightningLifespan'),
  };
});
console.log(`  after focusing a ~24 h outlook: lifespan=${afterFocus.lifespan} stored=${afterFocus.stored}`);
ok('focusing an outlook still sets the lifespan to the window',
   afterFocus.lifespan > 12, `${afterFocus.lifespan} h`);
ok('but it is never written to storage',
   afterFocus.stored === initial.stored,
   `stored went ${initial.stored} -> ${afterFocus.stored}`);

// A value already stored by the old bug must not come back as the default.
const migrated = await page.evaluate(async () => {
  localStorage.setItem('lightningLifespan', '23.98');
  return null;
});
void migrated;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
const reloaded = await page.evaluate(() => window.RadarLoop.lightningLifespan());
console.log(`  after a stored 23.98 and a reload: lifespan=${reloaded}`);
ok('a lifespan left behind by the old bug is discarded on load',
   reloaded < 12, `${reloaded} h`);

/* ================================================================== *
 * 2. Coverage after zooming out in 3D
 * ================================================================== */
console.log('\n=== zoom to Bristol, switch to 3D, zoom out ===');

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
  // Bristol.
  window.RadarLoop.map().setView([51.4545, -2.5879], 9, { animate: false });
});
await page.waitForTimeout(9000);

const captureAt = () => page.evaluate(() => {
  const c = window.RadarLoop.mirrorStats().lastCapture;
  const gl = window.RadarLoop.gl();
  if (!c) return null;
  const span = Math.abs(c.bounds.east - c.bounds.west);
  return {
    zoom: c.zoom,
    size: `${c.width}x${c.height}`,
    // Degrees of longitude per captured pixel: the ground resolution of the
    // still, comparable across zooms.
    degPerPx: span / c.width,
    lonSpan: span,
    glZoom: gl ? Number(gl.getZoom().toFixed(2)) : null,
    glSpan: gl ? Math.abs(gl.getBounds().getEast() - gl.getBounds().getWest()) : null,
    west: c.bounds.west,
    east: c.bounds.east,
    south: c.bounds.south,
    north: c.bounds.north,
  };
});

await page.click('#btn-3d');
await page.waitForTimeout(12000);

const near = await captureAt();
console.log(`  in 3D over Bristol: capture ${near.size} zoom ${near.zoom}, ${near.degPerPx.toExponential(2)} deg/px`);

// Zoom the camera out, the way the user did.
await page.evaluate(() => window.RadarLoop.gl().jumpTo({ zoom: 4, pitch: 45 }));
await page.waitForTimeout(11000);

const far = await captureAt();
console.log(`  zoomed out:         capture ${far.size} zoom ${far.zoom}, ${far.degPerPx.toExponential(2)} deg/px`);
console.log(`  camera span ${far.glSpan.toFixed(1)}° vs capture span ${far.lonSpan.toFixed(1)}°`);

ok('the capture followed the camera out',
   far.zoom < near.zoom, `zoom ${near.zoom} -> ${far.zoom}`);
ok('the still covers what the camera can see',
   far.lonSpan >= far.glSpan * 0.9,
   `capture ${far.lonSpan.toFixed(1)}° vs camera ${far.glSpan.toFixed(1)}°`);

// The capture is viewport-sized either way, so degrees-per-pixel must track the
// camera's own scale rather than staying pinned at the entry zoom.
const drift = far.degPerPx / near.degPerPx;
const cameraDrift = far.glSpan / (near.glSpan || 1);
const ratio = drift / cameraDrift;
console.log(`  resolution changed ${drift.toFixed(1)}x while the camera changed ${cameraDrift.toFixed(1)}x (ratio ${ratio.toFixed(2)})`);
// Two-sided on purpose. Too high means the still is coarser than the camera;
// too low means it never moved and is simply being stretched, which is the
// "pixel size is not consistent" half of the report.
ok('capture resolution tracks the camera rather than the entry zoom',
   ratio > 0.4 && ratio < 1.8,
   `capture ${drift.toFixed(2)}x, camera ${cameraDrift.toFixed(2)}x, ratio ${ratio.toFixed(2)}`);

// And the radar is actually drawn out there, not just covered on paper.
const drew = await page.evaluate(() => window.RadarLoop.mirrorStats().lastDrew);
ok('tiles were composited for the wider view', drew > 0, `lastDrew=${drew}`);

await page.click('#btn-3d');
await page.waitForTimeout(2000);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
