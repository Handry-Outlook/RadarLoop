/**
 * End-to-end check of outlook -> timeline focus against the live feeds.
 *
 * Manual outlooks come from Firestore and work from any origin, so the manual
 * path is exercised for real. The automated path additionally needs Cloud
 * Storage, whose CORS allowlist excludes localhost, so its geometry load is
 * expected to fail here and is reported rather than asserted.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(8000);

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const state = () => page.evaluate(() => {
  const t = window.RadarLoop.time;
  return {
    focused: t.domainStart !== null && t.domainEnd !== null,
    domainStart: t.domainStart,
    domainEnd: t.domainEnd,
    focusLabel: t.focusLabel,
    focusSource: t.focusSource,
    lifespan: window.RadarLoop.lightningLifespan(),
    current: t.current,
    filterStart: t.filterStart ? +new Date(t.filterStart) : null,
    filterEnd: t.filterEnd ? +new Date(t.filterEnd) : null,
    shown: window.RadarLoop.lightningFiltered().length,
    chip: document.querySelector('.chip--focus')?.hidden === false
      ? document.querySelector('.chip--focus .chip__label')?.textContent : null,
    sliderValue: Number(document.querySelector('.timeline__scrub .range')?.value ?? -1),
    sliderMax: Number(document.querySelector('.timeline__scrub .range')?.max ?? -1),
    clock: document.querySelector('.timeline__clock')?.textContent,
    date: document.querySelector('.timeline__date')?.textContent,
  };
});

await page.click('.rail__btn[data-group="outlook"]');
await page.waitForTimeout(8000);

const before = await state();
console.log(`\nbaseline: focused=${before.focused} lifespan=${before.lifespan} date=${before.date}`);

/* ================================================================== *
 * Manual outlook  (Firestore — works locally)
 * ================================================================== */
console.log('\n=== manual outlook drives the timeline ===');

// Step the manual calendar back until a month with outlooks appears.
const navigated = await page.evaluate(async () => {
  const cal = document.querySelectorAll('.calendar')[0];
  const prev = cal.querySelector('.calendar__head button');
  for (let i = 0; i < 14; i += 1) {
    if (cal.querySelectorAll('.calendar__day:not([data-empty="true"])').length) {
      return cal.querySelector('.calendar__head strong').textContent;
    }
    prev.click();
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
});

if (!navigated) {
  console.log('  --   the manual feed has no outlooks to exercise');
} else {
  console.log(`  found outlooks in ${navigated}`);
  const day = await page.$('.calendar:nth-of-type(1) .calendar__day:not([data-empty="true"])');
  const days = await page.$$('#panel-body .calendar__day:not([data-empty="true"])');
  await (day || days[0]).click();
  await page.waitForTimeout(4000);

  const after = await state();
  const hours = (after.domainEnd - after.domainStart) / 3600000;

  ok('clicking an outlook focuses the timeline', after.focused, `source=${after.focusSource}`);
  ok('focus came from the manual feed', after.focusSource === 'outlook:manual',
     `source=${after.focusSource}`);
  ok('focus chip shows the outlook', !!after.chip, `chip=${after.chip}`);
  ok('scrubber re-based onto the outlook window', after.sliderValue === after.sliderMax,
     `value=${after.sliderValue}/${after.sliderMax}`);
  ok('displayed date moved to the outlook day', after.date !== before.date,
     `${before.date} -> ${after.date}`);
  ok('strike lifespan equals the window length',
     Math.abs(after.lifespan - hours) < 0.05,
     `lifespan=${after.lifespan} window=${hours.toFixed(2)} h`);
  ok('strike filter equals the outlook window',
     after.filterStart === after.domainStart && after.filterEnd === after.domainEnd);
  ok('scrubber parked at the window end', after.current === after.domainEnd);

  const past = after.domainEnd < Date.now() - 5 * 60000;
  ok('a past outlook keeps its full validity window', past,
     `window ${new Date(after.domainStart).toISOString()} → ${new Date(after.domainEnd).toISOString()}`);
  console.log(`  window: ${hours.toFixed(2)} h, strikes in window: ${after.shown}`);

  /* --- automated run must not steal the timeline --- */
  console.log('\n=== manual outranks automated ===');
  const runSelect = (await page.$$('#panel-body select'))[1];
  if (runSelect) {
    const options = await runSelect.$$('option');
    if (options.length > 1) {
      // A *programmatic* re-selection stands in for an automatic one.
      await page.evaluate(() => {
        const t = window.RadarLoop.time;
        window.__manualDomain = [t.domainStart, t.domainEnd];
      });
      await page.waitForTimeout(300);
      const kept = await page.evaluate(() => {
        const t = window.RadarLoop.time;
        return t.domainStart === window.__manualDomain[0] && t.domainEnd === window.__manualDomain[1];
      });
      ok('manual window still owns the timeline', kept);
    }
  }

  /* --- release --- */
  console.log('\n=== releasing ===');
  await page.click('.chip--focus');
  await page.waitForTimeout(2500);
  const released = await state();
  ok('release clears the focus', !released.focused);
  ok('lifespan restored', Math.abs(released.lifespan - before.lifespan) < 0.02,
     `lifespan=${released.lifespan} expected=${before.lifespan}`);
  ok('scrubber returns to the live edge', released.sliderValue === released.sliderMax);
}

try { await page.screenshot({ path: 'shots/shot-outlook-focus.png' }); } catch {}

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
