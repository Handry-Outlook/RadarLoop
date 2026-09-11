/**
 * Cell separation, direction and lifetime.
 *
 * Each is checked against a synthetic case whose answer is known, because real
 * storms do not come with a key. Two cells built forty kilometres apart are two
 * cells; a track built heading 070 is heading 070; a flash rate halving every
 * ten minutes has a calculable time left.
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

console.log('\n=== telling cells apart ===');
const cells = await page.evaluate(() => {
  const { calculateNowcast, resetRadarHints, resetNowcastHistory } = window.__nowcast;
  const now = Date.now();

  /** A cell drifting east-north-east, with a bridge of stray flashes optional. */
  const build = ({ lat0, lon0, bridgeTo = null }) => {
    const out = [];
    for (let step = 0; step < 20; step += 1) {
      const ms = now - (20 - step) * 4 * 60 * 1000;
      for (let i = 0; i < 8; i += 1) {
        out.push({
          ms: ms + i * 900,
          lat: lat0 + step * 0.012 + ((i % 3) - 1) * 0.02,
          lon: lon0 + step * 0.03 + (Math.floor(i / 3) - 1) * 0.025,
        });
      }
    }
    if (bridgeTo) {
      // Four stray flashes strung between the two cells — the chain that used to
      // weld them into one.
      for (let i = 0; i < 4; i += 1) {
        out.push({
          ms: now - 20 * 60 * 1000 + i * 60000,
          lat: lat0 + (bridgeTo.lat - lat0) * ((i + 1) / 5) + 0.12,
          lon: lon0 + (bridgeTo.lon - lon0) * ((i + 1) / 5) + 0.3,
        });
      }
    }
    return out;
  };

  const a = { lat0: 52.2, lon0: -2.4 };
  const b = { lat0: 52.35, lon0: -1.6 };
  resetRadarHints();
  resetNowcastHistory();
  const apart = calculateNowcast([...build(a), ...build(b)].sort((x, y) => x.ms - y.ms), new Date(now));
  resetRadarHints();
  resetNowcastHistory();
  const bridged = calculateNowcast(
    [...build({ ...a, bridgeTo: { lat: b.lat0, lon: b.lon0 } }), ...build(b)].sort((x, y) => x.ms - y.ms),
    new Date(now),
  );
  return {
    apart: apart.length,
    bridged: bridged.length,
    positions: apart.map((c) => [+c.baseLat.toFixed(2), +c.baseLon.toFixed(2)]),
    headings: apart.map((c) => +c.directionDeg.toFixed(0)),
  };
});
console.log(`  ${JSON.stringify(cells)}`);
ok('two cells forty kilometres apart are two cells', cells.apart === 2, `${cells.apart}`);
// The chaining failure: a handful of flashes between them used to merge both
// into a single cluster with a meaningless average position and heading.
ok('and a thin bridge of strays does not weld them together', cells.bridged === 2, `${cells.bridged}`);
ok('each keeps its own position', cells.positions.length === 2
   && Math.abs(cells.positions[0][1] - cells.positions[1][1]) > 0.3, JSON.stringify(cells.positions));

console.log('\n=== heading ===');
const headings = await page.evaluate(() => {
  const { calculateNowcast, resetRadarHints, resetNowcastHistory } = window.__nowcast;
  const now = Date.now();
  /** A cell tracking along a given bearing at a given speed. */
  const track = (bearingDeg, kmh) => {
    const out = [];
    const rad = (bearingDeg * Math.PI) / 180;
    for (let step = 0; step < 20; step += 1) {
      const minutes = (20 - step) * 4;
      const km = (kmh * (20 - step) * 4) / 60;
      const lat = 52.5 - (km * Math.cos(rad)) / 111;
      const lon = -1.5 - (km * Math.sin(rad)) / (111 * Math.cos((52.5 * Math.PI) / 180));
      for (let i = 0; i < 8; i += 1) {
        out.push({
          ms: now - minutes * 60000 + i * 900,
          lat: lat + ((i % 3) - 1) * 0.02,
          lon: lon + (Math.floor(i / 3) - 1) * 0.025,
        });
      }
    }
    return out.sort((a, b) => a.ms - b.ms);
  };
  const out = {};
  for (const [name, bearing] of [['070', 70], ['180', 180], ['315', 315]]) {
    resetRadarHints();
    // Cones are smoothed against the previous result on purpose; without
    // clearing it each track would blend with the one before.
    resetNowcastHistory();
    const got = calculateNowcast(track(bearing, 40), new Date(now));
    out[name] = got[0] ? { dir: +got[0].directionDeg.toFixed(0), speed: +got[0].speedKmH.toFixed(0) } : null;
  }
  return out;
});
console.log(`  ${JSON.stringify(headings)}`);
const gap = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
for (const [name, want] of [['070', 70], ['180', 180], ['315', 315]]) {
  const got = headings[name];
  ok(`a cell tracking ${name} is read within fifteen degrees`,
     got && gap(got.dir, want) <= 15, `got ${got?.dir}, wanted ${want}`);
}
ok('and at about the speed it was moving',
   Object.values(headings).every((h) => h && h.speed > 28 && h.speed < 52),
   JSON.stringify(Object.values(headings).map((h) => h?.speed)));

console.log('\n=== how long it has left ===');
const life = await page.evaluate(() => {
  const { remainingLife } = window.__nowcast;
  // Ten-minute windows. A rate halving over one of them is a cell on its way
  // out; the time to fall from six a minute to half a minute is a calculation,
  // not a guess: ln(0.5/6) / (ln(0.5)/10) is about 36 minutes.
  return {
    halving: remainingLife({ latest: 60, previous: 120 }, 10, 40, 1, null),
    steadyYoung: remainingLife({ latest: 60, previous: 60 }, 10, 15, 1, null),
    steadyOld: remainingLife({ latest: 60, previous: 60 }, 10, 110, 1, null),
    growing: remainingLife({ latest: 120, previous: 60 }, 10, 20, 1, null),
    collapsing: remainingLife({ latest: 10, previous: 120 }, 10, 50, 2, null),
    silent: remainingLife({ latest: 0, previous: 40 }, 10, 60, 3, null),
    radarDecay: remainingLife({ latest: 60, previous: 60 }, 10, 40, 1, 0.5),
  };
});
console.log(`  ${JSON.stringify(life)}`);
ok('a halving flash rate gives about half an hour', life.halving >= 25 && life.halving <= 45,
   `${life.halving} min`);
ok('a collapsing one gives much less', life.collapsing < life.halving, `${life.collapsing} min`);
ok('a growing cell is given longer than a steady one of the same age',
   life.growing > life.steadyYoung, `${life.growing} vs ${life.steadyYoung}`);
ok('an old steady cell is given less than a young one',
   life.steadyOld < life.steadyYoung, `${life.steadyOld} vs ${life.steadyYoung}`);
ok('one that has stopped is nearly done', life.silent <= 5, `${life.silent} min`);
// Radar sees the area shrink before the flash rate follows.
ok('a shrinking radar area shortens a steady cell',
   life.radarDecay < life.steadyYoung, `${life.radarDecay} vs ${life.steadyYoung}`);

console.log('\n=== the outline sits above the weather ===');
const stack = await page.evaluate(() => {
  const map = window.RadarLoop.map();
  const z = (name) => Number(map.getPane(name)?.style.zIndex || 0);
  const outline = map.getPane('nowcastOutlinePane');
  return {
    outline: z('nowcastOutlinePane'),
    radar: z(window.__paneFor('radar')),
    observation: z(window.__paneFor('observation')),
    topLevel: outline?.parentElement?.classList.contains('leaflet-map-pane'),
  };
});
console.log(`  ${JSON.stringify(stack)}`);
ok('the outline is a sibling of the weather stack, not inside it', stack.topLevel === true);
ok('and is drawn above radar and observations',
   stack.outline > stack.radar && stack.outline > stack.observation,
   JSON.stringify(stack));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
