/**
 * Resetting the stacking order must not lose layers.
 *
 * `order` holds catalog groups and registered overlays together, but the default
 * it was reset to — `LAYER_GROUPS` — lists only the catalog groups. Assigning it
 * wholesale dropped every overlay out of the ordering, so their rows vanished
 * from the layer list while the layers themselves stayed on the map: cards gone,
 * map unchanged, which is a confusing way for a bug to present.
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
await page.waitForTimeout(10000);

await page.click('.rail__btn[data-group="layers"]');
await page.waitForTimeout(1200);

const snapshot = () => page.evaluate(() => ({
  listed: [...document.querySelectorAll('.layer-list .layer-row')].map((row) =>
    row.querySelector('.layer-row__title')?.textContent?.trim()),
  order: window.RadarLoop.layerOrder(),
  observationsOnMap: !!window.RadarLoop.map().getPane('synopticPane')?.querySelector('canvas'),
  plotted: window.RadarLoop.observations().plotted,
}));

const reset = async () => {
  await page.click('#panel button.btn--block');
  await page.waitForTimeout(900);
};

const before = await snapshot();
console.log(`  before: ${JSON.stringify(before.listed)}`);

ok('the layer list is showing something', before.listed.length > 0, JSON.stringify(before.listed));
ok('the station models are among the layers listed',
   before.order.includes('observations'), JSON.stringify(before.order));

/* ---- reset without having reordered anything, which is how it was hit ---- */
await reset();
const after = await snapshot();
console.log(`  after:  ${JSON.stringify(after.listed)}`);

const lost = before.listed.filter((title) => !after.listed.includes(title));
ok('resetting loses no rows from the list', lost.length === 0, `lost: ${JSON.stringify(lost)}`);
ok('the overlays are still in the ordering',
   after.order.includes('observations'), JSON.stringify(after.order));
// The symptom that made this confusing: the map never changed, only the list.
ok('and the map was never affected either way',
   after.observationsOnMap === true && after.plotted > 0,
   JSON.stringify({ onMap: after.observationsOnMap, plotted: after.plotted }));

/* ---- reset after a deliberate reorder ---- */
const moved = await page.evaluate(async () => {
  const rows = [...document.querySelectorAll('.layer-list .layer-row')];
  rows[rows.length - 1].querySelector('[aria-label="Move up"]').click();
  await new Promise((r) => setTimeout(r, 600));
  return [...document.querySelectorAll('.layer-list .layer-row')].map((row) =>
    row.querySelector('.layer-row__title')?.textContent?.trim());
});
console.log(`  after moving one: ${JSON.stringify(moved)}`);
ok('a reorder actually changes the list',
   JSON.stringify(moved) !== JSON.stringify(after.listed), JSON.stringify(moved));

await reset();
const restored = await snapshot();
console.log(`  after reset:      ${JSON.stringify(restored.listed)}`);
ok('and resetting puts it back', JSON.stringify(restored.listed) === JSON.stringify(after.listed),
   `${JSON.stringify(after.listed)} vs ${JSON.stringify(restored.listed)}`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
