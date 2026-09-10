/**
 * Playback in 3D, against the same run in 2D.
 *
 * A 3D frame is a 2D frame plus a capture of the hidden Leaflet map uploaded as
 * a GL texture, so the questions are how many frames survive that extra step and
 * how many captures come back with nothing in them — a blank capture is the
 * "most of the time nothing is plotted" symptom.
 *
 * **Each mode gets its own browser context.** Measuring both in one session was
 * meaningless: the 2D pass warmed the HTTP cache, so the 3D pass replayed the
 * same frames from disk and looked faster than 2D. A fresh context per mode is
 * the only way to see what a cold session actually costs.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

async function run({ mode, speed, seconds = 14, layerCount = 1, cpu = 1 }) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

  // Radar tiles are fetched inside the worker pool, which page requests do not
  // report, so the decode counter is the only honest tile count for them.
  let images = 0;
  page.on('request', (r) => { if (r.resourceType() === 'image') images += 1; });

  // A capable desktop GPU hides the cost this is looking for, so the device can
  // be slowed down deliberately. CPU throttling is the only knob the protocol
  // offers, but it stands in well: the per-frame texture upload and the GL draw
  // both land on the same thread it slows.
  const client = await context.newCDPSession(page);
  if (cpu > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(11000);
  // A realistic stack, not radar alone: every enabled layer is captured and
  // uploaded separately in 3D, so one layer understates what a session costs.
  await page.evaluate((layers) => {
    window.RadarLoop.selectProduct('radar', 'windy-radar');
    if (layers > 1) {
      window.RadarLoop.selectProduct('satellite', 'geocolor-global');
      window.RadarLoop.setLayerEnabled('lightning', true);
    } else {
      window.RadarLoop.setLayerEnabled('satellite', false);
    }
  }, layerCount);
  await page.waitForTimeout(9000);

  if (mode === '3D') {
    await page.click('#btn-3d');
    await page.waitForTimeout(15000);
  }

  const before = images;
  const result = await page.evaluate(async ({ s, ms }) => {
    window.RadarLoop.time.speed = s;
    const m0 = window.RadarLoop.mirrorStats();
    const w0 = window.RadarLoop.tileWorkers().decoded;
    const seen = [];
    const start = performance.now();
    let lastUrl = window.RadarLoop.slots.get('radar').lastUrl;

    window.RadarLoop.playback.play();
    const poll = setInterval(() => {
      const slot = window.RadarLoop.slots.get('radar');
      if (slot.lastUrl && slot.lastUrl !== lastUrl) {
        seen.push(Math.round(performance.now() - start));
        lastUrl = slot.lastUrl;
      }
    }, 15);
    await new Promise((r) => setTimeout(r, ms));
    clearInterval(poll);
    window.RadarLoop.playback.stop();
    await new Promise((r) => setTimeout(r, 400));

    const m1 = window.RadarLoop.mirrorStats();
    const decoded = window.RadarLoop.tileWorkers().decoded - w0;
    const gaps = seen.slice(1).map((t, i) => t - seen[i]).sort((a, b) => a - b);
    return {
      frames: seen.length,
      median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      worst: gaps.length ? gaps[gaps.length - 1] : null,
      attempts: m1.attempts - m0.attempts,
      captured: m1.captured - m0.captured,
      noneDrawn: m1.noneDrawn - m0.noneDrawn,
      noTiles: m1.noTiles - m0.noTiles,
      lastDrew: m1.lastDrew,
      decoded,
      phases: window.RadarLoop.phases().radar,
    };
  }, { s: speed, ms: seconds * 1000 });

  const used = images - before;
  console.log(
    `  ${mode} ${speed}x ${cpu > 1 ? `cpu/${cpu}` : '     '}  ${String(result.frames).padStart(2)} frames  `
    + `median ${String(result.median).padStart(5)}ms  worst ${String(result.worst).padStart(5)}ms  `
    + `${String(result.decoded).padStart(4)} radar tiles  `
    + `${(result.decoded / Math.max(1, result.frames)).toFixed(0)}/frame  ${used} other`,
  );
  if (mode === '3D') {
    console.log(
      `           mirror: ${result.attempts} attempts, ${result.captured} captured, `
      + `${result.noneDrawn} empty, ${result.noTiles} no-tiles, last drew ${result.lastDrew} tiles`,
    );
  }
  console.log(`           phases=${JSON.stringify(result.phases)}`);
  await context.close();
  return result;
}

console.log('\n=== radar only ===');
await run({ mode: '2D', speed: 4 });
await run({ mode: '3D', speed: 4 });

console.log('\n=== radar + satellite + lightning ===');
await run({ mode: '2D', speed: 4, layerCount: 3 });
await run({ mode: '3D', speed: 4, layerCount: 3 });

console.log('\n=== slower device (CPU throttled 6x) ===');
await run({ mode: '2D', speed: 4, layerCount: 3, cpu: 6 });
await run({ mode: '3D', speed: 4, layerCount: 3, cpu: 6 });

await browser.close();
