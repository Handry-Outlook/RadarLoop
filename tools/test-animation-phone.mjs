/**
 * Two reports: playback is slow, and the phone opens a panel over the map.
 *
 * Playback used to schedule the next step on a bare timer without waiting for
 * the current frame to reach the screen. At 4x that asked for a frame every
 * 250 ms while frames were taking ~700 ms, so `renderAll` dropped most of the
 * requests — but `time.current` had already moved past them, and tiles were
 * fetched for frames that were superseded before they finished. Asking it to go
 * faster made it draw less and download more.
 *
 * The check is therefore not "is it fast" — that depends on the provider — but
 * that raising the speed buys frames rather than wasted traffic.
 */

import { chromium, devices } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/* ================================================================== *
 * Playback
 * ================================================================== */
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let tiles = 0;
page.on('request', (r) => { if (r.resourceType() === 'image') tiles += 1; });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(9000);

const measure = async (speed, seconds = 12) => {
  const before = tiles;
  const result = await page.evaluate(async ({ s, ms }) => {
    window.RadarLoop.time.speed = s;
    const seen = [];
    const start = performance.now();
    let lastUrl = window.RadarLoop.slots.get('radar').lastUrl;

    window.RadarLoop.playback.play();
    const poll = setInterval(() => {
      const slot = window.RadarLoop.slots.get('radar');
      if (slot.lastUrl && slot.lastUrl !== lastUrl) {
        seen.push(Math.round(performance.now() - start));
        lastUrl = slot.lastUrl;
      }
    }, 15);
    await new Promise((r) => setTimeout(r, ms));
    clearInterval(poll);
    window.RadarLoop.playback.stop();

    const gaps = seen.slice(1).map((t, i) => t - seen[i]).sort((a, b) => a - b);
    return {
      frames: seen.length,
      worst: gaps.length ? gaps[gaps.length - 1] : null,
      playing: window.RadarLoop.time.playing,
    };
  }, { s: speed, ms: seconds * 1000 });

  const used = tiles - before;
  console.log(`  ${speed}x  ${String(result.frames).padStart(2)} frames  worst gap `
    + `${String(result.worst).padStart(5)}ms  ${String(used).padStart(4)} tiles  `
    + `${(used / Math.max(1, result.frames)).toFixed(0)} tiles/frame`);
  await page.waitForTimeout(2500);
  return { ...result, tiles: used, perFrame: used / Math.max(1, result.frames) };
};

console.log('\n=== playback ===');
const slow = await measure(1);
const fast = await measure(4);

ok('playback stops cleanly', slow.playing === false && fast.playing === false);
ok('frames are actually drawn at 1x', slow.frames >= 5, `${slow.frames}`);

// The regression: a higher speed drew *fewer* frames while fetching far more.
ok('a higher speed draws more frames, not fewer',
   fast.frames >= slow.frames, `1x ${slow.frames} vs 4x ${fast.frames}`);
// Tiles *per frame* rather than frames per second: the frame count swings with
// the provider run to run, but the ratio is stable and is exactly what the
// unpaced loop got wrong. Paced, a faster speed costs about 12 tiles a frame
// against 16 at 1x; unpaced it cost 21, because frames were fetched and then
// superseded before they were ever shown.
ok('and does not waste tiles on frames nobody sees',
   fast.perFrame <= slow.perFrame * 1.15,
   `1x ${slow.perFrame.toFixed(0)}/frame, 4x ${fast.perFrame.toFixed(0)}/frame`);

// Frame pacing also bounds the stall: nothing should sit for many seconds.
ok('no frame stalls for several seconds', (fast.worst ?? 0) < 3000, `worst ${fast.worst}ms`);

await page.close();

/* ================================================================== *
 * Phone: the map, not a panel
 * ================================================================== */
console.log('\n=== phone opens on the map ===');
const phone = await browser.newPage({ ...devices['iPhone 13'] });
phone.on('pageerror', (e) => errors.push(`[phone] ${e.message}`));
await phone.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await phone.waitForTimeout(12000);

const opening = await phone.evaluate(() => {
  const panel = document.getElementById('panel');
  const rail = document.getElementById('rail');
  return {
    panelHidden: panel?.hidden ?? null,
    railVisible: !!rail && !rail.hidden && rail.getBoundingClientRect().height > 0,
    mapVisible: document.querySelectorAll('#map .leaflet-pane img, #map .leaflet-pane canvas').length,
  };
});
console.log(`  ${JSON.stringify(opening)}`);
ok('no panel is open on a first visit', opening.panelHidden === true, String(opening.panelHidden));
ok('the rail is still there to open one', opening.railVisible === true);
ok('the map is drawn', opening.mapVisible > 0, `${opening.mapVisible} layers`);

// And opening one still works.
await phone.click('.rail__btn[data-group="precip"]');
await phone.waitForTimeout(1200);
const afterTap = await phone.evaluate(() => document.getElementById('panel')?.hidden);
ok('tapping the rail still opens a panel', afterTap === false, String(afterTap));

// A desktop visit should still open one, which is where it is discoverable.
const desk = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await desk.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await desk.waitForTimeout(11000);
const deskPanel = await desk.evaluate(() => document.getElementById('panel')?.hidden);
console.log(`  desktop panel hidden: ${deskPanel}`);
ok('a desktop visit still opens the radar panel', deskPanel === false, String(deskPanel));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
