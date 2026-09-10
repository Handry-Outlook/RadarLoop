/** Dumps what the outlook feeds actually contain, to target tests precisely. */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(8000);
await page.click('.rail__btn[data-group="outlook"]');
await page.waitForTimeout(8000);

const dump = await page.evaluate(() => {
  const body = document.getElementById('panel-body');
  const sections = [...body.querySelectorAll('.stack > .stack')];
  return {
    panelText: body.innerText.slice(0, 600),
    sectionCount: sections.length,
    sectionTitles: [...body.querySelectorAll('.section-title')].map((n) => n.textContent),
    calendars: [...body.querySelectorAll('.calendar')].length,
    daysPerCalendar: [...body.querySelectorAll('.calendar')].map((c) =>
      c.querySelectorAll('.calendar__day:not([data-empty="true"])').length),
    selects: [...body.querySelectorAll('select')].map((s) => ({
      options: [...s.options].map((o) => o.textContent).slice(0, 5),
      count: s.options.length,
    })),
  };
});

console.log('=== PANEL TEXT ===');
console.log(dump.panelText);
console.log('\n=== STRUCTURE ===');
console.log('  section titles :', JSON.stringify(dump.sectionTitles));
console.log('  calendars      :', dump.calendars);
console.log('  selectable days:', JSON.stringify(dump.daysPerCalendar));
console.log('  selects        :', JSON.stringify(dump.selects, null, 2));

// Walk the manual calendar (the first one) month by month looking for outlooks.
const found = await page.evaluate(async () => {
  const cal = document.querySelectorAll('.calendar')[0];
  if (!cal) return null;
  const prev = cal.querySelector('.calendar__head button');
  const results = [];
  for (let i = 0; i < 14; i += 1) {
    const days = cal.querySelectorAll('.calendar__day:not([data-empty="true"])');
    const month = cal.querySelector('.calendar__head strong')?.textContent;
    if (days.length) results.push({ month, days: days.length });
    prev.click();
    await new Promise((r) => setTimeout(r, 60));
  }
  return results;
});
console.log('\n=== MANUAL CALENDAR: months with outlooks (last 14 months) ===');
console.log(found?.length ? JSON.stringify(found, null, 2) : '  none found');

await browser.close();
