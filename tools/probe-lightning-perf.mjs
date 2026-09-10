/**
 * A full day of global lightning: does it draw, and does it stay responsive?
 *
 * The point of the typed-array buffers is that every strike is plotted, so this
 * measures the two things that decides: how many are actually on screen, and how
 * long a frame takes to put them there.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

// The inlined projection must agree with Leaflet's, or every strike is drawn in
// the wrong place very quickly.
const projection = await page.evaluate(() => {
  const map = window.RadarLoop.map();
  const { mercatorX, mercatorY } = window.__strikeRender;
  const scale = map.getPixelWorldBounds().getSize().x;
  const origin = map.getPixelBounds().min;
  let worst = 0;
  for (const [lat, lon] of [[51.5, -0.1], [-33.9, 151.2], [0, 0], [70, -160], [-60, 30]]) {
    const mine = { x: mercatorX(lon) * scale - origin.x, y: mercatorY(lat) * scale - origin.y };
    const theirs = map.latLngToContainerPoint([lat, lon]);
    worst = Math.max(worst, Math.abs(mine.x - theirs.x), Math.abs(mine.y - theirs.y));
  }
  return { worstPixels: +worst.toFixed(3) };
});
console.log(`inline projection vs Leaflet: worst error ${projection.worstPixels}px`);

await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  document.getElementById('panel')?.setAttribute('hidden', '');
  window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
  window.RadarLoop.setLayerEnabled('lightning', true);
  window.RadarLoop.lightning.lifespanHours = 24;
  window.RadarLoop.playback.setHistorySpan(24);
  window.RadarLoop.map().setView([20, 10], 2);
});

// Loading a day is 289 frames; give it room.
let last = -1;
for (let i = 0; i < 90; i += 1) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => window.__windyLightning.feedStats);
  if (s.framesLoaded === last && s.framesLoaded >= s.framesWanted - 2) break;
  last = s.framesLoaded;
  if (i % 5 === 0) console.log(`  frames ${s.framesLoaded}/${s.framesWanted}, ${s.received.toLocaleString()} strikes`);
}

const perf = await page.evaluate(async () => {
  const layer = window.RadarLoop.slots.get('lightning').front;
  const time = (fn) => { const t = performance.now(); fn(); return +(performance.now() - t).toFixed(1); };
  const world = time(() => layer._render());
  const drawnWorld = layer.drawnCount();
  window.RadarLoop.map().setView([51.5, -1], 6);
  await new Promise((r) => setTimeout(r, 900));
  const regional = time(() => layer._render());
  return { world, drawnWorld, regional, drawnRegional: layer.drawnCount(), feed: window.__windyLightning.feedStats };
});
console.log(JSON.stringify(perf, null, 1));
console.log(JSON.stringify({ errors: [...new Set(errors)] }));

await page.evaluate(() => window.RadarLoop.map().setView([15, 10], 2));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/lightning-24h.png' });
await browser.close();
