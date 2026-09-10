/**
 * This round's reports, as checks.
 *
 *   1. Outlooks and drawn shapes appear in the layer list and can be restacked,
 *      with the automated outlook preset above satellite and below radar, and
 *      the manual one above it.
 *   2. Polygons can be drawn in 3D, and what comes out is the same object the
 *      2D tool produces.
 *   3. The drawing toolbar does not sit on top of the rail or the top bar.
 *   4. Rail and top-bar icons are drawn, not text glyphs.
 *   5. The location marker uses the application's popup, not a bare default.
 *   6. On a phone the readout matches the thumb while dragging.
 */

import { chromium, devices } from 'playwright';

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
await page.waitForTimeout(11000);

/* ================================================================== *
 * Icons
 * ================================================================== */
console.log('\n=== icons ===');
const icons = await page.evaluate(() => {
  const rail = [...document.querySelectorAll('.rail__btn')];
  const top = ['btn-locate', 'btn-legend', 'btn-theme', 'btn-help', 'btn-3d']
    .map((id) => [id, !!document.getElementById(id)?.querySelector('svg.icon')]);
  return {
    railTotal: rail.length,
    railDrawn: rail.filter((b) => b.querySelector('svg.icon')).length,
    railText: rail.filter((b) => b.textContent.trim().length > 0).map((b) => b.textContent.trim()),
    top,
  };
});
console.log(`  rail: ${icons.railDrawn}/${icons.railTotal} drawn, leftover text ${JSON.stringify(icons.railText)}`);
console.log(`  top bar: ${JSON.stringify(icons.top)}`);
ok('every rail button uses a drawn icon', icons.railDrawn === icons.railTotal,
   `${icons.railDrawn}/${icons.railTotal}`);
ok('no rail button falls back to a text glyph', icons.railText.length === 0,
   JSON.stringify(icons.railText));
ok('the top bar uses drawn icons too', icons.top.every(([, has]) => has),
   JSON.stringify(icons.top));

/* ================================================================== *
 * Outlooks and drawings in the layer list
 * ================================================================== */
console.log('\n=== outlooks and drawings as layers ===');

const listed = await page.evaluate(async () => {
  window.RadarLoop.setLayerEnabled('outlookAuto', true);
  window.RadarLoop.setLayerEnabled('outlookManual', true);
  await new Promise((r) => setTimeout(r, 900));
  return {
    order: window.RadarLoop.layerOrder(),
    autoZ: window.RadarLoop.map().getPane('hocoFillPane')?.style.zIndex,
    manualZ: window.RadarLoop.map().getPane('publishedOutlookFillPane')?.style.zIndex,
    satelliteZ: window.RadarLoop.map().getPane('satellitePane')?.style.zIndex,
    radarZ: window.RadarLoop.map().getPane('radarPane')?.style.zIndex,
  };
});
console.log(`  active order (top first): ${JSON.stringify(listed.order)}`);
console.log(`  panes: satellite=${listed.satelliteZ} auto=${listed.autoZ} manual=${listed.manualZ} radar=${listed.radarZ}`);

ok('the automated outlook is a layer', listed.order.includes('outlookAuto'), JSON.stringify(listed.order));
ok('the manual outlook is a layer', listed.order.includes('outlookManual'), JSON.stringify(listed.order));

const n = Number;
ok('automated outlook sits above satellite', n(listed.autoZ) > n(listed.satelliteZ),
   `${listed.autoZ} vs ${listed.satelliteZ}`);
ok('automated outlook sits below radar', n(listed.autoZ) < n(listed.radarZ),
   `${listed.autoZ} vs ${listed.radarZ}`);
ok('manual outlook sits above the automated one', n(listed.manualZ) > n(listed.autoZ),
   `${listed.manualZ} vs ${listed.autoZ}`);

// And the rows really render.
await page.click('.rail__btn[data-group="layers"]');
await page.waitForTimeout(900);
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('.layer-row')].map((r) => r.dataset.group));
console.log(`  layer rows: ${JSON.stringify(rows)}`);
ok('the outlook rows are rendered in the panel',
   rows.includes('outlookAuto') && rows.includes('outlookManual'), JSON.stringify(rows));

// Reordering one of them must move its panes.
const restacked = await page.evaluate(async () => {
  const before = window.RadarLoop.map().getPane('hocoFillPane').style.zIndex;
  window.RadarLoop.moveLayer('outlookAuto', -1);
  await new Promise((r) => setTimeout(r, 600));
  return { before, after: window.RadarLoop.map().getPane('hocoFillPane').style.zIndex };
});
console.log(`  automated outlook pane z: ${restacked.before} -> ${restacked.after}`);
ok('reordering an outlook moves its panes', restacked.before !== restacked.after,
   JSON.stringify(restacked));

/* ================================================================== *
 * Drawing
 * ================================================================== */
console.log('\n=== drawing ===');

await page.click('.rail__btn[data-group="tools"]');
await page.waitForTimeout(900);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start drawing');
  btn?.click();
});
await page.waitForTimeout(1200);

const toolbar = await page.evaluate(() => {
  const bar = document.querySelector('.leaflet-draw');
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const overlaps = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return false;
    const o = el.getBoundingClientRect();
    return r.right > o.left && o.right > r.left && r.bottom > o.top && o.bottom > r.top;
  };
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y) },
    overRail: overlaps('#rail'),
    overTopbar: overlaps('.topbar'),
    overPanel: overlaps('#panel'),
    overTimeline: overlaps('#timeline'),
  };
});
console.log(`  toolbar: ${JSON.stringify(toolbar)}`);
ok('the drawing toolbar exists', !!toolbar);
ok('it does not sit over the rail', toolbar && !toolbar.overRail);
ok('it does not sit over the top bar', toolbar && !toolbar.overTopbar);
ok('it does not sit over the open panel', toolbar && !toolbar.overPanel);
ok('it does not sit over the timeline', toolbar && !toolbar.overTimeline,
   JSON.stringify(toolbar));

// Stop 2D drawing, switch to 3D, and draw there.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop drawing');
  btn?.click();
});
await page.waitForTimeout(700);
await page.click('#btn-3d');
await page.waitForTimeout(12000);

const drew3d = await page.evaluate(async () => {
  const before = window.RadarLoop.drawnCount();
  window.RadarLoop.startDrawing();
  await new Promise((r) => setTimeout(r, 600));
  const started = window.RadarLoop.isDrawing();

  // Four corners around the middle of the GL canvas, then close on Enter.
  const gl = window.RadarLoop.gl();
  const canvas = gl.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const at = (x, y) => gl.unproject([x, y]);
  for (const [x, y] of [[w * 0.4, h * 0.45], [w * 0.6, h * 0.45], [w * 0.6, h * 0.6], [w * 0.4, h * 0.6]]) {
    gl.fire('click', { lngLat: at(x, y), point: { x, y } });
    await new Promise((r) => setTimeout(r, 120));
  }
  const preview = !!gl.getLayer('wx-draw-progress-fill');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise((r) => setTimeout(r, 900));

  return {
    started,
    preview,
    before,
    after: window.RadarLoop.drawnCount(),
    previewGone: !gl.getLayer('wx-draw-progress-fill'),
    stillDrawing: window.RadarLoop.isDrawing(),
  };
});
console.log(`  3D draw: ${JSON.stringify(drew3d)}`);
ok('drawing starts in 3D', drew3d.started);
ok('a preview is shown while placing corners', drew3d.preview);
ok('closing the ring creates a polygon', drew3d.after > drew3d.before,
   `${drew3d.before} -> ${drew3d.after}`);
ok('the preview is cleaned up afterwards', drew3d.previewGone);
ok('drawing mode ends with the shape', !drew3d.stillDrawing);

// The shape is a normal drawn layer: it shows in the layer list.
const drawnListed = await page.evaluate(() => window.RadarLoop.layerOrder());
console.log(`  order with a drawing: ${JSON.stringify(drawnListed)}`);
ok('the drawn shape is listed as a layer', drawnListed.includes('drawings'),
   JSON.stringify(drawnListed));
// A shape you just drew has to be visible, not filed underneath the weather.
ok('a new drawing lands above the weather, not beneath it',
   drawnListed.indexOf('drawings') < drawnListed.indexOf('satellite'),
   JSON.stringify(drawnListed));

await page.click('#btn-3d');
await page.waitForTimeout(2000);

/* ================================================================== *
 * Location popup
 * ================================================================== */
console.log('\n=== location ===');
const located = await page.evaluate(async () => {
  window.RadarLoop.showLocation({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 45 } });
  await new Promise((r) => setTimeout(r, 1400));
  const popup = document.querySelector('.leaflet-popup-content .wx-popup');
  return {
    styled: !!popup,
    shell: !!document.querySelector('.wx-popup-shell'),
    rows: popup ? popup.querySelectorAll('.wx-popup__rows dd').length : 0,
    text: popup ? popup.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
  };
});
console.log(`  popup: ${JSON.stringify(located)}`);
ok('the location popup uses the application shell', located.styled && located.shell,
   JSON.stringify(located));
ok('it reports coordinates and accuracy', located.rows >= 3, `${located.rows} rows`);

/* ================================================================== *
 * Phone scrubber
 * ================================================================== */
console.log('\n=== phone: readout follows the thumb ===');
const phone = await browser.newPage({ ...devices['iPhone 13'] });
phone.on('pageerror', (e) => errors.push(`[phone] ${e.message}`));
await phone.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await phone.waitForTimeout(12000);

const drag = await phone.evaluate(async () => {
  const slider = document.querySelector('.timeline__scrub .range');
  const clock = document.querySelector('.timeline__clock');
  const samples = [];

  // A touch drag: touchstart, then a series of input events, as the browser
  // produces them. Touch does not focus the element, which is what used to let
  // the write-back fight the finger.
  slider.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
  for (const fraction of [0.8, 0.6, 0.4, 0.25]) {
    slider.value = String(Math.round(Number(slider.max) * fraction));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    samples.push({ value: Number(slider.value), clock: clock.textContent });
  }
  slider.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));

  return {
    samples,
    // The thumb must still be where the finger left it, and the readout must
    // agree with it.
    finalValue: Number(slider.value),
    finalClock: clock.textContent,
    expected: Number(slider.max) * 0.25,
  };
});
console.log(`  samples: ${JSON.stringify(drag.samples)}`);
console.log(`  final value ${drag.finalValue} (expected about ${Math.round(drag.expected)}), clock ${drag.finalClock}`);

const monotonic = drag.samples.every((s, i) => i === 0 || s.value < drag.samples[i - 1].value);
ok('the thumb stays where the drag put it', monotonic, JSON.stringify(drag.samples.map((s) => s.value)));
ok('the thumb is not snapped back after the drag',
   Math.abs(drag.finalValue - drag.expected) <= Number.isFinite(drag.expected) ? 4 : 0,
   `${drag.finalValue} vs ${Math.round(drag.expected)}`);
ok('each position produced a distinct readout',
   new Set(drag.samples.map((s) => s.clock)).size === drag.samples.length,
   JSON.stringify(drag.samples.map((s) => s.clock)));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
