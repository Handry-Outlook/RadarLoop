/**
 * A scrubbed supercell is called hail.
 *
 * The radar layer draws archived echoes, but the sampler asked the live endpoint
 * for everything and that serves about two hours. So scrubbing to a storm from
 * two weeks ago measured nothing: no reflectivity, no motion, "Motion from
 * strikes" in the popup, and no hail estimate at all — which looked like the
 * thresholds being too strict when the input was missing entirely.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
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
await page.waitForFunction(() => {
  const n = window.RadarLoop?.lightningAll?.().length ?? 0;
  const settled = n > 0 && n === window.__lastCount;
  window.__lastCount = n;
  return settled;
}, { timeout: 90000, polling: 3000 });

// The 27 August supercell over the Chilterns.
const at = Date.parse('2026-08-27T16:20:00Z');

const measured = await page.evaluate(async (atMs) => {
  const { measureMotion } = window.__nowcast;
  const m = await measureMotion(51.75, -0.75, atMs);
  return m ? { peakDbz: Math.round(m.peakDbz), largeHailArea: +(m.largeHailArea * 100).toFixed(3) } : null;
}, at);
console.log(`  radar at the storm: ${JSON.stringify(measured)}`);
ok('the sampler reaches a two-week-old frame', measured !== null, String(measured));
ok('and finds the core the layer is drawing', measured && measured.peakDbz >= 55,
   `${measured?.peakDbz} dBZ`);

const drawn = await page.evaluate(async (atMs) => {
  const l = window.RadarLoop.lightning;
  l.nowcast = true;
  l.nowcastConfidence = 0;
  l.lifespanHours = 2;
  window.RadarLoop.playback.setHistorySpan(24 * 30);
  window.RadarLoop.map().setView([51.75, -0.75], 8);
  window.RadarLoop.playback.setTime(atMs, { immediate: true });

  const sample = () => (window.__nowcastClusters?.() ?? []).map((c) => ({
    size: c.clusterSize,
    rate: +c.flashesPerMinute.toFixed(1),
    peakDbz: c.peakDbz === null ? null : Math.round(c.peakDbz),
    hail: c.hail ? c.hail.label : null,
    source: c.motionSource,
  }));

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (sample().some((c) => c.peakDbz !== null)) break;
  }
  return sample();
}, at);
console.log(`  clusters: ${JSON.stringify(drawn)}`);

ok('the storm is tracked', drawn.length > 0, JSON.stringify(drawn));
ok('and the projection has reflectivity for it',
   drawn.some((c) => c.peakDbz !== null), JSON.stringify(drawn));
// The report: a supercell that produced three to four centimetre hail, drawn as
// an ordinary tracked cell.
ok('a supercell core is called hail',
   drawn.some((c) => c.hail && /likely/i.test(c.hail)),
   JSON.stringify(drawn.map((c) => [c.peakDbz, c.rate, c.hail])));
await page.screenshot({ path: 'shots/hail-archive.png' });

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
