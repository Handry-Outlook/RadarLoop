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

  // One cell must stay one cell. Splitting is the cure for chaining and the
  // opposite failure is just as wrong: a single storm cut in half gets two
  // projections pointing two ways.
  resetRadarHints();
  resetNowcastHistory();
  const single = calculateNowcast(build({ lat0: 52.2, lon0: -2.4 }).sort((x, y) => x.ms - y.ms), new Date(now));

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
    single: single.length,
    apart: apart.length,
    bridged: bridged.length,
    positions: apart.map((c) => [+c.baseLat.toFixed(2), +c.baseLon.toFixed(2)]),
    headings: apart.map((c) => +c.directionDeg.toFixed(0)),
  };
});
console.log(`  ${JSON.stringify(cells)}`);
ok('one cell stays one cell', cells.single === 1, `${cells.single}`);
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

console.log('\n=== radar against the strike track ===');
const blend = await page.evaluate(() => {
  const { calculateNowcast, resetRadarHints, resetNowcastHistory, seedRadarHint } = window.__nowcast;
  const now = Date.now();
  // A clean strike track heading due east at 40 km/h.
  const track = () => {
    const out = [];
    for (let step = 0; step < 20; step += 1) {
      const minutes = (20 - step) * 4;
      const km = (40 * minutes) / 60;
      const lon = -1.5 + km / (111 * Math.cos((52.5 * Math.PI) / 180));
      for (let i = 0; i < 8; i += 1) {
        out.push({ ms: now - minutes * 60000 + i * 900, lat: 52.5 + ((i % 3) - 1) * 0.02, lon: lon + (Math.floor(i / 3) - 1) * 0.025 });
      }
    }
    return out.sort((a, b) => a.ms - b.ms);
  };
  // Note the sign: the track is built backwards in time, so it runs westwards.
  const strikes = track();

  const run = (hint) => {
    resetRadarHints();
    resetNowcastHistory();
    if (hint) {
      let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
      for (const s of strikes) {
        minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
        minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon);
      }
      for (let lat = minLat - 0.5; lat <= maxLat + 0.5; lat += 0.2) {
        for (let lon = minLon - 0.5; lon <= maxLon + 0.5; lon += 0.2) {
          seedRadarHint(lat, lon, hint, now);
        }
      }
    }
    const got = calculateNowcast(strikes, new Date(now));
    return got[0] ? { dir: Math.round(got[0].directionDeg), speed: Math.round(got[0].speedKmH), source: got[0].motionSource } : null;
  };

  const lightningOnly = run(null);
  // A confident radar measurement pointing somewhere else entirely.
  const disagreeing = run({ speedKmH: 55, directionDeg: (lightningOnly.dir + 90) % 360, quality: 0.6, trend: 1, peakDbz: 48 });
  // And a barely-usable one, which should barely move it.
  const weak = run({ speedKmH: 55, directionDeg: (lightningOnly.dir + 90) % 360, quality: 0.03, trend: 1, peakDbz: 48 });
  return { lightningOnly, disagreeing, weak };
});
console.log(`  ${JSON.stringify(blend)}`);

const apart = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const pulledBy = apart(blend.disagreeing.dir, blend.lightningOnly.dir);
const weakPull = apart(blend.weak.dir, blend.lightningOnly.dir);
console.log(`  a confident radar pulls the heading ${pulledBy}°, a weak one ${weakPull}°`);

ok('with no radar the heading is the strike track', blend.lightningOnly.source === 'lightning',
   String(blend.lightningOnly.source));
// Radar measures the displacement of the precipitation field directly; the
// strike track is the drift of a centroid of scattered discharges. Weighting
// them by fitted quality alone made a tidy fit of noise the equal of a
// measurement, so a confident radar should take most of the way.
ok('a confident radar takes the heading most of the way to its own',
   pulledBy > 60, `${pulledBy}° of 90`);
ok('and says both sources were used', blend.disagreeing.source === 'radar+lightning',
   String(blend.disagreeing.source));
ok('while a barely-usable one barely moves it', weakPull < pulledBy / 2,
   `${weakPull}° against ${pulledBy}°`);


console.log('\n=== a cell with nothing to fit ===');
const stalled = await page.evaluate(() => {
  const { calculateNowcast, resetRadarHints, resetNowcastHistory } = window.__nowcast;
  const now = Date.now();
  const out = [];

  // A long track, which is what gives the field its steering: due east at 40.
  for (let step = 0; step < 20; step += 1) {
    const minutes = (20 - step) * 4;
    const km = (40 * minutes) / 60;
    const lon = -1.5 + km / (111 * Math.cos((52.5 * Math.PI) / 180));
    for (let i = 0; i < 10; i += 1) {
      out.push({ ms: now - minutes * 60000 + i * 900, lat: 52.5 + ((i % 3) - 1) * 0.02, lon: lon + (Math.floor(i / 3) - 1) * 0.02 });
    }
  }
  // And a burst two degrees away, all inside ninety seconds: one time bin, so
  // nothing to fit a velocity through.
  for (let i = 0; i < 40; i += 1) {
    out.push({ ms: now - 90000 + i * 2000, lat: 54.6 + ((i % 6) - 3) * 0.012, lon: -1.4 + (Math.floor(i / 6) - 3) * 0.012 });
  }
  out.sort((a, b) => a.ms - b.ms);

  resetRadarHints();
  resetNowcastHistory();
  return calculateNowcast(out, new Date(now))
    .map((c) => ({
      at: [+c.baseLat.toFixed(1), +c.baseLon.toFixed(1)],
      size: c.clusterSize,
      speed: Math.round(c.speedKmH),
      dir: Math.round(c.directionDeg),
      motion: c.motionSource,
      projections: c.nowcastPolygons.length,
    }));
});
console.log(`  ${JSON.stringify(stalled)}`);

const burst = stalled.find((c) => c.at[0] > 54);
ok('the burst is tracked as its own cell', !!burst, JSON.stringify(stalled));
// It used to come out at a standstill, so the projected footprint landed exactly
// on the current one and the storm had no direction at all.
ok('and is given the motion of the field around it', burst && burst.speed > 3,
   `${burst?.speed} km/h`);
ok('which is named as such rather than passed off as a fit',
   burst && /field/.test(burst.motion), String(burst?.motion));
ok('so it has somewhere to project to', burst && burst.projections > 0,
   String(burst?.projections));
// A cell whose expected life is shorter than the projection steps used to keep
// none of them, drawing its current footprint alone — which on the map reads as
// a storm going nowhere, the same as having no motion at all.
ok('and so does every other cell, whatever its expected life',
   stalled.every((c) => c.projections > 0),
   JSON.stringify(stalled.map((c) => [c.size, c.projections])));


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


console.log('\n=== how serious, and hail ===');
const severity = await page.evaluate(() => {
  const { impactLevel, hailRisk } = window.__nowcast;
  const at = (rate, dbz, extra = {}) => impactLevel({ flashesPerMinute: rate, peakDbz: dbz, ...extra }).level;
  return {
    // Ordinary through severe, by flash rate alone.
    drizzleStorm: at(0.4, null),
    ordinary: at(2, null),
    busy: at(12, null),
    strong: at(40, null),
    extreme: at(300, null),
    // Reflectivity pulls a moderate rate up, as it should.
    moderateRateWeakEcho: at(12, 42),
    moderateRateStrongEcho: at(12, 62),
    // The failure this replaces: a large but quiet cluster was level 5 purely
    // for being large and well tracked.
    bigButQuiet: at(1.5, null),

    hail: {
      noRadar: hailRisk({ flashesPerMinute: 40, peakDbz: null }),
      weakEcho: hailRisk({ flashesPerMinute: 40, peakDbz: 43 }).label,
      rainShaft: hailRisk({ flashesPerMinute: 0.5, peakDbz: 54 }).label,
      vigorous: hailRisk({ flashesPerMinute: 35, peakDbz: 57, largeHailArea: 0.004 }).label,
      severe: hailRisk({ flashesPerMinute: 90, peakDbz: 63, largeHailArea: 0.03, jump: true }).label,
      // A severe UK afternoon as this composite actually renders one: a deep
      // core near the top of its range and a busy but not extraordinary flash
      // rate. The old scale scored this at nothing, which is the complaint.
      severeUkDay: hailRisk({ flashesPerMinute: 6.3, peakDbz: 61, largeHailArea: 0.0247 }).label,
      supercell: hailRisk({ flashesPerMinute: 19, peakDbz: 63, largeHailArea: 0.0273 }).label,
      strongModestCore: hailRisk({ flashesPerMinute: 25, peakDbz: 52, largeHailArea: 0.0005 }).label,
      quietDeepEcho: hailRisk({ flashesPerMinute: 0.6, peakDbz: 64, largeHailArea: 0.056 }).label,
      strongNoHail: hailRisk({ flashesPerMinute: 10, peakDbz: 48 }).label,
      ordinary: hailRisk({ flashesPerMinute: 3, peakDbz: 45 }).label,
    },
  };
});
console.log(`  ${JSON.stringify(severity)}`);
ok('a barely-electrified shower is level 1', severity.drizzleStorm === 1, String(severity.drizzleStorm));
ok('an ordinary storm is not severe', severity.ordinary <= 2, String(severity.ordinary));
ok('the levels climb with the flash rate',
   severity.ordinary < severity.busy && severity.busy < severity.strong && severity.strong <= severity.extreme,
   JSON.stringify([severity.ordinary, severity.busy, severity.strong, severity.extreme]));
ok('only a genuinely extreme rate reaches level 5', severity.extreme === 5, String(severity.extreme));
// The whole point of the recalibration.
ok('a large but quiet cluster is no longer severe', severity.bigButQuiet <= 2, String(severity.bigButQuiet));
ok('a strong echo raises a moderate rate',
   severity.moderateRateStrongEcho > severity.moderateRateWeakEcho,
   `${severity.moderateRateWeakEcho} -> ${severity.moderateRateStrongEcho}`);

// Lightning alone cannot tell a hailstorm from a vigorous rain storm, and
// saying so beats a number that looks like it knows.
ok('hail is not guessed at without radar', severity.hail.noRadar === null, String(severity.hail.noRadar));
ok('a weak echo is no hail whatever the flash rate', /unlikely|No hail/i.test(severity.hail.weakEcho),
   severity.hail.weakEcho);
ok('a bright echo with no lightning is treated as rain, not hail',
   /unlikely|possible/i.test(severity.hail.rainShaft), severity.hail.rainShaft);
ok('a strong echo with a high flash rate is hail', /likely/i.test(severity.hail.vigorous),
   severity.hail.vigorous);
ok('and a deeper one with a jump is large hail', /Large hail/i.test(severity.hail.severe),
   severity.hail.severe);
// Measured on the 27 August supercell day: the cells that produced hail read 57
// to 63 dBZ with a few percent of the intensity square above 60.
ok('a severe day on this composite does report hail', /likely/i.test(severity.hail.severeUkDay),
   severity.hail.severeUkDay);
ok('a strong storm without a deep core does not',
   /unlikely|possible/i.test(severity.hail.strongNoHail), severity.hail.strongNoHail);
ok('the supercell itself is the one large-hail call',
   /Large hail/i.test(severity.hail.supercell), severity.hail.supercell);
// A strong storm with only a modest core is worth mentioning and not worth an
// amber outline, which is drawn at "likely" and above.
ok('a high flash rate over a modest core is possible, not likely',
   /possible/i.test(severity.hail.strongModestCore), severity.hail.strongModestCore);
// The one that used to come out "likely" on the strength of its echo alone.
ok('a deep echo with almost no lightning is not called hail',
   /unlikely|possible/i.test(severity.hail.quietDeepEcho), severity.hail.quietDeepEcho);
ok('and an ordinary one does not', /unlikely|No hail/i.test(severity.hail.ordinary),
   severity.hail.ordinary);

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
