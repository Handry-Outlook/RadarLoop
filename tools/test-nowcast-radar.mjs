/**
 * The nowcast's radar-derived motion.
 *
 * The old algorithm had one source for a storm's velocity: the drift of its own
 * strike centroid between five-minute bins. Strikes are scattered across the
 * whole convective area, so that centroid jitters by kilometres for reasons
 * unrelated to where the storm is going, and a cell with six flashes in a bin
 * produced a velocity fitted to six points of noise.
 *
 * Radar answers it properly, by finding the displacement that lines up two
 * reflectivity fields a quarter of an hour apart. The core of that is testable
 * exactly: shift a synthetic field by a known amount and the answer is known.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

console.log('\n=== displacement ===');

const shifts = await page.evaluate(() => {
  const { bestShift } = window.__nowcast;
  const SIZE = 160;
  /** A field of smooth blobs — a stand-in for convective cells. */
  const build = (cells, offsetX, offsetY) => {
    const f = new Float32Array(SIZE * SIZE);
    for (const [cx, cy, radius, peak] of cells) {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const dx = x - (cx + offsetX);
          const dy = y - (cy + offsetY);
          const d2 = dx * dx + dy * dy;
          if (d2 > radius * radius * 4) continue;
          f[y * SIZE + x] += peak * Math.exp(-d2 / (2 * radius * radius));
        }
      }
    }
    return f;
  };

  const cells = [[60, 70, 9, 30], [95, 55, 6, 18], [72, 104, 7, 22]];
  const out = {};
  for (const [name, dx, dy] of [['east 7', 7, 0], ['north 5', 0, -5], ['south-west', -6, 9], ['still', 0, 0]]) {
    const a = build(cells, 0, 0);
    const b = build(cells, dx, dy);
    const found = bestShift(a, b, SIZE, 24);
    out[name] = {
      want: [dx, dy],
      got: found ? [found.dx, found.dy] : null,
      prominence: found ? +found.prominence.toFixed(3) : null,
    };
  }

  const gradient = (seed) => {
    const f = new Float32Array(SIZE * SIZE);
    let r = seed;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        f[y * SIZE + x] = 8 + x * 0.02 + y * 0.01 + (r / 0x7fffffff - 0.5) * 0.4;
      }
    }
    return f;
  };
  const flatMatch = bestShift(gradient(1), gradient(7), SIZE, 24);
  out.flat = { prominence: flatMatch ? +flatMatch.prominence.toFixed(4) : null };
  return out;
});
console.log(`  ${JSON.stringify(shifts)}`);

for (const name of ['east 7', 'north 5', 'south-west', 'still']) {
  const r = shifts[name];
  ok(`a ${name} displacement is recovered exactly`,
     r.got && r.got[0] === r.want[0] && r.got[1] === r.want[1],
     `wanted ${JSON.stringify(r.want)}, got ${JSON.stringify(r.got)}`);
}
ok('a distinct field gives a prominent peak', shifts['east 7'].prominence > 0.3,
   String(shifts['east 7'].prominence));
// The guard that stops uniform rain being read as a motion measurement.
ok('widespread featureless rain does not', (shifts.flat.prominence ?? 1) < 0.12,
   String(shifts.flat.prominence));

console.log('\n=== a real measurement ===');
const live = await page.evaluate(async () => {
  const { measureMotion } = window.__nowcast;
  // Somewhere convective, tried in turn; whether any has a storm right now is
  // weather, so the check is on the shape of an answer, not on getting one.
  const spots = [[52, -1.5], [45, 10], [-25, -60], [0, 15], [35, -95], [-6, 107]];
  const out = [];
  for (const [lat, lon] of spots) {
    // eslint-disable-next-line no-await-in-loop
    const m = await measureMotion(lat, lon, Date.now());
    if (m) {
      out.push({
        lat, lon,
        speed: +m.speedKmH.toFixed(1),
        dir: +m.directionDeg.toFixed(0),
        quality: +m.quality.toFixed(2),
        trend: +m.trend.toFixed(2),
      });
    }
  }
  return out;
});
console.log(`  ${JSON.stringify(live)}`);
if (!live.length) {
  console.log('  skip no radar echo at any probe point just now — nothing to measure');
} else {
  ok('measured speeds are physical', live.every((m) => m.speed >= 0 && m.speed < 200),
     JSON.stringify(live.map((m) => m.speed)));
  ok('bearings are bearings', live.every((m) => m.dir >= 0 && m.dir < 360),
     JSON.stringify(live.map((m) => m.dir)));
  ok('and each cleared the quality floor', live.every((m) => m.quality >= 0 && m.quality <= 1),
     JSON.stringify(live.map((m) => m.quality)));
}

console.log('\n=== end to end ===');
const run = await page.evaluate(async () => {
  const { calculateNowcast, resetRadarHints, radarHints } = window.__nowcast;
  resetRadarHints();
  // A synthetic cell tracking east-north-east over the UK, so the check does not
  // depend on there being a storm today.
  const now = Date.now();
  const strikes = [];
  for (let step = 0; step < 24; step += 1) {
    const ms = now - (24 - step) * 5 * 60 * 1000;
    for (let i = 0; i < 9; i += 1) {
      strikes.push({
        ms: ms + i * 1000,
        lat: 52.5 + step * 0.02 + (i % 3) * 0.03 - 0.03,
        lon: -1.8 + step * 0.05 + Math.floor(i / 3) * 0.04 - 0.04,
      });
    }
  }
  const before = calculateNowcast(strikes, new Date(now));
  await new Promise((r) => setTimeout(r, 9000));
  const after = calculateNowcast(strikes, new Date(now));
  return {
    clusters: before.length,
    first: before[0] && {
      speed: +before[0].speedKmH.toFixed(1),
      dir: +before[0].directionDeg.toFixed(0),
      source: before[0].motionSource,
      confidence: +before[0].confidence.toFixed(2),
    },
    afterRadar: after[0] && {
      speed: +after[0].speedKmH.toFixed(1),
      dir: +after[0].directionDeg.toFixed(0),
      source: after[0].motionSource,
    },
    hints: radarHints().length,
  };
});
console.log(`  ${JSON.stringify(run)}`);
ok('a moving cell produces a projection', run.clusters > 0, `${run.clusters}`);
// The synthetic track moves 0.05 of longitude per 0.02 of latitude each step,
// which is a bearing in the sixties.
ok('and it is heading the way the strikes went',
   run.first && run.first.dir > 40 && run.first.dir < 90, String(run.first?.dir));
ok('radar was asked about it', run.hints > 0, `${run.hints}`);
ok('and the answer says which sources were used',
   ['lightning', 'radar+lightning'].includes(run.afterRadar?.source), String(run.afterRadar?.source));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
