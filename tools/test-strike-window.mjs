/**
 * A filtered period must not widen the strike window.
 *
 * Applying a filter sets the timeline's whole span, and it used to set the
 * strike window with it: choosing a week showed a week of strikes at once,
 * whatever the age window said. The age window governs inside a filtered period
 * now, and "show every strike loaded" is the switch for the other behaviour.
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

const counts = await page.evaluate(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 1800));
  const all = window.RadarLoop.lightningAll();
  // A stretch of the archive with plenty in it, so the difference is visible.
  const hours = new Map();
  for (const s of all) hours.set(Math.floor(s.ms / 3600000), (hours.get(Math.floor(s.ms / 3600000)) || 0) + 1);
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  const end = new Date(hour * 3600000 + 3600000);
  const start = new Date(end.getTime() - 12 * 3600000);

  window.RadarLoop.lightning.lifespanHours = 1;
  window.RadarLoop.lightning.showAll = false;
  window.RadarLoop.playback.setHistorySpan(24 * 60);
  window.RadarLoop.playback.applyFilter(start, end);
  window.RadarLoop.playback.setTime(end.getTime(), { immediate: true });
  await settle();
  const filtered = window.RadarLoop.lightningFiltered().length;

  // The same period with the switch on.
  window.RadarLoop.lightning.showAll = true;
  window.RadarLoop.playback.setTime(end.getTime(), { immediate: true });
  await settle();
  const everything = window.RadarLoop.lightningFiltered().length;

  window.RadarLoop.lightning.showAll = false;
  window.RadarLoop.playback.clearFilter();

  const expected = all.filter((s) => s.ms > end.getTime() - 3600000 && s.ms <= end.getTime()).length;
  const inPeriod = all.filter((s) => s.ms > start.getTime() && s.ms <= end.getTime()).length;

  return { filtered, everything, expected, inPeriod, hoursInFilter: 12, lifespan: 1 };
});
console.log(`  ${JSON.stringify(counts)}`);

ok('a twelve-hour filter does not show twelve hours of strikes',
   counts.filtered < counts.everything / 3,
   `${counts.filtered} inside the filter against ${counts.everything} with the switch on`);
// The age window is what decides, so a filtered hour and an unfiltered hour
// should hold about the same number.
ok('it shows exactly the hour the age window asks for',
   Math.abs(counts.filtered - counts.expected) <= Math.max(20, counts.expected * 0.02),
   `${counts.filtered} shown against ${counts.expected} in that hour`);
ok('where the period itself holds far more', counts.inPeriod > counts.expected * 2,
   `${counts.inPeriod} in twelve hours`);
ok('and the switch still shows the whole period',
   counts.everything > counts.filtered * 3, `${counts.everything}`);

/* ---- an outlook focus still reveals its whole window ---- */
console.log('\n=== focused outlook ===');
const focused = await page.evaluate(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 1800));
  const all = window.RadarLoop.lightningAll();
  const hours = new Map();
  for (const s of all) hours.set(Math.floor(s.ms / 3600000), (hours.get(Math.floor(s.ms / 3600000)) || 0) + 1);
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  const end = new Date(hour * 3600000 + 3600000);
  const start = new Date(end.getTime() - 6 * 3600000);

  // Focusing an outlook sets the timeline to its validity period *and* the age
  // window to the same length, which is what keeps the clamp from biting.
  window.RadarLoop.lightning.showAll = false;
  window.RadarLoop.lightning.lifespanHours = 6;
  window.RadarLoop.playback.applyFilter(start, end);
  window.RadarLoop.playback.setTime(end.getTime(), { immediate: true });
  await settle();

  const shown = window.RadarLoop.lightningFiltered().length;
  const inWindow = all.filter((s) => s.ms > start.getTime() && s.ms <= end.getTime()).length;
  window.RadarLoop.playback.clearFilter();
  return { shown, inWindow };
});
console.log(`  ${JSON.stringify(focused)}`);
// The clamp is `max(periodStart, end - lifespan)`, so when a focus sets the age
// window to the period's own length it is a no-op and the whole period shows.
ok('a period whose age window matches its length still shows all of it',
   Math.abs(focused.shown - focused.inWindow) <= Math.max(20, focused.inWindow * 0.02),
   `${focused.shown} shown of ${focused.inWindow}`);


console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
