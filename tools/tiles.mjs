/** Checks that tiles in each weather pane actually decoded (naturalWidth > 0). */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(12000);

const report = await page.evaluate(() => {
  const out = {};
  for (const pane of document.querySelectorAll('#map .leaflet-pane')) {
    const name = pane.className.replace('leaflet-pane leaflet-', '').trim();
    const imgs = [...pane.querySelectorAll('img')];
    const canvases = [...pane.querySelectorAll('canvas')];
    if (!imgs.length && !canvases.length) continue;
    out[name] = {
      imgs: imgs.length,
      decoded: imgs.filter((i) => i.naturalWidth > 0).length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      canvases: canvases.length,
      sampleSrc: imgs[0]?.src?.slice(0, 130) ?? null,
    };
  }
  return out;
});

console.log('=== TILE INTEGRITY ===');
for (const [pane, r] of Object.entries(report)) {
  console.log(`  ${pane}`);
  console.log(`      imgs ${r.imgs}  decoded ${r.decoded}  broken ${r.broken}  canvases ${r.canvases}`);
  if (r.sampleSrc) console.log(`      ${r.sampleSrc}`);
}

const bad = Object.entries(report).filter(([, r]) => r.imgs > 0 && r.decoded === 0);
console.log(`\n${bad.length ? `PANES WITH NO DECODED TILES: ${bad.map(([p]) => p).join(', ')}` : 'All panes have decoded tiles'}`);

await browser.close();
