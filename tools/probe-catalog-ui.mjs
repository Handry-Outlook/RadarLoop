/** The picker, the search index and boot cost with the enlarged catalogue. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.rail__btn', { timeout: 30000 });
console.log(`shell ready in ${Date.now() - t0} ms`);
await page.waitForTimeout(9000);

// Building the observations panel now has to lay out 69 + 80 options.
const built = await page.evaluate(async () => {
  const t = performance.now();
  document.querySelector('.rail__btn[data-group="observations"]').click();
  await new Promise((r) => setTimeout(r, 900));
  const selects = [...document.querySelectorAll('#panel select')];
  return {
    ms: Math.round(performance.now() - t),
    selects: selects.length,
    options: selects.map((s) => s.options.length),
  };
});
console.log('observations panel:', JSON.stringify(built));

const search = await page.evaluate(async () => {
  const input = document.querySelector('#search-input, .search input, input[type="search"]');
  if (!input) return { error: 'no search input' };
  const t = performance.now();
  input.value = 'road';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const rows = document.querySelectorAll('.search__result, .search-result, [class*="search"] li, [class*="search"] button');
  return { ms: Math.round(performance.now() - t), results: rows.length };
});
console.log('search "road":', JSON.stringify(search));

const totals = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  let products = 0;
  for (const defs of Object.values(LAYER_CATALOG)) {
    products += Object.keys(defs).filter((k) => k !== '__order').length;
  }
  return { products, groups: Object.keys(LAYER_CATALOG).length,
           listed: Object.values(LAYER_ORDER).reduce((n, a) => n + a.length, 0) };
});
console.log('catalog totals:', JSON.stringify(totals));
await browser.close();
