/**
 * Regression tests for the strike merge.
 *
 * The archives are ~1.6 million strikes in one batch; the previous
 * `all.push(...fresh)` threw RangeError at that size, so no history ever loaded.
 */

import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'radarloop', 'src') + '/').href;

const store = new Map();
globalThis.navigator = { userAgent: 'node', hardwareConcurrency: 8, deviceMemory: 8 };
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {} };

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const { lightning } = await import(SRC + 'core/state.js');
const { merge, filterWindow, pruneBefore } = await import(SRC + 'lightning/source.js');

const sorted = (a) => a.every((v, i) => i === 0 || a[i - 1].ms <= v.ms);

/* ---------------- basic ---------------- */
console.log('\n=== merge basics ===');
lightning.all = [];
const base = Date.UTC(2026, 7, 27);
const mk = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
  ms: base + (i + offset) * 1000, lat: 53 + i * 1e-5, lon: -2 + i * 1e-5,
}));

merge(mk(10));
ok('first merge stores all', lightning.all.length === 10);
ok('stays sorted', sorted(lightning.all));

merge(mk(10));
ok('re-merging identical data adds nothing', lightning.all.length === 10,
   `len=${lightning.all.length}`);

merge(mk(5, 100));
ok('new strikes are added', lightning.all.length === 15, `len=${lightning.all.length}`);
ok('still sorted after interleave', sorted(lightning.all));

// Out-of-order batch spanning existing data.
merge([
  { ms: base - 5000, lat: 50, lon: -1 },
  { ms: base + 3500, lat: 51, lon: -1 },
  { ms: base + 500000, lat: 52, lon: -1 },
]);
ok('out-of-order batch merges in order', sorted(lightning.all));
ok('older-than-everything strike lands first', lightning.all[0].ms === base - 5000);

/* ---------------- the reported failure ---------------- */
console.log('\n=== 1.6 million strikes in one batch (the archive case) ===');
lightning.all = [];

const BIG = 1_600_000;
const huge = new Array(BIG);
const start = Date.UTC(2025, 2, 27);
for (let i = 0; i < BIG; i += 1) {
  huge[i] = { ms: start + i * 30000, lat: 50 + (i % 1000) * 0.001, lon: -5 + (i % 997) * 0.001 };
}

let threw = null;
const t0 = Date.now();
try {
  merge(huge);
} catch (error) {
  threw = error;
}
const elapsed = Date.now() - t0;

ok('merging 1.6M strikes does not throw', threw === null,
   threw ? `${threw.name}: ${threw.message}` : '');
ok('all 1.6M strikes stored', lightning.all.length === BIG, `len=${lightning.all.length}`);
ok('result is sorted', sorted(lightning.all));
console.log(`  merge took ${elapsed} ms`);

/* Demonstrate the old failure mode for contrast. */
let spreadThrew = null;
try {
  const target = [];
  target.push(...huge);
} catch (error) {
  spreadThrew = error;
}
ok('the previous push(...spread) approach does throw here', spreadThrew !== null,
   spreadThrew ? `${spreadThrew.name}: ${spreadThrew.message}` : 'it did not throw');

/* ---------------- merging live data on top ---------------- */
console.log('\n=== live batch merged into a large store ===');
const liveBatch = Array.from({ length: 500 }, (_, i) => ({
  ms: Date.now() - i * 1000, lat: 54, lon: -3,
}));
const t1 = Date.now();
const added = merge(liveBatch);
console.log(`  merging 500 live strikes into 1.6M took ${Date.now() - t1} ms`);
ok('live batch merged', added === 500, `added=${added}`);
ok('still sorted', sorted(lightning.all));

/* ---------------- filtering ---------------- */
console.log('\n=== window filtering ===');
const wStart = Date.UTC(2025, 2, 27, 5);
const wEnd = Date.UTC(2025, 2, 27, 6);
const t2 = Date.now();
const window = filterWindow(wStart, wEnd);
console.log(`  binary-search filter over 1.6M took ${Date.now() - t2} ms`);
ok('filter returns a plausible window', window.length === 121, `count=${window.length}`);
ok('all results inside the window',
   window.every((s) => s.ms >= wStart && s.ms <= wEnd));

/* ---------------- pruning ---------------- */
console.log('\n=== pruning ===');
const before = lightning.all.length;
const cut = Date.UTC(2025, 3, 1);
const removed = pruneBefore(cut);
ok('prune removes the old prefix', removed > 0 && lightning.all.length === before - removed);
ok('nothing older than the cutoff remains', lightning.all[0].ms >= cut);

console.log(`\n${fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} of ${pass + fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
