/**
 * The global strikes must be restackable, and drawn as dots.
 *
 * Five groups had no pane of their own and fell through to `overlayPane` —
 * Leaflet's container for every other pane. So they drew into one another, and
 * restacking one set a z-index on the container, which moves the whole weather
 * stack instead of the one layer.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
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

await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

await page.evaluate(() => {
  window.RadarLoop.selectProduct('lightning', 'windy-live-lightning');
  window.RadarLoop.setLayerEnabled('lightning', true);
  window.RadarLoop.setLayerEnabled('radar', true);
  window.RadarLoop.map().setView([20, 10], 3);
});
await page.waitForTimeout(14000);

/* ---- each group owns a pane ---- */
console.log('\n=== panes ===');
const panes = await page.evaluate(() => {
  const map = window.RadarLoop.map();
  const names = ['satellite', 'radar', 'wind', 'nowcast', 'tropicalStorms', 'rotation', 'lightning'];
  const out = {};
  for (const g of names) {
    const pane = map.getPane(window.__paneFor(g));
    out[g] = { pane: window.__paneFor(g), z: pane?.style.zIndex || null };
  }
  out.strikeCanvasIn = document.querySelector('.strike-canvas')?.parentElement?.className || null;
  return out;
});
console.log(`  ${JSON.stringify(panes)}`);
const distinct = new Set(Object.values(panes).map((p) => p.pane).filter(Boolean));
ok('no two groups share a pane', distinct.size >= 7, JSON.stringify([...distinct]));
ok('the global strikes are not drawn straight into the shared container',
   panes.lightning.pane !== 'overlayPane', panes.lightning.pane);

/* ---- and restacking moves only that pane ---- */
console.log('\n=== restacking ===');
const moved = await page.evaluate(async () => {
  const map = window.RadarLoop.map();
  const zOf = (g) => map.getPane(window.__paneFor(g))?.style.zIndex;
  const before = { lightning: zOf('lightning'), radar: zOf('radar'), overlay: map.getPane('overlayPane').style.zIndex };
  window.RadarLoop.moveLayer('lightning', 1);
  await new Promise((r) => setTimeout(r, 700));
  const after = { lightning: zOf('lightning'), radar: zOf('radar'), overlay: map.getPane('overlayPane').style.zIndex };
  return { before, after, order: window.RadarLoop.layerOrder() };
});
console.log(`  before ${JSON.stringify(moved.before)}`);
console.log(`  after  ${JSON.stringify(moved.after)}`);
ok('moving the global strikes changes their own pane',
   moved.before.lightning !== moved.after.lightning,
   `${moved.before.lightning} -> ${moved.after.lightning}`);
// The old behaviour: restacking set a z-index on Leaflet's own container.
ok('and does not restack the whole weather container',
   moved.before.overlay === moved.after.overlay,
   `${moved.before.overlay} -> ${moved.after.overlay}`);

/* ---- dots, not crosses ---- */
console.log('\n=== mark ===');
const mark = await page.evaluate(() => {
  const layer = window.RadarLoop.slots.get('lightning').front;
  return { mark: layer.options.mark, drawn: layer.drawnCount() };
});
console.log(`  ${JSON.stringify(mark)}`);
ok('the global strikes are drawn as dots', mark.mark === 'dot', String(mark.mark));
ok('and something was drawn to show it', mark.drawn > 0, String(mark.drawn));
await page.screenshot({ path: 'shots/lightning-dots.png' });

console.log('\n=== popups are not buried ===');
const popups = await page.evaluate(() => {
  const map = window.RadarLoop.map();
  const z = (name) => Number(map.getPane(name)?.style.zIndex || getComputedStyle(map.getPane(name)).zIndex || 0);
  return {
    strikes: z('lightningPane'),
    nowcastOutline: z('nowcastOutlinePane'),
    popup: z('popupPane'),
    tooltip: z('tooltipPane'),
    nowcastOnAtBoot: window.RadarLoop.lightning.nowcast,
  };
});
console.log(`  ${JSON.stringify(popups)}`);
// The strike canvas was at 1000, above Leaflet's own popup pane at 700, so any
// popup opened under it was covered — the nowcast's included.
ok('popups draw above the strike canvas', popups.popup > popups.strikes,
   `popup ${popups.popup} vs strikes ${popups.strikes}`);
ok('and above the projection outline', popups.popup > popups.nowcastOutline,
   `popup ${popups.popup} vs outline ${popups.nowcastOutline}`);
ok('the outline still sits above the strikes', popups.nowcastOutline > popups.strikes,
   `${popups.nowcastOutline} vs ${popups.strikes}`);
ok('storm projections are on from the start', popups.nowcastOnAtBoot === true,
   String(popups.nowcastOnAtBoot));


console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
