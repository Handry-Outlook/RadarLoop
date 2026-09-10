/**
 * Does the application get slower the longer it runs?
 *
 * Drives a realistic session — scrubbing, toggling layers, entering and leaving
 * 3D — and samples the same measurements every round, so a number that climbs
 * steadily is the leak. Everything here is a count of something that should be
 * bounded: if a cache, a timer set or a listener list only ever grows, it shows
 * up as a straight line.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const ROUNDS = Number(process.env.ROUNDS || 6);

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let requests = 0;
page.on('request', () => { requests += 1; });

const bootStart = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.rail__btn', { timeout: 30000 });
console.log(`shell ready in ${Date.now() - bootStart} ms`);
await page.waitForTimeout(12000);

const client = await page.context().newCDPSession(page);
// Metrics are not collected until the domain is enabled.
await client.send('Performance.enable');

const sample = async () => {
  const metrics = Object.fromEntries((await client.send('Performance.getMetrics')).metrics
    .map((m) => [m.name, m.value]));
  const inPage = await page.evaluate(() => {
    const counts = {};
    for (const pane of document.querySelectorAll('#map .leaflet-pane')) {
      counts.paneChildren = (counts.paneChildren || 0) + pane.children.length;
    }
    return {
      strikes: window.RadarLoop.lightningAll().length,
      filtered: window.RadarLoop.lightningFiltered().length,
      domImages: document.querySelectorAll('#map img').length,
      canvases: document.querySelectorAll('canvas').length,
      paneChildren: counts.paneChildren || 0,
      probes: window.RadarLoop.runtime.stats.probes,
      rendered: window.RadarLoop.runtime.stats.rendered,
      skipped: window.RadarLoop.runtime.stats.skippedFrames,
      workers: window.RadarLoop.tileWorkers?.().decoded ?? 0,
      mirrorAttempts: window.RadarLoop.mirrorStats?.().attempts ?? 0,
    };
  });
  return {
    heapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: metrics.Nodes,
    listeners: metrics.JSEventListeners,
    docs: metrics.Documents,
    ...inPage,
  };
};

/** One round of ordinary use, timed. */
const round = async (n) => {
  const t0 = Date.now();
  const before = requests;

  const stepMs = await page.evaluate(async () => {
    const slider = document.querySelector('.timeline__scrub .range');
    const max = Number(slider.max);
    const times = [];
    for (const fraction of [0.9, 0.75, 0.6, 0.45]) {
      const t = performance.now();
      const prev = window.RadarLoop.slots.get('radar').lastUrl;
      slider.value = String(Math.round(max * fraction));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      while (performance.now() - t < 9000) {
        const s = window.RadarLoop.slots.get('radar');
        if (s.lastUrl && s.lastUrl !== prev && s.front) break;
        if (performance.now() - t > 1500 && !window.RadarLoop.tileWorkers().inFlight) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25));
      }
      times.push(Math.round(performance.now() - t));
    }
    return times;
  });

  // Toggle a couple of layers, the way a session actually goes.
  await page.evaluate(async () => {
    window.RadarLoop.setLayerEnabled('satellite', true);
    await new Promise((r) => setTimeout(r, 1200));
    window.RadarLoop.setLayerEnabled('satellite', false);
    await new Promise((r) => setTimeout(r, 600));
  });

  const s = await sample();
  const median = [...stepMs].sort((a, b) => a - b)[Math.floor(stepMs.length / 2)];
  console.log(
    `round ${String(n).padStart(2)}  scrub ${String(median).padStart(5)}ms  `
    + `heap ${String(s.heapMB).padStart(6)}MB  nodes ${String(s.nodes).padStart(5)}  `
    + `listeners ${String(s.listeners).padStart(5)}  canvases ${String(s.canvases).padStart(4)}  `
    + `imgs ${String(s.domImages).padStart(4)}  probes ${String(s.probes).padStart(4)}  `
    + `reqs +${requests - before}`,
  );
  return { n, median, ...s, roundMs: Date.now() - t0 };
};

await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(8000);

console.log(`\n=== ${ROUNDS} rounds of ordinary use ===`);
const history = [];
for (let i = 1; i <= ROUNDS; i += 1) history.push(await round(i));

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */
console.log('\n=== drift, first round to last ===');
const first = history[0];
const last = history[history.length - 1];
const drift = (key) => {
  const a = first[key];
  const b = last[key];
  const pct = a ? (((b - a) / a) * 100).toFixed(0) : '—';
  console.log(`  ${key.padEnd(16)} ${String(a).padStart(8)} -> ${String(b).padStart(8)}   ${pct}%`);
  return b - a;
};

for (const key of ['median', 'heapMB', 'nodes', 'listeners', 'canvases', 'domImages', 'paneChildren']) {
  drift(key);
}

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.slice(0, 8).forEach((e) => console.log(`  ${e}`));
else console.log('  none');

await browser.close();
