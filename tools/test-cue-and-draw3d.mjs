/**
 * Two reports: no thunder, and hand-drawn polygons missing from 3D.
 *
 * The cue had two separate faults. The setting was never persisted, so it reset
 * to off on every reload — most of why it never seemed to work. And the gate
 * only counted strikes arriving from the live poll, at the live edge, with
 * playback stopped: with a poll every few minutes and a quiet spell over the UK
 * that is hours of silence, and scrubbing forward through a storm made no sound
 * at all. What it should guard against is a bulk plot, not ordinary activity.
 *
 * The polygons were registered as an orderable layer but never added to the list
 * of panes the 3D mirror captures, so they existed everywhere except the GL view.
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
await page.waitForTimeout(13000);

// A real gesture, so the autoplay policy lets audio start at all.
await page.mouse.click(650, 420);
await page.waitForTimeout(400);

/* ================================================================== *
 * The cue
 * ================================================================== */
console.log('\n=== thunder cue ===');

const before = await page.evaluate(() => window.RadarLoop.strikeCueState().soundOn);
console.log(`  cue starts ${before ? 'on' : 'off'}`);

// Through the real control, which lives in the lightning panel.
await page.click('.rail__btn[data-group="lightning"]');
await page.waitForTimeout(1200);

const toggled = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.switch-row')]
    .find((n) => /thunder/i.test(n.textContent || ''));
  const input = row?.querySelector('input[type="checkbox"]');
  if (!input) return null;
  if (!input.checked) input.click();
  return { checked: input.checked, stored: localStorage.getItem('radarloop:lightningSound') };
});
console.log(`  after switching it on: ${JSON.stringify(toggled)}`);
ok('the cue has a control', !!toggled);
ok('switching it on writes the setting through', toggled?.stored === 'true',
   `stored=${toggled?.stored}`);

await page.waitForTimeout(500);

/** Injects strikes at the live edge and reports what the cue did. */
const inject = (count) => page.evaluate(async (n) => {
  const all = window.RadarLoop.lightningAll();
  const now = Date.now();
  for (let i = 0; i < n; i += 1) all.push({ ms: now - i, lat: 52.5 + i * 0.01, lon: -1.9 });
  window.RadarLoop.refreshLightning({ force: true, fromData: true });
  await new Promise((r) => setTimeout(r, 900));
  return window.RadarLoop.strikeCueState();
}, count);

const one = await inject(1);
console.log(`  one new strike: ${JSON.stringify(one)}`);
ok('a single new strike sounds the cue', one.played === true, JSON.stringify(one));

// A burst of arrivals must not become a burst of claps. `refresh` is throttled
// at 90ms, so ten calls in a second are ten redraws; the cue has its own
// minimum gap on top of that.
const burst = await page.evaluate(async () => {
  const all = window.RadarLoop.lightningAll();
  let played = 0;
  let redraws = 0;
  for (let i = 0; i < 12; i += 1) {
    all.push({ ms: Date.now(), lat: 53 + i * 0.02, lon: -2.2 });
    window.RadarLoop.refreshLightning({ force: true, fromData: true });
    await new Promise((r) => setTimeout(r, 100));
    const s = window.RadarLoop.strikeCueState();
    if (s.fresh > 0) redraws += 1;
    if (s.played === true) played += 1;
  }
  return { played, redraws };
});
console.log(`  twelve arrivals over ~1.2s: ${burst.redraws} redraws, ${burst.played} cues`);
ok('a burst of arrivals is spaced out, not machine-gunned',
   burst.played <= 4, JSON.stringify(burst));

await page.waitForTimeout(900);
const bulk = await inject(400);
console.log(`  400 at once: fresh=${bulk.fresh} bulk=${bulk.bulk} played=${bulk.played}`);
ok('a bulk plot is recognised as bulk', bulk.bulk === true, JSON.stringify(bulk));
ok('and does not sound the cue', bulk.played !== true, JSON.stringify(bulk));

// Scrubbing forward reveals strikes that are new to the view; that should sound
// too, which is the case the old gate missed entirely.
await page.waitForTimeout(900);
const scrubbed = await page.evaluate(async () => {
  const slider = document.querySelector('.timeline__scrub .range');
  const max = Number(slider.max);
  // Step back, then forward again so strikes re-enter the window.
  slider.value = String(Math.round(max * 0.55));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1400));

  const seen = [];
  for (const fraction of [0.62, 0.7, 0.78]) {
    slider.value = String(Math.round(max * fraction));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const s = window.RadarLoop.strikeCueState();
    seen.push({ fresh: s.fresh, bulk: s.bulk, played: !!s.played });
  }
  return seen;
});
console.log(`  scrubbing forward: ${JSON.stringify(scrubbed)}`);
const revealed = scrubbed.filter((s) => s.fresh > 0 && !s.bulk);
if (revealed.length) {
  ok('strikes revealed by scrubbing also sound the cue',
     revealed.some((s) => s.played), JSON.stringify(scrubbed));
} else {
  console.log('  skip no strikes were revealed by scrubbing in this window');
}

// The setting has to survive a reload — this is the half that made it look
// permanently broken.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
const persisted = await page.evaluate(() => window.RadarLoop.strikeCueState().soundOn);
console.log(`  after a reload the cue is ${persisted ? 'still on' : 'off again'}`);
ok('the cue setting survives a reload', persisted === true, String(persisted));

/* ================================================================== *
 * Drawn polygons in 3D
 * ================================================================== */
console.log('\n=== hand-drawn polygons in 3D ===');

await page.mouse.click(650, 420);
await page.waitForTimeout(300);

const drawn = await page.evaluate(async () => {
  const map = window.RadarLoop.map();
  const c = map.getCenter();
  // Through the real entry point, so it is styled and filed like a drawn shape.
  window.RadarLoop.addPolygon(L.polygon([
    [c.lat - 2, c.lng - 4], [c.lat + 2, c.lng - 4],
    [c.lat + 2, c.lng + 4], [c.lat - 2, c.lng + 4],
  ]));
  await new Promise((r) => setTimeout(r, 1200));
  return {
    count: window.RadarLoop.drawnCount(),
    painted: !!map.getPane('drawPane')?.querySelector('canvas'),
  };
});
console.log(`  2D: ${JSON.stringify(drawn)}`);
ok('the shape is drawn in 2D', drawn.count > 0 && drawn.painted, JSON.stringify(drawn));

await page.click('#btn-3d');
await page.waitForTimeout(13000);

const mirrored = await page.evaluate(async () => {
  window.RadarLoop.refreshOverlayMirror();
  await new Promise((r) => setTimeout(r, 1600));
  const ids = window.RadarLoop.gl().getStyle().layers.map((l) => l.id);
  return {
    overlayLayers: ids.filter((id) => id.startsWith('wx-ov-')),
    drawings: ids.includes('wx-ov-drawings'),
  };
});
console.log(`  3D overlay layers: ${JSON.stringify(mirrored.overlayLayers)}`);
ok('the drawn shape reaches the 3D view', mirrored.drawings === true,
   JSON.stringify(mirrored));

// And a polygon drawn *in* 3D shows up there too, without leaving the view.
const drawnIn3d = await page.evaluate(async () => {
  const start = window.RadarLoop.drawnCount();
  window.RadarLoop.startDrawing();
  await new Promise((r) => setTimeout(r, 500));

  const gl = window.RadarLoop.gl();
  const canvas = gl.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const [x, y] of [[w * 0.35, h * 0.4], [w * 0.55, h * 0.4], [w * 0.55, h * 0.55], [w * 0.35, h * 0.55]]) {
    gl.fire('click', { lngLat: gl.unproject([x, y]), point: { x, y } });
    await new Promise((r) => setTimeout(r, 120));
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise((r) => setTimeout(r, 1800));

  const ids = gl.getStyle().layers.map((l) => l.id);
  return {
    added: window.RadarLoop.drawnCount() - start,
    mirrored: ids.includes('wx-ov-drawings'),
  };
});
console.log(`  drawn in 3D: ${JSON.stringify(drawnIn3d)}`);
ok('a polygon drawn in 3D is created', drawnIn3d.added > 0, JSON.stringify(drawnIn3d));
ok('and is visible in the 3D view', drawnIn3d.mirrored === true, JSON.stringify(drawnIn3d));

await page.click('#btn-3d');
await page.waitForTimeout(1500);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
