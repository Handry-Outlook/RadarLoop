/**
 * Verifies the rewritten modules against the legacy implementation:
 *  - every module parses and imports under a stubbed browser environment
 *  - URL time-token expansion produces byte-identical URLs
 *  - the rainfall colour lookup picks the same bucket
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the source tree relative to this file, so the script runs from anywhere.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'radarloop', 'src') + '/').href;
const LEGACY = join(ROOT, 'UK (9).html');

// --- minimal browser stubs -------------------------------------------------
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
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.L = {
  Map: { mergeOptions() {} },
  GridLayer: { mergeOptions() {} },
  Layer: { extend: (proto) => proto },
  TileLayer: { extend: (proto) => proto },
  canvas: () => ({}),
};

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures += 1; console.log(`  FAIL ${name}\n    got      ${JSON.stringify(actual)}\n    expected ${JSON.stringify(expected)}`); }
  return ok;
};

// --- 1. every module imports ----------------------------------------------
const modules = [
  'config.js', 'core/util.js', 'core/bus.js', 'core/state.js',
  'data/layers.js', 'data/palettes.js', 'data/basemaps.js',
  'layers/urlTemplate.js', 'layers/resolver.js', 'layers/radarScale.js',
  'layers/opera.js', 'layers/windy.js', 'layers/geojson.js', 'layers/wms.js',
  'lightning/nowcast.js', 'lightning/source.js', 'time/controller.js', 'hoco/risk.js',
];
console.log('=== module imports ===');
for (const m of modules) {
  try {
    await import(`${SRC}${m}`);
    console.log(`  ok   ${m}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${m} -> ${error.message}`);
  }
}

// --- 2. token expansion vs legacy formatters ------------------------------
console.log('\n=== URL token expansion (vs legacy formatters) ===');
const { expandUrl } = await import(SRC + 'layers/urlTemplate.js');

// Legacy formatters, copied verbatim from the original file.
const formatISO = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const formatISO2 = (d) => d.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const formatISOms = (d) => d.toISOString();
const formatWindyIso = (d) => {
  const r = new Date(d); r.setMinutes(Math.floor(r.getMinutes() / 10) * 10, 0, 0);
  return r.toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15) + '00';
};
const formatWindyMaxt = (d) => {
  const r = new Date(d); r.setMinutes(Math.floor(r.getMinutes() / 10) * 10, 0, 0);
  return new Date(r.getTime() + 4 * 60 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
};
const getWindyRadarFrameTime = (d) => { const r = new Date(d); r.setUTCMinutes(Math.floor(r.getUTCMinutes() / 5) * 5, 0, 0); return r; };
const p2 = (n) => String(n).padStart(2, '0');
const formatWindyRadarPart = (d, part) => {
  const f = getWindyRadarFrameTime(d);
  if (part === 'YYYY') return String(f.getUTCFullYear());
  if (part === 'MM') return p2(f.getUTCMonth() + 1);
  if (part === 'DD') return p2(f.getUTCDate());
  if (part === 'HHmm') return p2(f.getUTCHours()) + p2(f.getUTCMinutes());
  return '';
};
const formatWindyRadarMaxt = (d) => {
  const m = new Date(getWindyRadarFrameTime(d).getTime() + (4 * 60 + 51) * 1000);
  return String(m.getUTCFullYear()) + p2(m.getUTCMonth() + 1) + p2(m.getUTCDate()) + p2(m.getUTCHours()) + p2(m.getUTCMinutes()) + p2(m.getUTCSeconds());
};
const formatOperaTime = (v) => {
  const d = new Date(v); d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5, 0, 0);
  return String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes());
};

const legacyExpand = (url, d) => url
  .replace(/\$\{isoMs\}/g, formatISOms(d))
  .replace(/\$\{iso\}/g, formatISO(d))
  .replace(/\$\{iso2\}/g, formatISO2(d))
  .replace(/\$\{windyIso\}/g, formatWindyIso(d))
  .replace(/\$\{windyMaxt\}/g, formatWindyMaxt(d))
  .replace(/\$\{windyRadarYYYY\}/g, formatWindyRadarPart(d, 'YYYY'))
  .replace(/\$\{windyRadarMM\}/g, formatWindyRadarPart(d, 'MM'))
  .replace(/\$\{windyRadarDD\}/g, formatWindyRadarPart(d, 'DD'))
  .replace(/\$\{windyRadarHHmm\}/g, formatWindyRadarPart(d, 'HHmm'))
  .replace(/\$\{windyRadarMaxt\}/g, formatWindyRadarMaxt(d))
  .replace(/\$\{operaTime\}/g, formatOperaTime(d));

const { LAYER_CATALOG } = await import(SRC + 'data/layers.js');
const sampleDates = [
  new Date('2026-09-08T14:37:23.412Z'),
  new Date('2026-01-01T00:02:00.000Z'),
  new Date('2026-12-31T23:58:41.999Z'),
  new Date('2026-06-15T12:00:00.000Z'),
];
let urlsChecked = 0, urlMismatch = 0;
for (const group of Object.values(LAYER_CATALOG)) {
  for (const [key, def] of Object.entries(group)) {
    if (key === '__order' || !def.url) continue;
    for (const d of sampleDates) {
      urlsChecked += 1;
      const mine = expandUrl(def.url, d);
      const legacy = legacyExpand(def.url, d);
      if (mine !== legacy) {
        urlMismatch += 1; failures += 1;
        if (urlMismatch <= 5) console.log(`  FAIL ${key}\n    new    ${mine}\n    legacy ${legacy}`);
      }
    }
  }
}
console.log(`  ${urlsChecked} URL expansions compared, ${urlMismatch} mismatches`);

// --- 3. colour bucketing vs legacy ----------------------------------------
console.log('\n=== rainfall colour bucketing (vs legacy) ===');
const scale = await import(SRC + 'layers/radarScale.js');
const levels = scale.getLevels();
const legacyColour = (mmh) => {
  for (let i = 0; i < levels.length; i += 1) if (mmh < Number(levels[i][0])) return levels[i][1];
  return levels[levels.length - 1][1];
};
let colourChecked = 0, colourMismatch = 0;
for (const mmh of [0.03, 0.031, 0.0313, 0.05, 0.0625, 0.1, 0.25, 0.9, 1, 3.9, 4, 63.9, 64, 8191, 8192, 100000]) {
  colourChecked += 1;
  const mine = scale.colourForMmh(mmh);
  const legacy = legacyColour(mmh);
  if (JSON.stringify(mine) !== JSON.stringify(legacy)) {
    colourMismatch += 1; failures += 1;
    console.log(`  FAIL mmh=${mmh}  new=${JSON.stringify(mine)} legacy=${JSON.stringify(legacy)}`);
  }
}
console.log(`  ${colourChecked} rates compared, ${colourMismatch} mismatches`);

// --- 4. dBZ conversion -----------------------------------------------------
console.log('\n=== dBZ -> mm/h ===');
const legacyDbzToMmh = (dbz) => Math.pow(Math.pow(10, dbz / 10) * 0.005, 0.625) * 0.3;
for (const dbz of [5, 20, 35, 56]) {
  check(`dbz ${dbz}`, scale.dbzToMmh(dbz).toFixed(9), legacyDbzToMmh(dbz).toFixed(9));
}
console.log(`  compared 4 values`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
