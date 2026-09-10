/**
 * The reported 3D gaps, as checks.
 *
 *   1. MapsGL products (Lightning All, the hail fields) reach 3D at all.
 *   2. The in-house nowcast and the HOCO outlook polygons reach 3D.
 *   3. Strikes stay above the weather, whatever is enabled after them.
 *   4. DTN isobars and surface fronts use the same tile addressing in 3D as in
 *      2D — they were flipped vertically in 3D only.
 *   5. Light mode opens 3D on a light style, and an explicit base map choice
 *      carries into 3D.
 *   6. On a phone the panel sheet does not sit under the rail or the timeline.
 */

import { chromium } from 'playwright';

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
await page.waitForTimeout(9000);

/* ================================================================== *
 * Tile addressing parity — checked before entering 3D
 * ================================================================== */
console.log('\n=== DTN isobars and fronts: same addressing in both views ===');

const schemes = await page.evaluate(() => {
  const { tileScheme } = window.__mirror3d;
  const dtn = 'https://tiles.meteoguard.dtn.com/tiles/x/{z}/{x}/{y}.png';
  return {
    isobar: tileScheme('isobar', dtn),
    front: tileScheme('surfaceFront', dtn),
    satellite: tileScheme('satellite', dtn),
    aeris: tileScheme('radar', 'https://maps.aerisapi.com/k/radar/{z}/{x}/{y}.webp'),
  };
});
console.log(`  isobar=${schemes.isobar} front=${schemes.front} satellite=${schemes.satellite} aeris=${schemes.aeris}`);
ok('DTN isobars are not flipped', schemes.isobar === 'xyz', schemes.isobar);
ok('DTN surface fronts are not flipped', schemes.front === 'xyz', schemes.front);
// The one product that genuinely is flipped must stay flipped.
ok('DTN satellite is still flipped', schemes.satellite === 'tms', schemes.satellite);

/* ================================================================== *
 * Base map and theme
 * ================================================================== */
console.log('\n=== 3D base map ===');

const themeNow = await page.evaluate(() => window.RadarLoop.runtime.theme);
if (themeNow !== 'light') await page.click('#btn-theme');
await page.waitForTimeout(700);

await page.click('#btn-3d');
await page.waitForTimeout(12000);

const lightStyle = await page.evaluate(() => window.RadarLoop.gl()?.getStyle()?.name);
console.log(`  light mode opens: ${lightStyle}`);
ok('light mode gets a light 3D map', /light/i.test(String(lightStyle)), String(lightStyle));

// An explicit base map choice should carry into 3D, which it never used to.
await page.evaluate(() => window.RadarLoop.setBasemap('mapbox-satellite'));
await page.waitForTimeout(9000);
const pickedStyle = await page.evaluate(() => window.RadarLoop.gl()?.getStyle()?.name);
console.log(`  after choosing Satellite: ${pickedStyle}`);
ok('an explicit base map choice reaches 3D', /satellite/i.test(String(pickedStyle)), String(pickedStyle));

await page.evaluate(() => window.RadarLoop.setBasemap('mapbox-light'));
await page.waitForTimeout(8000);

/* ================================================================== *
 * MapsGL in 3D
 * ================================================================== */
console.log('\n=== products drawn by their own engine ===');

await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-all-tile'));
await page.waitForTimeout(9000);
let kind = await page.evaluate(() => window.RadarLoop.mirrorKind('lightning'));
console.log(`  Lightning All (MapsGL) -> ${kind}`);
ok('a MapsGL product is mirrored into 3D', !!kind, String(kind));

/* ================================================================== *
 * Strikes stay on top
 * ================================================================== */
console.log('\n=== stacking ===');

await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(10000);

const stack = await page.evaluate(() => {
  const ids = window.RadarLoop.gl().getStyle().layers.map((l) => l.id);
  return {
    ids: ids.filter((id) => id.startsWith('wx-')),
    strikes: ids.indexOf('wx-strikes-layer'),
    radar: ids.indexOf('wx-radar'),
    total: ids.length,
  };
});
console.log(`  wx layers, bottom to top: ${JSON.stringify(stack.ids)}`);
ok('the radar reached 3D', stack.radar >= 0, `index ${stack.radar}`);
ok('strikes are drawn above the radar, not buried by it',
   stack.strikes > stack.radar, `strikes=${stack.strikes} radar=${stack.radar}`);

/* ================================================================== *
 * Overlays that are not layer slots
 * ================================================================== */
console.log('\n=== nowcast and outlook polygons ===');

const overlays = await page.evaluate(async () => {
  // A real Leaflet polygon in the outlook pane, drawn through the same canvas
  // renderer the outlooks use. Live outlook data is not always reachable from
  // localhost, and the thing under test is the mirror, not the feed.
  const map = window.RadarLoop.map();
  const c = map.getCenter();
  const probe = L.polygon([
    [c.lat - 3, c.lng - 5], [c.lat + 3, c.lng - 5], [c.lat + 3, c.lng + 5], [c.lat - 3, c.lng + 5],
  ], { pane: 'hocoFillPane', renderer: L.canvas({ pane: 'hocoFillPane', padding: 0.35 }), color: '#ff0000', fillOpacity: 0.6 });
  const ids = () => window.RadarLoop.gl().getStyle().layers.map((l) => l.id);
  const settle = async (want) => {
    for (let i = 0; i < 40; i += 1) {
      window.RadarLoop.refreshOverlayMirror();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
      if (ids().includes('wx-ov-outlook-auto') === want) break;
    }
    return ids().filter((id) => id.startsWith('wx-ov-'));
  };

  probe.addTo(map);
  await new Promise((r) => setTimeout(r, 1200));

  const result = {
    painted: !!map.getPane('hocoFillPane')?.querySelector('canvas'),
    overlayLayers: await settle(true),
  };

  // And that removing it takes the mirror with it.
  map.removeLayer(probe);
  await new Promise((r) => setTimeout(r, 400));
  result.afterRemoval = await settle(false);
  return result;
});

console.log(`  2D outlook pane painted: ${overlays.painted}`);
console.log(`  3D overlay layers: ${JSON.stringify(overlays.overlayLayers)}`);
console.log(`  after removing it:  ${JSON.stringify(overlays.afterRemoval)}`);
ok('an outlook/nowcast pane is mirrored into 3D',
   overlays.painted && overlays.overlayLayers.includes('wx-ov-outlook-auto'),
   JSON.stringify(overlays));
// The outlook mirror specifically, not 'no overlay mirrors at all': the station
// models are on from the start and are correctly mirrored the whole time.
ok('the mirror is dropped when the 2D overlay goes',
   !overlays.afterRemoval.includes('wx-ov-outlook-auto'),
   JSON.stringify(overlays.afterRemoval));

await page.click('#btn-3d');
await page.waitForTimeout(1500);

/* ================================================================== *
 * Phone layout
 * ================================================================== */
console.log('\n=== phone: the panel must not sit under the rail or timeline ===');

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1800);
// The rail button toggles, and boot may already have opened this group.
if (await page.evaluate(() => document.getElementById('panel')?.hidden)) {
  await page.click('.rail__btn[data-group="precip"]');
}
await page.waitForTimeout(1400);

const boxes = await page.evaluate(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  return {
    panel: rect('#panel'),
    rail: rect('#rail'),
    timeline: rect('#timeline'),
    viewport: window.innerHeight,
    vars: {
      timelineDock: getComputedStyle(document.documentElement).getPropertyValue('--timeline-dock').trim(),
      railDock: getComputedStyle(document.documentElement).getPropertyValue('--rail-dock').trim(),
    },
  };
});

console.log(`  panel    ${JSON.stringify(boxes.panel)}`);
console.log(`  rail     ${JSON.stringify(boxes.rail)}`);
console.log(`  timeline ${JSON.stringify(boxes.timeline)}`);
console.log(`  measured ${JSON.stringify(boxes.vars)}`);

const overlap = (a, b) => a && b && a.bottom > b.top && b.bottom > a.top;
ok('the docked heights were measured', !!boxes.vars.timelineDock && !!boxes.vars.railDock,
   JSON.stringify(boxes.vars));
ok('the panel does not overlap the rail', !overlap(boxes.panel, boxes.rail),
   `panel ${JSON.stringify(boxes.panel)} rail ${JSON.stringify(boxes.rail)}`);
ok('the panel does not overlap the timeline', !overlap(boxes.panel, boxes.timeline),
   `panel ${JSON.stringify(boxes.panel)} timeline ${JSON.stringify(boxes.timeline)}`);
ok('the rail does not overlap the timeline', !overlap(boxes.rail, boxes.timeline),
   `rail ${JSON.stringify(boxes.rail)} timeline ${JSON.stringify(boxes.timeline)}`);
ok('the panel still has usable height', (boxes.panel?.height || 0) > 150,
   `${boxes.panel?.height}px`);
ok('nothing runs off the top of the screen', (boxes.panel?.top ?? 0) >= 0,
   `panel top ${boxes.panel?.top}`);

/* ================================================================== *
 * The lightning icon must be monochrome
 * ================================================================== */
console.log('\n=== rail icon presentation ===');
const bolt = await page.evaluate(() => {
  const btn = document.querySelector('.rail__btn[data-group="lightning"]');
  const svg = btn?.querySelector('svg.icon');
  return btn ? { drawn: !!svg, text: btn.textContent.trim(), stroke: svg?.getAttribute('stroke') } : null;
});
console.log(`  lightning button: ${JSON.stringify(bolt)}`);
// The bolt was U+26A1, the one glyph in this rail with an emoji presentation, so
// it rendered as a yellow bolt among monochrome neighbours. The whole rail is
// drawn now, which settles the question by construction rather than by asking
// the font for a text presentation.
ok('the lightning icon is drawn, not a text glyph', bolt?.drawn === true, JSON.stringify(bolt));
ok('it takes the button colour rather than carrying its own',
   bolt?.stroke === 'currentColor', String(bolt?.stroke));

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
