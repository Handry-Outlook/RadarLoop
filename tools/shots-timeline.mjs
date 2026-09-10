/** Captures the new timeline states for visual review. */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(22000); // let the archives land

const shot = async (name) => {
  try {
    await page.screenshot({ path: `shots/${name}.png` });
    console.log(`  wrote shots/${name}.png`);
  } catch (e) {
    console.log(`  screenshot ${name} failed: ${e.message}`);
  }
};

// Focus a day the archives cover heavily, through the real focus path.
await page.evaluate(() => {
  window.RadarLoop.focusWindow(new Date('2026-08-27T00:00:00Z'), new Date('2026-08-28T00:00:00Z'));
});
await page.waitForTimeout(6000);

const info = await page.evaluate(() => ({
  shown: window.RadarLoop.lightningFiltered().length,
  lifespan: window.RadarLoop.lightningLifespan(),
  chip: document.querySelector('.chip--focus .chip__label')?.textContent,
  status: document.querySelector('.timeline__meta')?.textContent,
}));
console.log(`  focused window: ${info.shown.toLocaleString()} strikes, lifespan ${info.lifespan} h`);
console.log(`  chip: "${info.chip}"`);
console.log(`  status: ${info.status}`);

await shot('timeline-focused');

// Long span axis.
await page.evaluate(() => {
  document.querySelector('.chip--focus')?.click();
});
await page.waitForTimeout(2500);
await page.click('.rail__btn[data-group="settings"]');
await page.waitForTimeout(800);
const span = await page.$('#panel-body input[type="number"][max="720"]');
if (span) {
  await span.fill('300');
  await span.dispatchEvent('change');
  await page.waitForTimeout(3000);
}
await shot('timeline-300h');

await browser.close();
