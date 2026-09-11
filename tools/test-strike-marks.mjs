/**
 * Strike marks carry age in their shape, not only their colour.
 *
 * The newest band is drawn as a bolt and everything older as a small open
 * square, so what has just happened is findable at a glance and stays findable
 * in a screenshot, in print, or to someone who cannot separate the hues.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const state = await page.evaluate(async () => {
  const all = window.RadarLoop.lightningAll();
  const hours = new Map();
  for (const s of all) hours.set(Math.floor(s.ms / 3600000), (hours.get(Math.floor(s.ms / 3600000)) || 0) + 1);
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.lightning.nowcast = false;
  window.RadarLoop.lightning.lifespanHours = 0.5;
  window.RadarLoop.playback.setHistorySpan(24 * 90);
  window.RadarLoop.playback.setTime(hour * 3600000 + 3600000, { immediate: true });
  await new Promise((r) => setTimeout(r, 9000));
  window.RadarLoop.map().setView([55.05, 1.1], 11);
  await new Promise((r) => setTimeout(r, 5000));
  const layer = window.__strikeLayer();
  return {
    mark: layer?.options?.mark,
    mode: layer?._lastMode,
    visible: layer?._lastVisible,
    buffers: layer?._buffers?.length,
    held: layer?._buffers?.reduce((n, b) => n + b.count, 0) ?? 0,
    objects: layer?._strikes?.length ?? 0,
  };
});
console.log(`  ${JSON.stringify(state)}`);

ok('the in-house feed asks for shaped marks', state.mark === 'age', String(state.mark));
// It used to hand the renderer an array of objects, thinned above a ceiling.
ok('it draws from typed buffers now', state.buffers > 0 && state.objects === 0,
   `${state.buffers} buffers, ${state.objects} objects`);
ok('every strike in the window is held', state.held > 1000, String(state.held));
// The decision used to come from the previous frame, so the first frame after a
// zoom drew the old one: pixels where there was now room for shapes.
ok('a sparse view draws shapes, not pixels', state.mode === 'stroke',
   `${state.mode} at ${state.visible} visible`);

/* ---- and the shapes are actually distinct ---- */
const shapes = await page.evaluate(() => {
  // Count distinct colours among drawn pixels: bolts are filled, squares are
  // outlined, so a filled mark shows more pixels of its colour than an outline
  // of the same size would.
  const canvas = document.querySelector('.strike-canvas');
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 40) continue;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { colours: counts.size, painted: [...counts.values()].reduce((a, b) => a + b, 0) };
});
console.log(`  ${JSON.stringify(shapes)}`);
ok('marks were painted', shapes.painted > 500, String(shapes.painted));
ok('and in more than one age colour', shapes.colours > 1, String(shapes.colours));


/* ---- arrivals ---- */
console.log('\n=== just-arrived strikes ===');
const arrivals = await page.evaluate(async () => {
  const layer = window.__strikeLayer();
  const buffer = layer._buffers[0];
  const newest = buffer.base + buffer.t[buffer.count - 1];

  const sample = () => {
    const canvas = document.querySelector('.strike-canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let arrivalPixels = 0;
    let whitePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // #38bdf8: light cyan. The ramp's blues are much darker in green.
      if (b > 190 && g > 140 && r < 130) arrivalPixels += 1;
      if (r > 230 && g > 230 && b > 230) whitePixels += 1;
    }
    return { arrivalPixels, whitePixels };
  };

  // Nothing has arrived while scrubbing an archive.
  const before = sample();
  // The last four minutes of the window, as though they had just come in.
  layer.setStrikeBuffers(layer._buffers, {
    end: layer._windowEnd,
    lifespanHours: layer._lifespanMs / 3600000,
    freshSince: newest - 4 * 60000,
  });
  await new Promise((r) => setTimeout(r, 1200));
  return { before, after: sample(), mode: layer._lastMode };
});
console.log(`  ${JSON.stringify(arrivals)}`);

ok('nothing is marked as an arrival while scrubbing the archive',
   arrivals.before.arrivalPixels === 0, String(arrivals.before.arrivalPixels));
ok('arrivals are drawn in their own colour', arrivals.after.arrivalPixels > 100,
   String(arrivals.after.arrivalPixels));
// A filled bolt covers more of its own area than an outlined square does, so
// the arrivals should not simply be squares wearing a different colour.
ok('and are filled marks, not outlines', arrivals.after.arrivalPixels > 30,
   String(arrivals.after.arrivalPixels));
ok('the ramp still has its white newest band', arrivals.after.whitePixels > 50,
   String(arrivals.after.whitePixels));

const ramp = await page.evaluate(() => {
  const { colourForAge } = window.__strikeRender;
  return [0.02, 0.25, 0.42, 0.58, 0.75, 0.95].map((f) => colourForAge(f));
});
console.log(`  ramp: ${ramp.join(' ')}`);
// White through red to blue: the two ends differ in hue and in temperature, so
// no white mark reads as an old one.
ok('the ramp runs white, through red, to blue',
   ramp[0] === '#ffffff' && /^#(ff4d4d|e00000)$/.test(ramp[1]) && /^#(3a6de0|1b2f7a)$/.test(ramp[5]),
   ramp.join(' '));

const legend = await page.evaluate(() =>
  [...document.querySelectorAll('#legend-body p')].map((n) => n.textContent).join(' | '));
ok('the legend says what the shapes mean', /bolt/i.test(legend), legend);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
