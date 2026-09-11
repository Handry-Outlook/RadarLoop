/**
 * A storm with a hail core is called one, without anything else happening first.
 *
 * The first nowcast pass never has radar: the measurement for a cluster is only
 * requested once that cluster exists, so it lands afterwards. It used to announce
 * itself on the filtered-strikes event, which only the timeline footer listens
 * to — so the memo cleared, the measurement sat in the cache, and nothing
 * recomputed. A storm with an obvious hail core stayed drawn as an ordinary
 * tracked cell until some unrelated redraw happened by.
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

/* ---- find somewhere with a real convective core right now ---- */
const target = await page.evaluate(async () => {
  const { measureMotion } = window.__nowcast;
  const payload = await (await fetch('https://node.windy.com/blitz/v3/hot', { cache: 'no-store' })).json();
  const G = 1 << 18;
  const inCoverage = (lat, lon) =>
    (lat > 35 && lat < 70 && lon > -12 && lon < 35)
    || (lat > 24 && lat < 52 && lon > -126 && lon < -66)
    || (lat > -45 && lat < -10 && lon > 112 && lon < 155);
  const cells = new Map();
  for (const r of payload.hotQueue.values) {
    const lat = (r[2] / G) * 180 - 90;
    const lon = (r[1] / G) * 360 - 180;
    if (!inCoverage(lat, lon)) continue;
    const key = `${Math.round(lat * 2)}|${Math.round(lon * 2)}`;
    const c = cells.get(key) || { lat: 0, lon: 0, n: 0 };
    c.lat += lat; c.lon += lon; c.n += 1;
    cells.set(key, c);
  }
  for (const cell of [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 6)) {
    const lat = cell.lat / cell.n;
    const lon = cell.lon / cell.n;
    // eslint-disable-next-line no-await-in-loop
    const m = await measureMotion(lat, lon, Date.now());
    if (m && m.peakDbz >= 50) return { lat, lon, peakDbz: Math.round(m.peakDbz), strikes: cell.n };
  }
  return null;
});
console.log(`  target: ${JSON.stringify(target)}`);
if (!target) {
  console.log('\n  no convective core inside radar coverage right now — nothing to reproduce against');
  await browser.close();
  process.exit(0);
}
ok('found a storm with a core worth calling hail on', target.peakDbz >= 50, `${target.peakDbz} dBZ`);

/* ---- put a vigorous storm there and let the nowcast see it ---- */
const result = await page.evaluate(async ({ lat, lon }) => {
  const now = Date.now();
  const made = [];
  // Ninety minutes of a cell tracking east, flashing hard.
  for (let step = 0; step < 18; step += 1) {
    const minutes = (18 - step) * 5;
    for (let i = 0; i < 60; i += 1) {
      made.push({
        ms: now - minutes * 60000 + i * 4000,
        lat: lat + step * 0.01 + ((i % 5) - 2) * 0.015,
        lon: lon + step * 0.02 + (Math.floor(i / 5) - 5) * 0.015,
      });
    }
  }
  const l = window.RadarLoop.lightning;
  l.all = [...l.all, ...made].sort((a, b) => a.ms - b.ms);
  l.nowcast = true;
  l.nowcastConfidence = 0;
  l.lifespanHours = 2;
  window.RadarLoop.map().setView([lat, lon], 7);

  const sample = () => (window.__nowcastClusters?.() ?? []).map((c) => ({
    size: c.clusterSize,
    rate: +c.flashesPerMinute.toFixed(1),
    peakDbz: c.peakDbz === null ? null : Math.round(c.peakDbz),
    hail: c.hail ? c.hail.label : null,
    risk: c.hail ? +c.hail.risk.toFixed(2) : null,
  }));

  window.RadarLoop.playback.setTime(now, { immediate: true });
  await new Promise((r) => setTimeout(r, 1200));
  const firstPass = sample();

  const startedAt = performance.now();
  let elapsedMs = null;
  for (let i = 0; i < 120; i += 1) {
    if (sample().some((c) => c.peakDbz !== null)) {
      elapsedMs = Math.round(performance.now() - startedAt);
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return { firstPass, afterRadar: sample(), elapsedMs };
}, target);
console.log(`  first pass:  ${JSON.stringify(result.firstPass)}`);
console.log(`  after radar: ${JSON.stringify(result.afterRadar)}  (${result.elapsedMs}ms)`);

ok('the storm is tracked', result.afterRadar.length > 0, JSON.stringify(result.afterRadar));
// The whole point: this arrives without the user doing anything.
ok('radar reaches it at all', result.afterRadar.some((c) => c.peakDbz !== null),
   JSON.stringify(result.afterRadar));
// The listener is what makes this prompt. Without it the measurement sits in
// the cache until an unrelated redraw collects it.
ok('and promptly, rather than when something else happens by',
   result.elapsedMs !== null && result.elapsedMs < 6000, `${result.elapsedMs}ms`);
ok('and a deep core with a high flash rate is called hail',
   result.afterRadar.some((c) => c.hail && /possible|likely/i.test(c.hail)),
   JSON.stringify(result.afterRadar.map((c) => [c.peakDbz, c.rate, c.hail, c.risk])));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
