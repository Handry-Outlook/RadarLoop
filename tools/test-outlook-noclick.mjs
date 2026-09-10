/**
 * Regression test for the reported bug: opening the Outlooks panel must not
 * change the strike lifespan or re-base the timeline. Only an explicit
 * selection may do that.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const state = () => page.evaluate(() => {
  const t = window.RadarLoop.time;
  return {
    lifespan: window.RadarLoop.lightningLifespan(),
    focused: t.domainStart !== null && t.domainEnd !== null,
    focusSource: t.focusSource,
    sliderValue: Number(document.querySelector('.timeline__scrub .range')?.value ?? -1),
    sliderMax: Number(document.querySelector('.timeline__scrub .range')?.max ?? -1),
    date: document.querySelector('.timeline__date')?.textContent,
    chipVisible: document.querySelector('.chip--focus')?.hidden === false,
  };
});

console.log('\n=== before opening the outlook panel ===');
const before = await state();
console.log(`  lifespan=${before.lifespan} focused=${before.focused} date=${before.date}`);
ok('starts on the default lifespan', before.lifespan === 3, `lifespan=${before.lifespan}`);
ok('starts unfocused', !before.focused);

console.log('\n=== after opening the outlook panel (no clicks) ===');
await page.click('.rail__btn[data-group="outlook"]');
await page.waitForTimeout(9000);

const opened = await state();
console.log(`  lifespan=${opened.lifespan} focused=${opened.focused} date=${opened.date}`);
ok('lifespan unchanged by merely opening the panel', opened.lifespan === before.lifespan,
   `${before.lifespan} -> ${opened.lifespan}`);
ok('timeline still unfocused', !opened.focused, `source=${opened.focusSource}`);
ok('no focus chip shown', !opened.chipVisible);
ok('scrubber still at the live edge', opened.sliderValue === opened.sliderMax);
ok('date readout unchanged', opened.date === before.date, `${before.date} -> ${opened.date}`);

// The "select this…" prompt only exists where an outlook is actually on screen;
// with nothing valid for now, the panel correctly shows neither prompt nor an
// enabled focus button.
const displayed = await page.evaluate(() =>
  [...document.querySelectorAll('#panel-body button')]
    .filter((b) => /Show this .* period/.test(b.textContent) && !b.disabled).length);
const prompts = await page.evaluate(() =>
  [...document.querySelectorAll('#panel-body .tiny.dim')]
    .map((n) => n.textContent).filter((t) => /Select this/.test(t)));

if (displayed > 0) {
  ok('a displayed outlook invites an explicit selection', prompts.length > 0,
     `prompts=${JSON.stringify(prompts)}`);
} else {
  ok('with nothing valid now, no outlook is offered for focus', prompts.length === 0);
  console.log('  --   no outlook valid for the current time on this run');
}

console.log('\n=== after an explicit selection ===');
const focusBtn = await page.$('#panel-body button:has-text("Show this outlook")');
if (focusBtn && !(await focusBtn.isDisabled())) {
  await focusBtn.click();
  await page.waitForTimeout(3500);
  const selected = await state();
  console.log(`  lifespan=${selected.lifespan} focused=${selected.focused} date=${selected.date}`);
  ok('explicit selection focuses the timeline', selected.focused, `source=${selected.focusSource}`);
  ok('explicit selection sets the lifespan', selected.lifespan !== before.lifespan,
     `lifespan=${selected.lifespan}`);
  ok('focus chip appears', selected.chipVisible);

  await page.click('.chip--focus');
  await page.waitForTimeout(2500);
  const released = await state();
  ok('releasing restores the lifespan', released.lifespan === before.lifespan,
     `lifespan=${released.lifespan}`);
  ok('releasing clears the focus', !released.focused);
} else {
  console.log('  --   no manual outlook is currently valid, so the button is inert here');
  // Fall back to a calendar click on a month that has outlooks.
  const navigated = await page.evaluate(async () => {
    const cal = document.querySelectorAll('.calendar')[0];
    const prev = cal.querySelector('.calendar__head button');
    for (let i = 0; i < 14; i += 1) {
      if (cal.querySelectorAll('.calendar__day:not([data-empty="true"])').length) return true;
      prev.click();
      await new Promise((r) => setTimeout(r, 80));
    }
    return false;
  });
  if (navigated) {
    const day = await page.$('#panel-body .calendar__day:not([data-empty="true"])');
    await day.click();
    await page.waitForTimeout(3500);
    const selected = await state();
    ok('clicking a calendar day focuses the timeline', selected.focused,
       `source=${selected.focusSource}`);
    ok('clicking a calendar day sets the lifespan', selected.lifespan !== before.lifespan,
       `lifespan=${selected.lifespan}`);

    await page.click('.chip--focus');
    await page.waitForTimeout(2500);
    const released = await state();
    ok('releasing restores the lifespan', released.lifespan === before.lifespan,
       `lifespan=${released.lifespan}`);
  }
}

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
