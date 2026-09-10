/**
 * What the lightning layer holds, and what it is showing.
 *
 * The footer has been reading "0 strikes in window" against well over a million
 * loaded, which is either a filter that rejects everything or a store whose
 * timestamps do not line up with the window being asked for.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(14000);

const report = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  const filtered = window.RadarLoop.lightningFiltered();
  const l = window.RadarLoop.lightning;
  const at = (arr, i) => (arr[i] ? { ms: arr[i].ms, when: new Date(arr[i].ms).toISOString(), lat: arr[i].lat, lon: arr[i].lon } : null);
  const window_ = window.RadarLoop.playback.activeWindow(l.lifespanHours);
  return {
    footer: [...document.querySelectorAll('#timeline *')]
      .map((n) => n.textContent).find((t) => /strikes in window/.test(t || ''))?.trim() || null,
    loaded: all.length,
    filtered: filtered.length,
    oldest: at(all, 0),
    newest: at(all, all.length - 1),
    lifespanHours: l.lifespanHours,
    showLayer: l.showLayer,
    activeWindow: window_ && {
      start: new Date(window_.start).toISOString(),
      end: new Date(window_.end).toISOString(),
    },
    now: new Date().toISOString(),
    timelineAt: new Date(window.RadarLoop.time.current).toISOString(),
  };
});
console.log(JSON.stringify(report, null, 1));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));
await browser.close();
