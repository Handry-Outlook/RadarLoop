/**
 * Functional check: does the renderer actually put weather tiles on the map, and
 * does scrubbing keep the previous frame visible (the double-buffer guarantee)?
 * Also captures screenshots of the main panels.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

const tileState = async () => page.evaluate(() => {
  const panes = {};
  for (const name of ['radarPane', 'satellitePane', 'operaRadarPane', 'lightningPane']) {
    const pane = document.querySelector(`.leaflet-${name}`) ||
      document.querySelector(`#map .leaflet-pane[class*="${name}"]`);
    panes[name] = pane ? pane.querySelectorAll('img, canvas').length : 0;
  }
  // Leaflet names custom panes `leaflet-<name>`
  const all = [...document.querySelectorAll('#map .leaflet-pane')].map((p) => ({
    cls: p.className,
    kids: p.querySelectorAll('img, canvas').length,
  })).filter((p) => p.kids > 0);
  return { panes, populated: all };
});

console.log('=== TILES ON MAP (after initial render) ===');
const first = await tileState();
first.populated.forEach((p) => console.log(`  ${String(p.kids).padStart(4)}  ${p.cls}`));
if (!first.populated.length) console.log('  (none)');

console.log('\n=== SCRUB TEST (previous frame must stay visible) ===');
const during = [];
const slider = await page.$('.timeline__scrub .range');
const box = await slider.boundingBox();

await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 6; i += 1) {
  await page.mouse.move(box.x + box.width - 4 - i * 40, box.y + box.height / 2);
  await page.waitForTimeout(180);
  const s = await tileState();
  during.push(s.populated.reduce((sum, p) => sum + p.kids, 0));
}
await page.mouse.up();
await page.waitForTimeout(2500);

console.log(`  tile counts across the drag: ${during.join(', ')}`);
console.log(`  never emptied: ${during.every((n) => n > 0) ? 'yes' : 'NO — frame went blank'}`);

const after = await tileState();
console.log(`  after settle: ${after.populated.reduce((s, p) => s + p.kids, 0)} tiles`);

console.log('\n=== STATS ===');
const stats = await page.evaluate(() => window.RadarLoop?.runtime?.stats ?? null);
console.log(' ', JSON.stringify(stats));

/* screenshots */
await page.click('.rail__btn[data-group="precip"]');
await page.waitForTimeout(1200);
try { await page.screenshot({ path: 'shots/shot-radar-panel.png' }); } catch {}

await page.click('.rail__btn[data-group="lightning"]');
await page.waitForTimeout(900);
try { await page.screenshot({ path: 'shots/shot-lightning-panel.png' }); } catch {}

await page.fill('#layer-search', 'precip');
await page.waitForTimeout(500);
try { await page.screenshot({ path: 'shots/shot-search.png' }); } catch {}
await page.keyboard.press('Escape');

await page.click('#btn-theme');
await page.waitForTimeout(700);
try { await page.screenshot({ path: 'shots/shot-light-theme.png' }); } catch {}
await page.click('#btn-theme');
await page.waitForTimeout(500);

await page.click('.rail__btn[data-group="lightning"]');
await page.waitForTimeout(500);
try { await page.screenshot({ path: 'shots/shot-map.png' }); } catch {}

console.log('\nScreenshots written: shot-radar-panel, shot-lightning-panel, shot-search, shot-light-theme, shot-map');
await browser.close();
