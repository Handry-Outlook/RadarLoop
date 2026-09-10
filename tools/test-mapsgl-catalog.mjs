/**
 * The expanded MapsGL catalogue.
 *
 * The original file used nine of these; the SDK offers far more. This checks
 * they reached the picker, landed in sensible groups, and — for a sample across
 * every group — that selecting one actually puts a layer on the map rather than
 * merely appearing in a list.
 *
 * Pass SAMPLE=all to exercise every one of them; it takes a while.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });

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

/* ================================================================== *
 * The catalogue
 * ================================================================== */
console.log('\n=== catalogue ===');

const survey = await page.evaluate(() => {
  const { LAYER_CATALOG, LAYER_ORDER } = window.__layers;
  const byGroup = {};
  const labels = [];
  let total = 0;
  let unlisted = 0;

  for (const [group, defs] of Object.entries(LAYER_CATALOG)) {
    for (const [key, def] of Object.entries(defs)) {
      if (key === '__order' || def?.kind !== 'mapsgl') continue;
      total += 1;
      byGroup[group] = (byGroup[group] || 0) + 1;
      labels.push(def.label);
      if (!(LAYER_ORDER[group] || []).includes(key)) unlisted += 1;
    }
  }
  return { total, byGroup, unlisted, labels };
});

console.log(`  ${survey.total} MapsGL products across ${Object.keys(survey.byGroup).length} groups`);
for (const [group, n] of Object.entries(survey.byGroup).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${group.padEnd(16)} ${n}`);
}

ok('the catalogue grew well beyond the original nine', survey.total >= 200, `${survey.total}`);
ok('every one is offered in the picker', survey.unlisted === 0, `${survey.unlisted} unlisted`);
ok('road weather went into its own group', (survey.byGroup.roadWeather || 0) === 80,
   `${survey.byGroup.roadWeather}`);

// Labels are derived, so a broken rule shows up as a duplicate or a raw id.
const dupes = survey.labels.filter((l, i) => survey.labels.indexOf(l) !== i);
ok('no two products share a label', dupes.length === 0, JSON.stringify([...new Set(dupes)].slice(0, 6)));
ok('no label is a raw layer id', !survey.labels.some((l) => /^[a-z0-9-]+$/.test(l)),
   JSON.stringify(survey.labels.filter((l) => /^[a-z0-9-]+$/.test(l)).slice(0, 6)));

/* ================================================================== *
 * They actually render
 * ================================================================== */
console.log('\n=== rendering ===');

const sample = await page.evaluate((mode) => {
  const { LAYER_CATALOG } = window.__layers;
  const picked = [];
  for (const [group, defs] of Object.entries(LAYER_CATALOG)) {
    const mine = Object.entries(defs)
      .filter(([key, def]) => key !== '__order' && def?.kind === 'mapsgl')
      .map(([key, def]) => ({ group, type: key, label: def.label, id: def.id }));
    if (!mine.length) continue;
    picked.push(...(mode === 'all' ? mine : mine.slice(0, 2)));
  }
  return picked;
}, process.env.SAMPLE || 'sample');

console.log(`  trying ${sample.length} of them`);

const failed = [];
for (const entry of sample) {
  const state = await page.evaluate(async ({ group, type }) => {
    const before = window.RadarLoop.mapsglLayerIds();
    window.RadarLoop.selectProduct(group, type);
    await new Promise((r) => setTimeout(r, 2600));
    const ids = window.RadarLoop.mapsglLayerIds();
    const on = window.RadarLoop.slots.get(group)?.enabled;
    window.RadarLoop.setLayerEnabled(group, false);
    await new Promise((r) => setTimeout(r, 400));
    return { before, ids, on };
  }, entry);

  // Not an id match: the SDK expands several of these into other layers. A
  // regional product becomes one layer per region, and an aggregate like
  // `lightning-all` is decomposed into `lightning-flash` and `lightning-strikes`.
  // What matters is that selecting it puts something on the map.
  const drew = state.ids.length > 0 && state.before.length === 0;
  if (!drew) failed.push({ ...entry, saw: state.ids, before: state.before });
}

console.log(`  ${sample.length - failed.length} of ${sample.length} put a layer on the map`);
for (const f of failed.slice(0, 12)) console.log(`    nothing drawn: ${f.group}/${f.id}`);

ok('the sampled products all render', failed.length === 0,
   `${failed.length} did not: ${failed.slice(0, 8).map((f) => f.id).join(', ')}`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.slice(0, 8).forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
