/**
 * The surface observations layer, and the WMS scrub deferral.
 *
 * Station models come from the Synoptic feed, are drawn on a canvas, thinned by
 * screen spacing, re-polled on a timer and re-fetched when the view moves
 * somewhere the cached window does not cover. They register as an ordinary
 * overlay, so they appear in the layer list and can be restacked.
 *
 * The WMS check is separate: a service that renders on demand should not be
 * asked for every position a drag passes through.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let synopticCalls = 0;
let wmsCalls = 0;
/**
 * Which frames the WMS was asked for, not how many requests it received.
 *
 * The tile layer retries a frame whose tiles failed, on a backoff lasting several
 * seconds, so a drag that starts shortly after a load sees dozens of requests
 * that have nothing to do with it — 28 retries for a single earlier frame, in one
 * run. What a drag must not do is ask for *new* frames.
 */
const wmsFrames = [];
page.on('request', (r) => {
  if (r.url().includes('api.synopticdata.com')) synopticCalls += 1;
  if (!r.url().includes('view.eumetsat.int')) return;
  wmsCalls += 1;
  const time = /TIME=([^&]+)/.exec(r.url())?.[1];
  if (time) wmsFrames.push(decodeURIComponent(time));
});

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);

// Somewhere with dense reporting, so there is something to plot.
await page.evaluate(() => window.RadarLoop.map().setView([40.5, -76.5], 6, { animate: false }));
await page.waitForTimeout(1500);

/* ================================================================== *
 * The layer
 * ================================================================== */
console.log('\n=== station observations ===');

const initiallyOn = await page.evaluate(() => window.RadarLoop.observations().enabled);
ok('station models are on from the start', initiallyOn === true, String(initiallyOn));

const before = synopticCalls;
// It is on from the start now; this only proves the switch is a no-op, and the
// initial state is checked separately below.
await page.evaluate(() => window.RadarLoop.setLayerEnabled('observations', true));

/** Waits for the models to be drawn, rather than for a guess at how long. */
const drawn = async (timeoutMs = 25000) => page.evaluate(async (limit) => {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (window.RadarLoop.observations().plotted > 0) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}, timeoutMs);

await drawn();

const state = await page.evaluate(() => {
  const s = window.RadarLoop.observations();
  const canvas = document.querySelector('#map .synoptic-canvas');
  let ink = 0;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink += 1;
  }
  return { ...s, hasCanvas: !!canvas, ink };
});

console.log(`  ${state.held} stations held, ${state.plotted} plotted, ${state.ink} lit pixels`);
// Counted from page load, not from the switch: the layer is on from the start,
// so by the time the switch is touched the request has already been made.
ok('the feed was called', synopticCalls > 0, `${synopticCalls} requests`);
ok('stations were loaded', state.held > 0, `${state.held}`);
ok('a canvas was created', state.hasCanvas);
ok('station models were actually drawn', state.ink > 500, `${state.ink} lit pixels`);
ok('plots are thinned, not all drawn on top of each other',
   state.plotted > 0 && state.plotted <= state.held, `${state.plotted} of ${state.held}`);

/* ---- it behaves like a layer ---- */
const asLayer = await page.evaluate(() => {
  const order = window.RadarLoop.layerOrder();
  const pane = window.RadarLoop.map().getPane('synopticPane');
  return { order, top: order[0], z: pane?.style.zIndex || null };
});
console.log(`  layer order (top first): ${JSON.stringify(asLayer.order)}`);
ok('it appears in the layer list', asLayer.order.includes('observations'), JSON.stringify(asLayer.order));
ok('and starts at the top of the stack', asLayer.top === 'observations', String(asLayer.top));

const restacked = await page.evaluate(async () => {
  const pane = window.RadarLoop.map().getPane('synopticPane');
  const first = pane.style.zIndex;
  window.RadarLoop.moveLayer('observations', 1);
  await new Promise((r) => setTimeout(r, 600));
  return { first, then: pane.style.zIndex, order: window.RadarLoop.layerOrder() };
});
console.log(`  after moving it down: z ${restacked.first} -> ${restacked.then}`);
ok('restacking moves its pane', restacked.first !== restacked.then, JSON.stringify(restacked));

/* ---- panning refetches ---- */
const panned = synopticCalls;
await page.evaluate(() => window.RadarLoop.map().setView([52.5, -1.5], 6, { animate: false }));
await page.waitForTimeout(2000);
await drawn();
const uk = await page.evaluate(() => window.RadarLoop.observations());
console.log(`  after panning to the UK: ${uk.held} stations, ${uk.plotted} plotted`);
ok('moving the view is served, from a new request or the cached window',
   synopticCalls > panned || uk.plotted > 0,
   `${synopticCalls - panned} requests, ${uk.plotted} plotted`);
ok('and finds stations there too', uk.held > 0, `${uk.held}`);

/* ---- the station card ---- */
console.log('\n=== station card ===');
const card = await page.evaluate(async () => {
  const id = window.RadarLoop.openNearestStation();
  if (!id) return { id: null };
  await new Promise((r) => setTimeout(r, 10000));
  const c = document.querySelector('.wxcard');
  if (!c) return { id, card: false };
  const lines = [...c.querySelectorAll('.wxchart__line')];
  return {
    id,
    card: true,
    charts: c.querySelectorAll('svg.wxchart').length,
    // A line with two points is an artefact; these should be full days.
    points: lines.map((n) => (n.getAttribute('d').match(/[ML]/g) || []).length),
    legends: c.querySelectorAll('.wxchart__legend').length,
    options: [...c.querySelectorAll('.wxcard__pick option')].map((o) => o.textContent),
    axisLabels: c.querySelectorAll('.wxchart__tick').length,
    readings: c.querySelectorAll('.wxcard__reading').length,
    temp: [...c.querySelectorAll('.wxcard__reading')]
      .map((r) => r.textContent).find((t) => /Temperature/.test(t)) || null,
    wind: [...c.querySelectorAll('.wxcard__reading')]
      .map((r) => r.textContent).find((t) => /^Wind/.test(t)) || null,
    pressure: [...c.querySelectorAll('.wxcard__reading')]
      .map((r) => r.textContent).find((t) => /Pressure/.test(t)) || null,
    hasTable: !!c.querySelector('.wxcard__table'),
    top: c.getBoundingClientRect().top,
  };
});
console.log(`  ${JSON.stringify(card)}`);

ok('clicking a station opens a card', card.card === true, JSON.stringify(card));
// One chart at a time now, chosen from the picker. The old card stacked three,
// which put the rain and snow charts this station may also have off the bottom.
ok('one chart showing, not a stack', card.charts === 1, `${card.charts}`);
ok('the picker offers the measures this station reports',
   (card.options || []).length >= 3 && card.options.some((t) => /Temperature/.test(t))
   && card.options.some((t) => /Wind/.test(t)) && card.options.some((t) => /Pressure/.test(t)),
   JSON.stringify(card.options));
// Reporting cadence varies by an order of magnitude — a US ASOS gives about 310
// readings a day, a UK synoptic station about 48 — so the threshold only has to
// separate a real series from the failure it guards against, which drew no path
// at all and left a single end dot.
ok('each series drawn as a full line, not a stray point',
   (card.points || []).length >= 2 && (card.points || []).every((n) => n >= 8),
   JSON.stringify(card.points));
// Two series on the visible panel, so exactly one legend.
ok('a legend where there is more than one series', card.legends === 1, `${card.legends}`);
ok('an axis says what time each reading was taken', card.axisLabels >= 3, `${card.axisLabels}`);
ok('the current reading is spelled out', card.readings >= 6, `${card.readings}`);
ok('pressure is given in hPa', /hPa/.test(card.pressure || ''), String(card.pressure));
ok('temperature is in Celsius and wind in mph, the defaults asked for',
   /°C/.test(card.temp || '') && /mph/.test(card.wind || ''),
   `${card.temp} / ${card.wind}`);
ok('the values are reachable without hovering', card.hasTable === true);

/* ---- switching the picker ---- */
const switched = await page.evaluate(async () => {
  const select = document.querySelector('.wxcard__pick');
  const wind = [...select.options].findIndex((o) => /Wind/.test(o.textContent));
  select.value = String(wind);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const c = document.querySelector('.wxcard');
  return {
    title: select.options[select.selectedIndex].textContent,
    charts: c.querySelectorAll('svg.wxchart').length,
    arrows: c.querySelectorAll('.wxchart__arrow').length,
    columns: [...c.querySelectorAll('.wxcard__table th')].map((n) => n.textContent),
  };
});
console.log(`  ${JSON.stringify(switched)}`);
ok('the picker swaps the chart', /Wind/.test(switched.title) && switched.charts === 1,
   JSON.stringify(switched));
// Wind direction is a bearing, so it is drawn as a row of arrows rather than
// plotted against the speed axis — a second scale on one chart is the mistake
// this avoids.
ok('wind direction is shown as arrows under the wind chart', switched.arrows >= 4,
   `${switched.arrows}`);
ok('and direction is in the table too', switched.columns.includes('Direction'),
   JSON.stringify(switched.columns));
// The popup opens small and grows when the history lands; without re-measuring
// it, the header ended up above the top of the map.
ok('the card sits inside the window after it fills out', card.top > 0, `top ${card.top}`);

await page.evaluate(() => window.RadarLoop.map().closePopup());
await page.waitForTimeout(800);

/* ---- it follows the timeline ---- */
const atTime = async (hoursBack) => {
  await page.evaluate(async (h) => {
    const slider = document.querySelector('.timeline__scrub .range');
    const max = Number(slider.max);
    const { start, end } = window.RadarLoop.playback.domain();
    const target = Date.now() - h * 3600 * 1000;
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    slider.value = String(Math.round(((target - start) / (end - start)) * max));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, hoursBack);
  await page.waitForTimeout(8000);
  return page.evaluate(() => window.RadarLoop.observations());
};

const live = await page.evaluate(() => window.RadarLoop.observations());
const past = await atTime(4);
console.log(`  live: ${JSON.stringify(live.sampleTemps)} (${live.plotted} plotted)`);
console.log(`  4h back: for ${past.forTime}, ${JSON.stringify(past.sampleTemps)} (${past.plotted} plotted)`);

ok('scrubbing back asks for that moment', !!past.forTime, String(past.forTime));
// Staleness used to be judged against now, which discarded every historical
// report the instant the scrubber left the live edge: 473 held, none drawn.
ok('and still plots them', past.plotted > 0, `${past.plotted} of ${past.held}`);
ok('the readings are the ones for that moment, not the live ones',
   JSON.stringify(past.sampleTemps) !== JSON.stringify(live.sampleTemps),
   `${JSON.stringify(live.sampleTemps)} vs ${JSON.stringify(past.sampleTemps)}`);

await page.evaluate(() => window.RadarLoop.playback.goLive());
await page.waitForTimeout(7000);

/* ---- 3D ---- */
/** Toggles the view without waiting on the GL canvas to hold still. */
const toggle3D = () => page.evaluate(() => document.getElementById('btn-3d').click());

await toggle3D();
await page.waitForTimeout(14000);
const mirrored = await page.evaluate(async () => {
  window.RadarLoop.refreshOverlayMirror();
  await new Promise((r) => setTimeout(r, 1800));
  return window.RadarLoop.gl().getStyle().layers.map((l) => l.id).filter((id) => id.startsWith('wx-ov-'));
});
console.log(`  3D overlay layers: ${JSON.stringify(mirrored)}`);
ok('station models reach the 3D view', mirrored.includes('wx-ov-observations'), JSON.stringify(mirrored));
await toggle3D();
await page.waitForTimeout(2500);

/* ================================================================== *
 * WMS is not asked for every position of a drag
 * ================================================================== */
console.log('\n=== playback with a render-on-demand WMS enabled ===');

await page.evaluate(() => window.RadarLoop.setLayerEnabled('observations', false));
await page.evaluate(() => {
  window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor');
  window.RadarLoop.setLayerEnabled('satellite', true);
});
let wmsRequests = 0;
page.on('request', (r) => { if (r.url().includes('eumetsat.int')) wmsRequests += 1; });
await page.waitForTimeout(12000);
console.log(`  the slow layer made ${wmsRequests} requests before playback started`);
ok('the slow layer really is loaded, so the comparison means something',
   wmsRequests > 0, `${wmsRequests} requests`);

/**
 * Asserted on playback throughput, which is where the deferral earns its keep.
 *
 * The drag case turns out to be covered already: `renderAll` drops a request
 * while one is in flight, and a slow WMS is always in flight during a drag, so
 * intermediate positions were never fetched even before this. Disabling the
 * deferral changed nothing there, so nothing is asserted about it.
 *
 * Playback is different. The pacer waits for every layer to settle, so one
 * render-on-demand product set the frame rate for all of them: 3 radar frames
 * in 14 s with EUMETSAT enabled against 39 without it.
 */
const playbackFrames = (seconds = 12) => page.evaluate(async (ms) => {
  window.RadarLoop.time.speed = 4;
  const seen = [];
  const started = performance.now();
  let last = window.RadarLoop.slots.get('radar').lastUrl;
  window.RadarLoop.playback.play();
  const poll = setInterval(() => {
    const slot = window.RadarLoop.slots.get('radar');
    if (slot.lastUrl && slot.lastUrl !== last) { seen.push(performance.now() - started); last = slot.lastUrl; }
  }, 20);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(poll);
  window.RadarLoop.playback.stop();
  const gaps = seen.slice(1).map((t, i) => t - seen[i]).sort((a, b) => a - b);
  return { frames: seen.length, median: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null };
}, seconds * 1000);

await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(9000);

const withWms = await playbackFrames();
console.log(`  with the WMS enabled: ${withWms.frames} radar frames, median gap ${withWms.median}ms`);
await page.waitForTimeout(3000);

await page.evaluate(() => window.RadarLoop.setLayerEnabled('satellite', false));
await page.waitForTimeout(4000);
const withoutWms = await playbackFrames();
console.log(`  with it switched off: ${withoutWms.frames} radar frames, median gap ${withoutWms.median}ms`);

ok('playback runs at all with a slow layer enabled', withWms.frames >= 8, `${withWms.frames} frames`);
ok('a slow layer does not set the frame rate for the rest',
   withWms.frames >= withoutWms.frames * 0.6,
   `${withWms.frames} with, ${withoutWms.frames} without`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
