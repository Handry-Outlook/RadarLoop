/**
 * Live global strikes actually draw.
 *
 * The product has been in the catalog since the rewrite and never rendered
 * anything: its kind had no branch in the renderer, so it fell through to the
 * raster case and built a tile layer from an undefined URL. The endpoints for it
 * sat in config.js unread.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
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

/* ---- the decoding, against where lightning can actually be ---- */
console.log('\n=== decoding ===');
const decoded = await page.evaluate(async () => {
  const { decodeFeed } = window.__windyLightning;
  const payload = await (await fetch('https://node.windy.com/blitz/v3/hot', { cache: 'no-store' })).json();
  const strikes = decodeFeed(payload);
  const polar = strikes.filter((s) => Math.abs(s.lat) > 55).length;
  const ages = strikes.map((s) => (Date.now() - s.ms) / 1000);
  return {
    count: strikes.length,
    polarShare: +(100 * polar / strikes.length).toFixed(2),
    latRange: [Math.min(...strikes.map((s) => s.lat)), Math.max(...strikes.map((s) => s.lat))].map((n) => +n.toFixed(1)),
    lonRange: [Math.min(...strikes.map((s) => s.lon)), Math.max(...strikes.map((s) => s.lon))].map((n) => +n.toFixed(1)),
    oldestSeconds: Math.round(Math.max(...ages)),
    newestSeconds: Math.round(Math.min(...ages)),
  };
});
console.log(`  ${JSON.stringify(decoded)}`);
ok('the feed returns strikes', decoded.count > 100, `${decoded.count}`);
// The check that separates the right projection from the three wrong ones:
// Mercator put a third of the world's lightning inside the polar circles.
ok('almost none of it lands poleward of 55 degrees', decoded.polarShare < 5, `${decoded.polarShare}%`);
ok('the positions are within the world', Math.abs(decoded.latRange[0]) <= 90 && Math.abs(decoded.lonRange[1]) <= 180,
   JSON.stringify([decoded.latRange, decoded.lonRange]));
ok('and they are recent, not an archive', decoded.oldestSeconds < 1200, `oldest ${decoded.oldestSeconds}s`);

/* ---- and it draws ---- */
console.log('\n=== the layer ===');
await page.evaluate(() => {
  window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
  window.RadarLoop.setLayerEnabled('lightning', true);
  window.RadarLoop.map().setView([10, 20], 3);
});
await page.waitForTimeout(14000);

const drawn = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('.strike-canvas')];
  let lit = 0;
  for (const c of canvases) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 160) if (d[i] > 8) lit += 1;
  }
  return { canvases: canvases.length, lit, feed: window.__windyLightning.feedStats };
});
console.log(`  ${JSON.stringify(drawn)}`);
ok('the feed was polled', drawn.feed.polls > 0 && drawn.feed.failed === 0, JSON.stringify(drawn.feed));
ok('strikes were held', drawn.feed.held > 0, `${drawn.feed.held}`);
ok('some fell inside the scrubber window', drawn.feed.drawn > 0, `${drawn.feed.drawn}`);
ok('and pixels were actually painted', drawn.lit > 0, `${drawn.lit} lit samples`);

await page.screenshot({ path: 'shots/windy-lightning.png' });

/* ---- and in 3D ---- */
console.log('\n=== 3D ===');
await page.evaluate(() => document.getElementById('btn-3d').click());
const mirrored = await page.evaluate(async () => {
  for (let i = 0; i < 50; i += 1) {
    const kind = window.RadarLoop.mirrorKind('lightning');
    if (kind) return kind;
    await new Promise((r) => setTimeout(r, 500));
  }
  return window.RadarLoop.mirrorKind('lightning');
});
console.log(`  mirror kind: ${mirrored}`);
ok('the live strikes reach the 3D view', !!mirrored, String(mirrored));
await page.screenshot({ path: 'shots/windy-lightning-3d.png' });
await page.evaluate(() => document.getElementById('btn-3d').click());
await page.waitForTimeout(2500);

/* ---- switching it off stops the polling ---- */
const after = await page.evaluate(async () => {
  window.RadarLoop.setLayerEnabled('lightning', false);
  const at = window.__windyLightning.feedStats.polls;
  await new Promise((r) => setTimeout(r, 3000));
  return { pollsAtRemoval: at, pollsNow: window.__windyLightning.feedStats.polls, held: window.__windyLightning.feedStats.held };
});
console.log(`  ${JSON.stringify(after)}`);
ok('turning it off releases the store', after.held === 0, `${after.held} still held`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
