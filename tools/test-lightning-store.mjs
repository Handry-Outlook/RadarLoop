/**
 * History that outlives the provider's 24 hours.
 *
 * The provider keeps exactly a day: a frame 24 hours old is served in full, one
 * 25 hours old returns 204, and every hour beyond stays empty. So the only way
 * further back is to keep what has already been fetched. This checks that frames
 * are kept, that a second session reads them back rather than refetching, and
 * that the window can then reach past the day.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
// One profile across both visits, or there is no store to find the second time.
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const errors = [];

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const visit = async () => {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);
  await page.evaluate(() => {
    window.RadarLoop.setLayerEnabled('radar', false);
    window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
    window.RadarLoop.setLayerEnabled('lightning', true);
    window.RadarLoop.lightning.lifespanHours = 1;
    window.RadarLoop.map().setView([20, 10], 3);
  });
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__windyLightning.feedStats);
    if (s.framesLoaded >= s.framesWanted && s.framesWanted > 0) break;
  }
  return page;
};

console.log('\n=== first visit: frames are fetched and kept ===');
const first = await visit();
await first.waitForTimeout(3000);
const one = await first.evaluate(() => window.__windyLightning.feedStats);
console.log(`  ${JSON.stringify({ loaded: one.framesLoaded, fromStore: one.framesFromStore, received: one.received })}`);
ok('frames were fetched', one.framesLoaded > 5, `${one.framesLoaded}`);
ok('and none came from an empty store', one.framesFromStore === 0, `${one.framesFromStore}`);
const stored = await first.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  return window.__strikeStore.summary();
});
console.log(`  stored: ${JSON.stringify(stored)}`);
ok('the frames were written to the store', stored.count > 5, JSON.stringify(stored));
await first.close();

console.log('\n=== second visit: they are read back ===');
const second = await visit();
await second.waitForTimeout(3000);
const two = await second.evaluate(() => window.__windyLightning.feedStats);
console.log(`  ${JSON.stringify({ loaded: two.framesLoaded, fromStore: two.framesFromStore, storedOldest: two.storedOldest })}`);
ok('frames came back from the store rather than the network',
   two.framesFromStore > 5, `${two.framesFromStore} of ${two.framesLoaded}`);
ok('and the layer knows how far back it reaches',
   Number.isFinite(two.storedOldest), String(two.storedOldest));

console.log('\n=== the window can reach past the provider ===');
const reach = await second.evaluate(() => {
  const { framesCovering } = window.__windyLightning;
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  return {
    withoutStore: framesCovering(weekAgo, now, now, null).length,
    withStore: framesCovering(weekAgo, now, now, now - 48 * 3600 * 1000).length,
  };
});
console.log(`  ${JSON.stringify(reach)}`);
// A day is 288 five-minute frames; two days is 576.
ok('without a store the window stops at the provider\'s day',
   reach.withoutStore > 280 && reach.withoutStore < 295, `${reach.withoutStore}`);
ok('with one it reaches as far back as the store does',
   reach.withStore > 570 && reach.withStore < 585, `${reach.withStore}`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
