/**
 * Measures archive ingestion and verifies that focusing an outlook weeks back
 * eventually plots its strikes (the archive top-up path).
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

const sample = () => page.evaluate(() => ({
  loaded: window.RadarLoop?.lightningAll()?.length ?? 0,
  oldestHours: (() => {
    const a = window.RadarLoop?.lightningAll();
    return a?.length ? (Date.now() - a[0].ms) / 3600000 : 0;
  })(),
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));

console.log('=== archive ingestion ===');
console.log('   t(s)   strikes    oldest(h)   heap(MB)');
for (let i = 0; i < 14; i += 1) {
  await page.waitForTimeout(5000);
  const s = await sample();
  console.log(
    `  ${String(((Date.now() - t0) / 1000).toFixed(0)).padStart(5)}` +
    `${String(s.loaded).padStart(10)}` +
    `${String(s.oldestHours.toFixed(0)).padStart(12)}` +
    `${String(s.heapMB ?? '-').padStart(11)}`,
  );
  if (s.oldestHours > 24 * 60) break; // archives clearly in
}

const final = await sample();
console.log(`\narchives ingested: ${final.loaded.toLocaleString()} strikes, ` +
  `oldest ${(final.oldestHours / 24).toFixed(0)} days back, heap ${final.heapMB} MB`);

/* --- focus an outlook weeks back and check strikes appear --- */
console.log('\n=== focusing a past window plots its strikes ===');

const result = await page.evaluate(async () => {
  // A day the archives are known to cover heavily.
  const start = new Date('2026-08-27T00:00:00Z');
  const end = new Date('2026-08-28T00:00:00Z');
  const before = window.RadarLoop.lightningFiltered().length;

  // Drive the same path the outlook panel uses.
  const mod = window.RadarLoop.focusWindow;
  if (!mod) return { error: 'focus hook missing' };
  mod(start, end);

  await new Promise((r) => setTimeout(r, 6000));
  return {
    before,
    after: window.RadarLoop.lightningFiltered().length,
    lifespan: window.RadarLoop.lightningLifespan(),
    domainHours: (window.RadarLoop.time.domainEnd - window.RadarLoop.time.domainStart) / 3600000,
  };
});

if (result.error) {
  console.log(`  skipped: ${result.error}`);
} else {
  console.log(`  strikes before: ${result.before}`);
  console.log(`  strikes after : ${result.after}`);
  console.log(`  lifespan      : ${result.lifespan} h (window ${result.domainHours} h)`);
  console.log(`  ${result.after > 0 ? 'PASS — the focused window plots its strikes' : 'FAIL — no strikes plotted'}`);
}

await browser.close();
