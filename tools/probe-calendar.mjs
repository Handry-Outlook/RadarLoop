import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
await page.click('.rail__btn[data-group="outlook"]');
await page.waitForTimeout(8000);

const state = await page.evaluate(() => ({
  calendars: document.querySelectorAll('.calendar').length,
  days: document.querySelectorAll('.calendar__day').length,
  withRisk: document.querySelectorAll('.calendar__day[data-risk]').length,
  enabled: document.querySelectorAll('.calendar__day:not([disabled])').length,
  label: [...document.querySelectorAll('.calendar__head strong')].map((n) => n.textContent),
}));
console.log('initial:', JSON.stringify(state));

// Walk back six months and forward again, the way a user browsing would.
for (let i = 0; i < 6; i += 1) {
  await page.click('.calendar [aria-label="Previous month"]');
  await page.waitForTimeout(180);
}
console.log('after 6 back:', JSON.stringify(await page.evaluate(() => ({
  label: [...document.querySelectorAll('.calendar__head strong')].map((n) => n.textContent),
  days: document.querySelectorAll('.calendar__day').length,
  withRisk: document.querySelectorAll('.calendar__day[data-risk]').length,
}))));

// Click the first day that has an outlook, if any.
const clicked = await page.evaluate(() => {
  const cell = document.querySelector('.calendar__day[data-risk]:not([disabled])');
  if (!cell) return null;
  cell.click();
  return cell.textContent;
});
await page.waitForTimeout(2500);
console.log('clicked day:', clicked);
console.log('selected after click:', await page.evaluate(() =>
  [...document.querySelectorAll('.calendar__day[aria-selected="true"]')].map((n) => n.textContent)));
console.log('errors:', [...new Set(errs)].slice(0, 6));
await browser.close();
