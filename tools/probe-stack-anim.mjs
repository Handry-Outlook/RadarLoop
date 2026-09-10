/** Where the station pane actually sits, and what a slow layer does to playback. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);

await page.evaluate(() => {
  window.RadarLoop.map().setView([40.5, -76.5], 6, { animate: false });
  window.RadarLoop.setLayerEnabled('observations', true);
  window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor');
});
await page.waitForTimeout(16000);

console.log('=== pane stacking ===');
console.log(JSON.stringify(await page.evaluate(() => {
  const m = window.RadarLoop.map();
  const info = (name) => {
    const p = m.getPane(name);
    if (!p) return null;
    return {
      z: p.style.zIndex || getComputedStyle(p).zIndex,
      parent: p.parentElement?.className.replace('leaflet-pane leaflet-', '') || 'map',
    };
  };
  return {
    synoptic: info('synopticPane'),
    satellite: info('satellitePane'),
    overlay: info('overlayPane'),
    order: window.RadarLoop.layerOrder(),
  };
}), null, 1));

console.log('\n=== playback with a slow WMS enabled ===');
for (const withWms of [true, false]) {
  const r = await page.evaluate(async (on) => {
    window.RadarLoop.setLayerEnabled('satellite', on);
    await new Promise((r2) => setTimeout(r2, 6000));
    window.RadarLoop.time.speed = 4;
    const seen = [];
    const start = performance.now();
    let last = window.RadarLoop.slots.get('radar').lastUrl;
    window.RadarLoop.playback.play();
    const poll = setInterval(() => {
      const s = window.RadarLoop.slots.get('radar');
      if (s.lastUrl && s.lastUrl !== last) { seen.push(Math.round(performance.now() - start)); last = s.lastUrl; }
    }, 20);
    await new Promise((r2) => setTimeout(r2, 14000));
    clearInterval(poll);
    window.RadarLoop.playback.stop();
    const gaps = seen.slice(1).map((t, i) => t - seen[i]).sort((a, b) => a - b);
    return { frames: seen.length, median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null };
  }, withWms);
  console.log(`  EUMETSAT ${withWms ? 'on ' : 'off'}: ${r.frames} radar frames in 14s, median gap ${r.median}ms`);
}
await browser.close();
