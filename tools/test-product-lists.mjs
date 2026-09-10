/**
 * What the product pickers offer, and in what order.
 *
 * Both are derived from the catalog rather than kept in step by hand, and both
 * used to be able to drift: `listed` was read only by the search box, so a
 * retired product stayed in every picker, and the drop-list order was a
 * hand-written array beside the entries it named.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const report = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__catalog;
  const rankOf = (def) => {
    if (!def) return 3;
    if (def.kind === 'mapsgl' || def.kind === 'xweather') return 2;
    const u = String(def.url || '');
    if (/windy\.com/.test(u)) return 0;
    if (/dtn\.com/.test(u)) return 1;
    if (/aerisapi\.com|aerisweather\.com/.test(u)) return 2;
    return 3;
  };

  const out = { groups: {}, retiredOffered: [], unlistedShown: [], emptyHeaders: [], outOfOrder: [] };
  for (const [group, order] of Object.entries(LAYER_ORDER)) {
    const defs = LAYER_CATALOG[group];
    const names = order.filter((e) => typeof e === 'string');
    out.groups[group] = names.length;

    for (const key of names) {
      if (!defs[key]) out.retiredOffered.push(`${group}/${key}`);
      else if (!defs[key].listed) out.unlistedShown.push(`${group}/${key}`);
    }

    // Ranks must not decrease within a section.
    let last = -1;
    let header = null;
    for (const entry of order) {
      if (typeof entry !== 'string') {
        header = entry.header;
        last = -1;
        continue;
      }
      const rank = rankOf(defs[entry]);
      if (rank < last) out.outOfOrder.push(`${group}${header ? ` [${header}]` : ''}/${entry}`);
      last = rank;
    }

    // A heading with nothing under it.
    order.forEach((entry, i) => {
      if (typeof entry === 'string') return;
      const next = order[i + 1];
      if (next === undefined || typeof next !== 'string') out.emptyHeaders.push(`${group}/${entry.header}`);
    });
  }

  // No provider names left in a heading.
  out.headers = Object.values(LAYER_ORDER)
    .flat()
    .filter((e) => typeof e !== 'string')
    .map((e) => e.header);
  return out;
});

console.log(`  groups: ${JSON.stringify(report.groups)}`);
console.log(`  headers: ${JSON.stringify(report.headers)}`);

ok('nothing is offered that the catalog no longer defines',
   report.retiredOffered.length === 0, report.retiredOffered.join(', '));
ok('a retired product is not offered',
   report.unlistedShown.length === 0, report.unlistedShown.join(', '));
ok('no heading is left with nothing under it',
   report.emptyHeaders.length === 0, report.emptyHeaders.join(', '));
ok('within every section the order runs windy, then dtn, then xweather, then the rest',
   report.outOfOrder.length === 0, report.outOfOrder.join(', '));
ok('no heading names a provider',
   !report.headers.some((h) => /MapsGL|Windy|Aeris|DTN|Xweather|EUMETSAT/i.test(h)),
   JSON.stringify(report.headers));

/* ---- and the pickers agree with all that ---- */
console.log('\n=== the pickers themselves ===');
const picker = await page.evaluate(() => {
  const select = document.querySelector('#panel select.select');
  if (!select) return null;
  return {
    groups: [...select.querySelectorAll('optgroup')].map((g) => g.label),
    first: select.options[0]?.textContent,
    count: select.options.length,
    selected: select.value,
    selectedIsOffered: [...select.options].some((o) => o.value === select.value),
  };
});
console.log(`  ${JSON.stringify(picker)}`);
ok('the radar picker leads with the global composite',
   /Global High Resolution Rainfall/.test(picker?.first || ''), String(picker?.first));
ok('what is selected is something the picker offers', picker?.selectedIsOffered === true,
   String(picker?.selected));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
