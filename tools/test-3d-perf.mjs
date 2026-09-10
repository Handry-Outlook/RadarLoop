/**
 * Three things about the Global High Resolution radar:
 *
 *   1. a product with no data at NOW still resolves to its latest frame rather
 *      than drawing nothing;
 *   2. scrubbing in 3D costs about what it costs in 2D (the "laggy as hell"
 *      complaint);
 *   3. 3D renders the composite at the same resolution as 2D — an earlier speed
 *      fix bought its margin by rendering tiles at half the device pixel ratio
 *      and downsampling the mirror to 1280px, which is no longer the case.
 *
 * Timings are compared 2D against 3D *within the same run* rather than against a
 * fixed millisecond budget, because headless Chromium rasterises WebGL on the CPU
 * through SwiftShader — there, 3D measures several times 2D regardless of what
 * the application does. Run with HEADED=1 to measure on the real GPU.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const headed = process.env.HEADED === '1';
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1000);

const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
const software = /swiftshader|llvmpipe|software/i.test(renderer);
console.log(`  renderer: ${renderer}`);
if (software) console.log('  (software GL — 3D timings below measure the renderer, not the app; use HEADED=1)');

await page.waitForTimeout(9000);

/* ================================================================== *
 * 1. Latest-frame fallback
 * ================================================================== */
console.log('\n=== products with no data at NOW ===');

// Marine and forecast grids publish hourly or slower, so "now" is usually empty.
const candidates = ['fcst-manta-current-direction-grid', 'fcst-manta-mean-wave-direction-grid'];
const fallback = await page.evaluate(async (types) => {
  const out = [];
  for (const type of types) {
    window.RadarLoop.selectProduct('wind', type);
    await new Promise((r) => setTimeout(r, 12000));
    const slot = window.RadarLoop.slots.get('wind');
    out.push({
      type,
      drew: !!slot.front,
      url: (slot.lastUrl || '').slice(-46),
      staleHours: slot.lastTimestamp ? (Date.now() - slot.lastTimestamp) / 3600000 : null,
    });
    window.RadarLoop.setLayerEnabled('wind', false);
    await new Promise((r) => setTimeout(r, 800));
  }
  return out;
}, candidates);

for (const r of fallback) {
  console.log(`  ${r.type}`);
  console.log(`     drew=${r.drew} stale=${r.staleHours === null ? '—' : `${r.staleHours.toFixed(1)}h`}  ${r.url}`);
}
ok('slow-publishing products still draw something',
   fallback.every((r) => r.drew), JSON.stringify(fallback.map((r) => [r.type, r.drew])));
ok('they resolve to a real past frame rather than "now"',
   fallback.some((r) => (r.staleHours ?? 0) > 0.1),
   fallback.map((r) => r.staleHours?.toFixed(2)).join(', '));

/* ================================================================== *
 * 2. Scrub cost and resolution, 2D against 3D
 * ================================================================== */
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.selectProduct('radar', 'windy-radar');
});
await page.waitForTimeout(8000);

/** Times scrubber steps, counting only those that actually change frame. */
const scrub = (steps) => page.evaluate(async (n) => {
  const slider = document.querySelector('.timeline__scrub .range');
  const out = [];
  let skipped = 0;

  // Neighbouring slider positions can land on the same 10-minute frame, where
  // there is nothing to load. Timing those measured the harness's own deadline
  // and is where the multi-second "stalls" in earlier runs came from.
  for (let i = 1; out.length < n && i < 60; i += 1) {
    const prevUrl = window.RadarLoop.slots.get('radar').lastUrl;
    const t0 = performance.now();
    slider.value = String(Number(slider.max) - i * 14);
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    let changed = false;
    while (performance.now() - t0 < 20000) {
      const s = window.RadarLoop.slots.get('radar');
      if (s.lastUrl && s.lastUrl !== prevUrl && s.front) { changed = true; break; }
      if (performance.now() - t0 > 1500 && !window.RadarLoop.tileWorkers().inFlight) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
    if (changed) out.push(Math.round(performance.now() - t0));
    else skipped += 1;
  }
  return { out, skipped };
}, steps);

/** Backing-store size of a rendered radar tile, in device pixels. */
const tileResolution = () => page.evaluate(() => {
  const el = document.querySelector('canvas.windy-radar-tile');
  const capture = window.RadarLoop.mirrorStats().lastCapture;
  return {
    dpr: window.devicePixelRatio,
    backing: el ? el.width : null,
    css: el ? Math.round(el.getBoundingClientRect().width) : null,
    captureScale: capture ? capture.scale : null,
    captureSize: capture ? `${capture.width}x${capture.height}` : null,
  };
});

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

console.log('\n=== scrub cost ===');
const flat = await scrub(5);
const flatMedian = median(flat.out);
const res2d = await tileResolution();
console.log(`  2D  median=${flatMedian}ms  ${flat.out.join(', ')}  (${flat.skipped} same-frame skipped)`);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

const solid = await scrub(5);
const solidMedian = median(solid.out);
const res3d = await tileResolution();
console.log(`  3D  median=${solidMedian}ms  ${solid.out.join(', ')}  (${solid.skipped} same-frame skipped)`);
console.log(`  overhead: ${solidMedian - flatMedian}ms (${((solidMedian / flatMedian - 1) * 100).toFixed(0)}%)`);

const workers = await page.evaluate(() => window.RadarLoop.tileWorkers());
const perf = await page.evaluate(() => ({
  bytes: window.RadarLoop.mirrorStats().lastBytes,
  kind: window.RadarLoop.mirrorKind ? window.RadarLoop.mirrorKind('radar') : null,
}));

console.log('\n=== resolution ===');
console.log(`  2D tile ${res2d.backing}px backing for ${res2d.css}px css (dpr ${res2d.dpr})`);
console.log(`  3D tile ${res3d.backing}px backing for ${res3d.css}px css`);
console.log(`  mirror capture ${res3d.captureSize} at scale ${res3d.captureScale}`);
console.log(`  tile workers ${JSON.stringify(workers)}`);

ok('the radar mirrors through a canvas source (no PNG encode)', perf.kind === 'canvas', `kind=${perf.kind}`);
ok('no data URL is being produced per frame', !perf.bytes, `lastBytes=${perf.bytes}`);
ok('tiles are decoded off the main thread', workers.workers > 0 && workers.decoded > 0,
   JSON.stringify(workers));
ok('3D renders tiles at the same resolution as 2D',
   res3d.backing === res2d.backing, `2D=${res2d.backing} 3D=${res3d.backing}`);
// Compared against the ratio the tiles were actually rendered at rather than
// window.devicePixelRatio, which browsers can report with float noise.
ok('the mirrored composite samples tiles 1:1, not downscaled',
   res3d.captureScale >= res3d.backing / 256 - 0.001,
   `scale=${res3d.captureScale} tileRatio=${res3d.backing / 256}`);

// Renderer-relative, because software GL makes any absolute budget meaningless.
if (software) {
  console.log('  skip 3D scrubbing costs about what 2D costs (software GL cannot answer this)');
} else {
  ok('3D scrubbing costs about what 2D costs',
     solidMedian <= flatMedian * 2 + 250, `2D=${flatMedian}ms 3D=${solidMedian}ms`);
}

await page.click('#btn-3d');
await page.waitForTimeout(2000);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
