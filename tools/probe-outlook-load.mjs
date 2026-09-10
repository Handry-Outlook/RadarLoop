/** How long the outlook panel takes to populate, and what it shows meanwhile. */
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const t0 = Date.now();
await page.click('.rail__btn[data-group="outlook"]');

const seen = [];
for (let i = 0; i < 40; i += 1) {
  const snap = await page.evaluate(() => ({
    calendars: document.querySelectorAll('.calendar').length,
    status: [...document.querySelectorAll('#panel .stack > *')]
      .map((n) => n.textContent.trim())
      .filter((t) => t && t.length < 90).slice(0, 3),
  }));
  seen.push({ ms: Date.now() - t0, ...snap });
  if (snap.calendars >= 2) break;
  await page.waitForTimeout(500);
}

const first = seen.find((s) => s.calendars >= 1);
const both = seen.find((s) => s.calendars >= 2);
console.log(`first calendar at ${first ? first.ms : 'never'} ms`);
console.log(`both calendars at ${both ? both.ms : 'never'} ms`);
console.log('\nwhat the panel showed while waiting:');
for (const s of seen.slice(0, 6)) console.log(`  ${String(s.ms).padStart(5)}ms  cal=${s.calendars}  ${JSON.stringify(s.status)}`);
await browser.close();
