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


/* ================================================================== *
 * The archive
 * ================================================================== */
console.log('\n=== archive frames ===');

const archive = await page.evaluate(async () => {
  const { parseFrame, bufferStrikes, framesCovering } = window.__windyLightning;
  const bucket = Math.floor((Date.now() - 20 * 60000) / 300000) * 300000;
  const buf = await (await fetch(`https://ims.windy.com/blitz/v3/5mins/${bucket}?version=3`)).arrayBuffer();
  const strikes = bufferStrikes(parseFrame(buf, bucket));
  const polar = strikes.filter((s) => Math.abs(s.lat) > 55).length;
  const times = strikes.map((s) => s.ms);
  return {
    bytes: buf.byteLength,
    count: strikes.length,
    polarShare: +(100 * polar / strikes.length).toFixed(2),
    // Every strike must fall inside the five minutes the frame covers.
    insideFrame: strikes.every((s) => s.ms >= bucket && s.ms < bucket + 300000),
    span: [Math.min(...times) - bucket, Math.max(...times) - bucket],
    // A day's window asks for a day of frames, no further back than the horizon.
    dayFrames: framesCovering(Date.now() - 24 * 3600000, Date.now()).length,
    tooOld: framesCovering(Date.now() - 100 * 3600000, Date.now() - 90 * 3600000).length,
  };
});
console.log(`  ${JSON.stringify(archive)}`);
ok('a frame parses', archive.count > 100, JSON.stringify(archive));
// The decode was settled against the live feed; this is the standing guard.
ok('and lands where lightning lands', archive.polarShare < 5, `${archive.polarShare}%`);
ok('every strike falls inside the frame it came from', archive.insideFrame === true,
   JSON.stringify(archive.span));
ok('a day of scrubbing asks for a day of frames', archive.dayFrames > 250 && archive.dayFrames < 300,
   `${archive.dayFrames}`);
ok('and nothing is requested past the horizon', archive.tooOld === 0, `${archive.tooOld}`);

/* ---- scrubbing back actually draws archived strikes ---- */
const past = await page.evaluate(async () => {
  window.RadarLoop.playback.setHistorySpan(24);
  window.RadarLoop.playback.setTime(Date.now() - 6 * 3600000, { immediate: true });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (window.__windyLightning.feedStats.framesLoaded > 3
        && window.__windyLightning.feedStats.drawn > 0) break;
  }
  const canvases = [...document.querySelectorAll('.strike-canvas')];
  let lit = 0;
  for (const c of canvases) {
    if (!c.width) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 160) if (d[i] > 8) lit += 1;
  }
  return { showing: new Date(window.RadarLoop.time.current).toISOString(), lit, feed: window.__windyLightning.feedStats };
});
console.log(`  ${JSON.stringify(past)}`);
ok('scrubbing six hours back loads frames', past.feed.framesLoaded > 3, JSON.stringify(past.feed));
ok('and paints strikes from them', past.lit > 0 && past.feed.drawn > 0,
   `${past.lit} lit, ${past.feed.drawn} drawn`);
await page.screenshot({ path: 'shots/windy-lightning-archive.png' });

/* ---- every strike, and fast enough ---- */
const bulk = await page.evaluate(async () => {
  const map = window.RadarLoop.map();
  const { mercatorX, mercatorY } = window.__strikeRender;
  // The inlined projection must agree with Leaflet's, or every strike is drawn
  // in the wrong place very efficiently.
  const scale = map.getPixelWorldBounds().getSize().x;
  const origin = map.getPixelBounds().min;
  let worst = 0;
  for (const [lat, lon] of [[51.5, -0.1], [-33.9, 151.2], [0, 0], [70, -160], [-60, 30]]) {
    const theirs = map.latLngToContainerPoint([lat, lon]);
    worst = Math.max(worst,
      Math.abs(mercatorX(lon) * scale - origin.x - theirs.x),
      Math.abs(mercatorY(lat) * scale - origin.y - theirs.y));
  }

  window.RadarLoop.lightning.lifespanHours = 12;
  map.setView([15, 15], 3);
  const layer = window.RadarLoop.slots.get('lightning').front;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = window.__windyLightning.feedStats;
    if (s.framesLoaded >= s.framesWanted - 1) break;
  }
  const at = performance.now();
  layer._render();
  return {
    projectionError: +worst.toFixed(2),
    renderMs: +(performance.now() - at).toFixed(1),
    onScreen: layer.drawnCount(),
    feed: window.__windyLightning.feedStats,
  };
});
console.log(`  ${JSON.stringify(bulk)}`);
ok('the inlined projection agrees with Leaflet', bulk.projectionError < 1, `${bulk.projectionError}px`);
// The point of the whole exercise: nothing is sampled away.
ok('every strike in the window is handed to the renderer',
   bulk.feed.available === bulk.feed.drawn && bulk.feed.drawn > 100000,
   `${bulk.feed.drawn} of ${bulk.feed.available}`);
ok('and the whole field is drawn on screen at world zoom',
   bulk.onScreen > bulk.feed.drawn * 0.9, `${bulk.onScreen} of ${bulk.feed.drawn}`);
// Measured at 45 ms for 1.66 million; the bound is loose enough for a loaded
// machine but would catch a return to per-strike canvas calls, which was 20x.
ok('a frame stays well under a freeze', bulk.renderMs < 400, `${bulk.renderMs}ms`);

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
