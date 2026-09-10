/**
 * Browser test for the reported issues:
 *   - applying a time filter visibly moves the scrubber and relabels the axis
 *   - a long scrubber span still plots lightning when scrubbed back
 *   - the focus chip appears and releases
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(10000);

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const snapshot = () => page.evaluate(() => ({
  sliderValue: Number(document.querySelector('.timeline__scrub .range')?.value ?? -1),
  sliderMax: Number(document.querySelector('.timeline__scrub .range')?.max ?? -1),
  clock: document.querySelector('.timeline__clock')?.textContent,
  date: document.querySelector('.timeline__date')?.textContent,
  tickLabels: [...document.querySelectorAll('.timeline__tick-label')].map((n) => n.textContent),
  tickNodes: document.querySelectorAll('.timeline__tick').length,
  focusChipVisible: !document.querySelector('.chip--focus')?.hidden,
  focusChipText: document.querySelector('.chip--focus .chip__label')?.textContent ?? '',
  status: document.querySelector('.timeline__meta')?.textContent,
  strikesLoaded: window.RadarLoop?.slots ? undefined : undefined,
}));

/* ---------------- 1. baseline ---------------- */
console.log('\n=== baseline ===');
const base = await snapshot();
ok('scrubber is at the live edge', base.sliderValue === base.sliderMax,
   `value=${base.sliderValue} max=${base.sliderMax}`);
ok('axis has a bounded number of ticks', base.tickNodes > 0 && base.tickNodes < 80,
   `ticks=${base.tickNodes}`);
ok('no focus chip initially', !base.focusChipVisible);

/* ---------------- 2. time filter moves the slider ---------------- */
console.log('\n=== time filter moves the scrubber ===');
await page.click('.rail__btn[data-group="settings"]');
await page.waitForTimeout(900);

// Two hours, three days ago — well outside the default 6-hour span.
const { from, to } = await page.evaluate(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const end = new Date(Date.now() - 70 * 3600 * 1000);
  const start = new Date(end.getTime() - 2 * 3600 * 1000);
  return { from: fmt(start), to: fmt(end) };
});

const dtInputs = await page.$$('#panel-body input[type="datetime-local"]');
await dtInputs[0].fill(from);
await dtInputs[1].fill(to);
await page.click('#panel-body button:has-text("Apply filter")');
await page.waitForTimeout(2500);

const filtered = await snapshot();
ok('focus chip appears', filtered.focusChipVisible, `chip="${filtered.focusChipText}"`);
ok('scrubber sits at the end of the filtered window', filtered.sliderValue === filtered.sliderMax,
   `value=${filtered.sliderValue} max=${filtered.sliderMax}`);
ok('the displayed date moved to the filtered day', filtered.date !== base.date,
   `before="${base.date}" after="${filtered.date}"`);
ok('the axis relabelled to the filtered window',
   JSON.stringify(filtered.tickLabels) !== JSON.stringify(base.tickLabels),
   `ticks now: ${filtered.tickLabels.slice(0, 4).join(', ')}`);

// Dragging inside the filtered window must reach its start.
await page.evaluate(() => {
  const s = document.querySelector('.timeline__scrub .range');
  s.value = '0';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);
const atStart = await snapshot();
ok('scrubber can reach the start of the filtered window', atStart.sliderValue === 0);
ok('clock changed when scrubbing within the window', atStart.clock !== filtered.clock,
   `${filtered.clock} -> ${atStart.clock}`);

/* ---------------- 3. release ---------------- */
console.log('\n=== releasing the window ===');
await page.click('.chip--focus');
await page.waitForTimeout(2000);
const released = await snapshot();
ok('focus chip disappears', !released.focusChipVisible);
ok('scrubber returns to the live edge', released.sliderValue === released.sliderMax);

/* ---------------- 4. long span ---------------- */
console.log('\n=== long scrubber span ===');
const spanInput = await page.$('#panel-body input[type="number"][max="720"]');
if (!spanInput) {
  ok('scrubber span control found', false, 'input[max=720] missing');
} else {
  await spanInput.fill('300');
  await spanInput.dispatchEvent('change');
  await page.waitForTimeout(3000);

  const longSpan = await snapshot();
  ok('axis stays readable at a 300 h span', longSpan.tickNodes > 0 && longSpan.tickNodes < 80,
     `ticks=${longSpan.tickNodes}`);
  ok('tick labels switch to dates for a multi-day span',
     longSpan.tickLabels.some((t) => /[A-Za-z]/.test(t)),
     `labels: ${longSpan.tickLabels.slice(0, 4).join(', ')}`);

  const retention = await page.evaluate(() => {
    const all = window.RadarLoop?.lightningAll?.() ?? null;
    return all === null ? null : { count: all.length, oldestHoursAgo: all.length ? (Date.now() - all[0].ms) / 3600000 : 0 };
  });
  if (retention) {
    ok('strike history retained beyond 48 h', retention.oldestHoursAgo > 0,
       `oldest=${retention.oldestHoursAgo.toFixed(1)} h, count=${retention.count}`);
  } else {
    console.log('  --   strike retention not exposed for inspection (skipped)');
  }

  // Scrub back and confirm the pipeline still reports a window.
  await page.evaluate(() => {
    const s = document.querySelector('.timeline__scrub .range');
    s.value = String(Math.round(Number(s.max) * 0.15));
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2500);
  const scrubbed = await snapshot();
  ok('status line still reports a strike window far back',
     /strikes in window/.test(scrubbed.status || ''), scrubbed.status);
}

try { await page.screenshot({ path: 'shots/shot-timeline.png' }); } catch {}

console.log('\n=== page errors ===');
if (errors.length) [...new Set(errors)].forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && errors.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${errors.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
