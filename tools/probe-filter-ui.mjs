/**
 * What a custom time period does, driven through the panel rather than the API.
 *
 * The API path behaves; the report says the interface does not, so the
 * difference is somewhere between the two.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const report = await page.evaluate(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 2200));
  const all = window.RadarLoop.lightningAll();
  const hours = new Map();
  for (const s of all) hours.set(Math.floor(s.ms / 3600000), (hours.get(Math.floor(s.ms / 3600000)) || 0) + 1);
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  const end = new Date(hour * 3600000 + 3600000);
  const start = new Date(end.getTime() - 12 * 3600000);

  const state = () => ({
    shown: window.RadarLoop.lightningFiltered().length,
    lifespan: window.RadarLoop.lightning.lifespanHours,
    showAll: window.RadarLoop.lightning.showAll,
    mode: window.RadarLoop.time.mode,
    current: new Date(window.RadarLoop.time.current).toISOString(),
    filter: window.RadarLoop.time.filterStart
      ? [window.RadarLoop.time.filterStart.toISOString(), window.RadarLoop.time.filterEnd.toISOString()]
      : null,
  });

  const before = state();
  window.RadarLoop.playback.applyFilter(start, end);
  await settle();
  const applied = state();

  // And the window the strike filter is actually using.
  const w = window.RadarLoop.playback.activeWindow(window.RadarLoop.lightning.lifespanHours);
  return {
    before,
    applied,
    activeWindow: {
      start: w.start.toISOString(), end: w.end.toISOString(), progressive: w.progressive,
      spanHours: +((w.end - w.start) / 3600000).toFixed(2),
    },
  };
});
console.log(JSON.stringify(report, null, 1));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
