/** The in-house strikes, drawn at a zoom where a single mark is legible. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);

const at = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  // The busiest hour in the archive, so there is a field to look at.
  const hours = new Map();
  for (const s of all) {
    const h = Math.floor(s.ms / 3600000);
    hours.set(h, (hours.get(h) || 0) + 1);
  }
  const [hour] = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
  const end = hour * 3600000 + 3600000;
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.lightning.nowcast = false;
  document.getElementById('panel')?.setAttribute('hidden', '');
  // A short window and a close zoom, so the sparse path runs and the marks are
  // shapes rather than pixels.
  window.RadarLoop.lightning.lifespanHours = 0.5;
  window.RadarLoop.playback.setHistorySpan(24 * 90);
  window.RadarLoop.playback.setTime(end, { immediate: true });
  window.RadarLoop.setBasemap('mapbox-light');
  return new Date(end).toISOString();
});
await page.waitForTimeout(9000);
await page.evaluate(() => window.RadarLoop.map().setView([55.05, 1.1], 11));
await page.waitForTimeout(5000);
// Scrubbing an archive has no arrivals, so the last few minutes are marked as
// though they had just come in — otherwise the bolt never appears in a still.
await page.evaluate(() => {
  const layer = window.__strikeLayer();
  const buffer = layer._buffers[0];
  layer.setStrikeBuffers(layer._buffers, {
    end: layer._windowEnd,
    lifespanHours: layer._lifespanMs / 3600000,
    freshSince: buffer.base + buffer.t[buffer.count - 1] - 4 * 60000,
  });
});
await page.waitForTimeout(6000);
console.log(JSON.stringify({ at, state: await page.evaluate(() => {
    const l = window.__strikeLayer();
    return { mode: l?._lastMode, visible: l?._lastVisible, buffers: l?._buffers?.length, count: l?._buffers?.[0]?.count, mark: l?.options?.mark };
  }), errors: [...new Set(errors)] }));
await page.screenshot({ path: 'shots/strike-marks.png', clip: { x: 350, y: 150, width: 560, height: 460 } });
console.log('written shots/strike-marks.png');
await browser.close();
