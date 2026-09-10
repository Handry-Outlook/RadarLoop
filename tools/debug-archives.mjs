/** Traces the archive fetch/parse/merge pipeline inside the page. */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log(`  [${m.type()}] ${m.text().slice(0, 220)}`);
});
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
page.on('requestfailed', (r) => {
  if (/githubusercontent/.test(r.url())) console.log(`  [failed] ${r.url().split('/').pop()} — ${r.failure()?.errorText}`);
});
page.on('response', async (r) => {
  if (/githubusercontent/.test(r.url())) {
    const len = r.headers()['content-length'];
    console.log(`  [response] ${r.status()} ${r.url().split('/').pop()} ${len ? `${(len / 1048576).toFixed(1)} MB` : ''}`);
  }
});

console.log('=== loading ===');
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(25000);

console.log('\n=== direct archive test in page context ===');
const direct = await page.evaluate(async () => {
  const urls = [
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new/refs/heads/main/lightning_data.json',
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new_2026/refs/heads/main/lightning_data_2026_summer.json',
  ];
  const out = [];
  for (const u of urls) {
    const t0 = performance.now();
    try {
      const res = await fetch(u);
      const text = await res.text();
      const parsed = JSON.parse(text);
      out.push({
        file: u.split('/').pop(),
        ok: res.ok,
        status: res.status,
        bytes: text.length,
        strikes: parsed?.lightning_strikes?.length ?? 0,
        ms: Math.round(performance.now() - t0),
      });
    } catch (e) {
      out.push({ file: u.split('/').pop(), error: String(e).slice(0, 160), ms: Math.round(performance.now() - t0) });
    }
  }
  return out;
});
console.log(JSON.stringify(direct, null, 2));

console.log('\n=== store state ===');
const state = await page.evaluate(() => {
  const all = window.RadarLoop.lightningAll();
  return {
    count: all.length,
    oldest: all.length ? new Date(all[0].ms).toISOString() : null,
    newest: all.length ? new Date(all[all.length - 1].ms).toISOString() : null,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
});
console.log(JSON.stringify(state, null, 2));

await browser.close();
