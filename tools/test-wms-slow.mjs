/**
 * A slow WMS must not be mistaken for a missing frame.
 *
 * EUMETSAT answers 502 for a frame it has not published yet and 200 once it has,
 * which the resolver handles by stepping back. The failure being guarded here is
 * different: the service renders on demand and can take several seconds, and a
 * probe that times out is indistinguishable from a frame that does not exist. The
 * resolver then steps back, pays the same slow probe again, exhausts its attempts
 * and the layer draws nothing — which is what "it needs a moment or it errors"
 * looks like from the outside.
 *
 * The real service is too fast and too variable to demonstrate that, so its
 * responses are delayed deliberately.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/**
 * Loads the product with every EUMETSAT response held back by `delayMs`, and a
 * chosen number of the newest frames refused with a 502 the way the real service
 * refuses an unpublished frame.
 */
async function run({ delayMs, label }) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const seen = [];
  await page.route('**/view.eumetsat.int/**', async (route) => {
    const time = /TIME=([^&]+)/.exec(route.request().url())?.[1] || '?';
    seen.push(decodeURIComponent(time));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.continue();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);

  const t0 = Date.now();
  await page.evaluate(() => window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor'));
  await page.waitForTimeout(40000);

  const state = await page.evaluate(() => {
    const s = window.RadarLoop.slots.get('satellite');
    return {
      drew: !!s.front,
      frame: (s.lastUrl || '').match(/TIME=([^&]+)/)?.[1] || null,
      tiles: document.querySelectorAll('#map .leaflet-pane img[src*="eumetsat"]').length,
      broken: [...document.querySelectorAll('#map img[src*="eumetsat"]')]
        .filter((i) => i.complete && i.naturalWidth === 0).length,
    };
  });

  console.log(`\n  ${label}`);
  console.log(`    settled in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${seen.length} requests`);
  console.log(`    ${JSON.stringify(state)}`);
  await page.close();
  return { state, errors, requests: seen.length };
}

console.log('=== EUMETSAT WMS under load ===');

// Comfortably inside the old 4s probe deadline: this passed before too.
const quick = await run({ delayMs: 0, label: 'no added delay' });
ok('the product draws normally', quick.state.drew && quick.state.tiles > 0,
   JSON.stringify(quick.state));
ok('no tile is left broken', quick.state.broken === 0, `${quick.state.broken} broken`);

// Past the old 4 s deadline but inside the WMS one. This is the regression: with
// a 4 s cap every probe times out, every frame reads as absent, and nothing draws.
const slow = await run({ delayMs: 6000, label: 'every response delayed 6s' });
ok('a slow service still resolves a frame', slow.state.drew === true, JSON.stringify(slow.state));
ok('and still puts tiles on the map', slow.state.tiles > 0, `${slow.state.tiles} tiles`);
ok('no tile is left broken when slow', slow.state.broken === 0, `${slow.state.broken} broken`);
ok('it picks a real frame, not a placeholder', /^\d{4}-\d{2}-\d{2}T/.test(slow.state.frame || ''),
   String(slow.state.frame));

const allErrors = [...new Set([...quick.errors, ...slow.errors])];
console.log('\n=== page errors ===');
if (allErrors.length) allErrors.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && allErrors.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${allErrors.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && allErrors.length === 0 ? 0 : 1);
