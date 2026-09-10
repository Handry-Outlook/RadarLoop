/**
 * Behavioural tests for the timeline domain, the time filter and outlook focus.
 * Runs headless against the real modules with a stubbed browser environment.
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'radarloop', 'src') + '/').href;

const store = new Map();
globalThis.navigator = { userAgent: 'node', hardwareConcurrency: 8, deviceMemory: 8 };
globalThis.window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  documentElement: { dataset: {} },
  createElement: () => ({ style: {}, setAttribute() {}, append() {}, classList: { add() {} } }),
  getElementById: (id) => (id === 'map' ? { id } : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// Leaflet stub — enough for core/map.js to evaluate at module init.
const pane = () => ({ style: {}, appendChild() {}, classList: { add() {} } });
const fakeMap = {
  attributionControl: { setPrefix() {} },
  setView() { return this; },
  getPane: () => pane(),
  createPane: () => pane(),
  on() {}, off() {}, hasLayer: () => false, removeLayer() {}, addLayer() {},
  getCenter: () => ({ lat: 53, lng: -4 }),
  getZoom: () => 5,
  getSize: () => ({ x: 1200, y: 800 }),
  getBounds: () => ({ getNorth: () => 60, getSouth: () => 48, getEast: () => 5, getWest: () => -12 }),
  getContainer: () => ({ clientWidth: 1200, clientHeight: 800 }),
  invalidateSize() {},
};
globalThis.L = {
  Map: { mergeOptions() {} },
  GridLayer: { mergeOptions() {} },
  Layer: { extend: (proto) => proto },
  TileLayer: { extend: (proto) => proto },
  map: () => fakeMap,
  canvas: () => ({}),
  tileLayer: () => ({ addTo() {}, bringToBack() {} }),
  layerGroup: () => ({ addTo() {}, clearLayers() {} }),
};

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};
const near = (a, b, tol = 90000) => Math.abs(a - b) <= tol;
const H = 3600 * 1000;

const timeCtl = await import(SRC + 'time/controller.js');
const { time, lightning } = await import(SRC + 'core/state.js');
const focus = await import(SRC + 'hoco/focus.js');
const { pruneBefore, merge } = await import(SRC + 'lightning/source.js');

/* ================================================================== *
 * 1. Live domain
 * ================================================================== */
console.log('\n=== live domain ===');
time.historyHours = 6;
timeCtl.goLive();

let d = timeCtl.domain();
ok('domain spans historyHours back from live', near(d.end - d.start, 6 * H, 5 * 60000),
   `got ${(d.end - d.start) / H} h`);
ok('not focused initially', !timeCtl.isFocused());
ok('current is at the live edge', near(time.current, timeCtl.liveTimestamp()));

/* ================================================================== *
 * 2. Time filter re-bases the scrubber  (reported bug)
 * ================================================================== */
console.log('\n=== time filter re-bases the scrubber ===');

// A window well outside the 6-hour live span: 3 days ago.
const fStart = new Date(Date.now() - 72 * H);
const fEnd = new Date(Date.now() - 70 * H);
const applied = timeCtl.applyFilter(fStart, fEnd);

ok('applyFilter succeeds', applied);
d = timeCtl.domain();
ok('domain becomes exactly the filter window',
   d.start === fStart.getTime() && d.end === fEnd.getTime(),
   `got ${new Date(d.start).toISOString()} → ${new Date(d.end).toISOString()}`);
ok('current moves to the filter end (was clamped away before)',
   time.current === fEnd.getTime(),
   `current=${new Date(time.current).toISOString()} expected=${fEnd.toISOString()}`);
ok('scrubber reports focused', timeCtl.isFocused());

// The mapping the slider uses must place `current` at the far right.
const sliderPos = ((time.current - d.start) / (d.end - d.start)) * 1000;
ok('slider maps current to the end of the track', Math.round(sliderPos) === 1000,
   `pos=${sliderPos}`);

// And a mid-domain drag must be reachable.
const mid = d.start + (d.end - d.start) / 2;
timeCtl.setTime(mid, { immediate: true });
ok('mid-window position is reachable (not clamped)', near(time.current, mid, 1000),
   `current=${new Date(time.current).toISOString()}`);

timeCtl.clearFilter();
ok('clearFilter returns to the live domain', !timeCtl.isFocused());

/* ================================================================== *
 * 3. Outlook focus — window resolution
 * ================================================================== */
console.log('\n=== outlook window resolution ===');

const past = focus.resolveWindow(new Date(Date.now() - 48 * H), new Date(Date.now() - 24 * H));
ok('a past outlook uses its full window', past && !past.live &&
   near(past.end - past.start, 24 * H));

const inForce = focus.resolveWindow(new Date(Date.now() - 4 * H), new Date(Date.now() + 8 * H));
ok('an in-force outlook is truncated to now', inForce && inForce.live &&
   near(inForce.end.getTime(), Date.now()),
   inForce ? `end=${inForce.end.toISOString()}` : 'null');
ok('an in-force outlook keeps its start', inForce && near(inForce.start.getTime(), Date.now() - 4 * H));

const future = focus.resolveWindow(new Date(Date.now() + 24 * H), new Date(Date.now() + 48 * H));
ok('a future outlook keeps its full window', future && !future.live);

ok('an invalid window is rejected', focus.resolveWindow(new Date(), new Date(Date.now() - H)) === null);

/* ================================================================== *
 * 4. Outlook focus — timeline + lifespan
 * ================================================================== */
console.log('\n=== outlook focus drives timeline and lifespan ===');

lightning.lifespanHours = 3;
const w = focus.focusOutlook(
  new Date(Date.now() - 12 * H), new Date(Date.now() - 6 * H),
  { source: focus.SOURCE_MANUAL, label: 'test' },
);
ok('focusOutlook returns the window', !!w);
ok('lifespan matches the window length', Math.abs(lightning.lifespanHours - 6) < 0.02,
   `lifespan=${lightning.lifespanHours}`);
d = timeCtl.domain();
ok('timeline domain equals the outlook window', near(d.end - d.start, 6 * H));
ok('filter window equals the outlook window',
   timeCtl.hasFilter() && near(time.filterEnd - time.filterStart, 6 * H));

// In-force outlook: lifespan should be start→now, not the full validity.
const live = focus.focusOutlook(
  new Date(Date.now() - 5 * H), new Date(Date.now() + 7 * H),
  { source: focus.SOURCE_MANUAL, label: 'test-live' },
);
ok('in-force outlook lifespan is start→now only',
   live && Math.abs(lightning.lifespanHours - 5) < 0.05,
   `lifespan=${lightning.lifespanHours}`);
ok('in-force outlook does not scrub into the future',
   timeCtl.domain().end <= Date.now() + 1000);

/* ================================================================== *
 * 5. Priority: manual outranks auto
 * ================================================================== */
console.log('\n=== manual outranks auto ===');

focus.focusOutlook(new Date(Date.now() - 10 * H), new Date(Date.now() - 8 * H),
  { source: focus.SOURCE_MANUAL, label: 'manual' });
const manualDomain = timeCtl.domain();

const blocked = focus.focusOutlook(new Date(Date.now() - 30 * H), new Date(Date.now() - 20 * H),
  { source: focus.SOURCE_AUTO, label: 'auto' });
ok('an automated run cannot take the timeline from a manual outlook', blocked === null);
ok('manual window survives', timeCtl.domain().start === manualDomain.start);
ok('lifespan unchanged by the blocked auto selection',
   Math.abs(lightning.lifespanHours - 2) < 0.02, `lifespan=${lightning.lifespanHours}`);

// Releasing the manual window frees the timeline for automated runs.
timeCtl.clearFocus();
const autoAfterRelease = focus.focusOutlook(new Date(Date.now() - 30 * H), new Date(Date.now() - 20 * H),
  { source: focus.SOURCE_AUTO, label: 'auto' });
ok('an automated run focuses once the manual window is released', autoAfterRelease !== null);
ok('timeline moved to the auto window', near(timeCtl.domain().end - timeCtl.domain().start, 10 * H));

/* ================================================================== *
 * 5b. Viewing an outlook must not change anything  (reported bug)
 * ================================================================== */
console.log('\n=== displaying an outlook does not touch the timeline ===');
timeCtl.goLive();
lightning.lifespanHours = 3;
const cleanDomain = timeCtl.domain();

// This is what the panel does on open: resolve the window, but do not focus.
const previewed = focus.resolveWindow(new Date(Date.now() - 20 * H), new Date(Date.now() + 4 * H));
ok('the window can be resolved for display', previewed !== null);
ok('resolving alone leaves the lifespan at the user setting',
   lightning.lifespanHours === 3, `lifespan=${lightning.lifespanHours}`);
ok('resolving alone leaves the timeline unfocused', !timeCtl.isFocused());
ok('resolving alone leaves the live domain intact',
   near(timeCtl.domain().end - timeCtl.domain().start, cleanDomain.end - cleanDomain.start));

/* ================================================================== *
 * 6. Lifespan restored on release
 * ================================================================== */
console.log('\n=== releasing the window restores lifespan ===');
timeCtl.goLive();
lightning.lifespanHours = 3;
focus.initOutlookFocus();
focus.focusOutlook(new Date(Date.now() - 20 * H), new Date(Date.now() - 8 * H),
  { source: focus.SOURCE_MANUAL, label: 'x' });
ok('lifespan changed while focused', Math.abs(lightning.lifespanHours - 12) < 0.02);
timeCtl.clearFilter();
ok('lifespan restored after release', Math.abs(lightning.lifespanHours - 3) < 0.02,
   `lifespan=${lightning.lifespanHours}`);

/* ================================================================== *
 * 7. Long scrubber span keeps strike history  (reported bug)
 * ================================================================== */
console.log('\n=== long span retains strike history ===');

const mk = (hoursAgo) => ({
  strike_time: new Date(Date.now() - hoursAgo * H).toISOString(),
  coordinates: [-2 + hoursAgo * 0.001, 53],
});
merge([...Array(300).keys()].map((i) => {
  const s = mk(i);
  const t = new Date(s.strike_time);
  return { ...s, time: t, ms: t.getTime(), lon: s.coordinates[0], lat: s.coordinates[1] };
}));
const loaded = lightning.all.length;
ok('seeded 300 hours of strikes', loaded === 300, `loaded=${loaded}`);

const { retentionCutoff } = await import(SRC + 'lightning/index.js');

time.historyHours = 6;
timeCtl.goLive();
let cutoff = retentionCutoff();
ok('short span still retains at least 48 h', cutoff <= Date.now() - 48 * H,
   `cutoff is ${(Date.now() - cutoff) / H} h back`);

time.historyHours = 300;
lightning.lifespanHours = 3;
timeCtl.goLive();
cutoff = retentionCutoff();
ok('300 h span retains beyond 300 h', cutoff <= Date.now() - 300 * H,
   `cutoff is ${(Date.now() - cutoff) / H} h back`);

pruneBefore(cutoff);
ok('pruning at a 300 h span keeps the old strikes', lightning.all.length === 300,
   `remaining=${lightning.all.length}`);

// The old hardcoded behaviour, for contrast.
const before = lightning.all.length;
pruneBefore(Date.now() - 48 * H);
ok('a 48 h cutoff would have discarded them (the old bug)',
   lightning.all.length < before && lightning.all.length === 48,
   `remaining=${lightning.all.length}`);

console.log(`\n${fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} of ${pass + fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
