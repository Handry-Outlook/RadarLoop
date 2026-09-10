/**
 * This round's reports, as checks.
 *
 *   1. MapsGL products respond to the opacity slider.
 *   2. MapsGL products are not pinned below every other layer, and the
 *      layer-order tab moves them.
 *   3. The strike cue fires when a new strike actually arrives.
 *   4. Resizing in 3D leaves the mirrored MapsGL surface where it belongs.
 *   5. Switching a layer off from the layer-order tab clears its own card's
 *      toggle.
 *   6. Base map credits are still shown; weather-source names are not.
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
await page.waitForTimeout(14000);
await page.mouse.click(700, 430); // unlocks audio the way a real gesture does

/* ================================================================== *
 * Attribution: map credits stay, weather sources go
 * ================================================================== */
console.log('\n=== attribution ===');
const credits = await page.evaluate(() => {
  const text = document.querySelector('.leaflet-control-attribution')?.textContent || '';
  const { LAYER_CATALOG } = window.__layers;
  const labels = Object.values(LAYER_CATALOG)
    .flatMap((defs) => Object.values(defs).filter((d) => d && d.listed).map((d) => d.label || ''));
  const weatherNames = /\b(Windy|Xweather|X Weather|Met Office|MeteoSat|Foreca|Aeris|MapsGL|EUMETSAT|EUMETNET|NOAA|GOES|JMA|NASA|OPERA|DTN)\b/;
  return {
    attribution: text.trim(),
    offendingLabels: labels.filter((l) => weatherNames.test(l)),
    anyCatalogAttribution: Object.values(LAYER_CATALOG)
      .some((defs) => Object.values(defs).some((d) => d && d.attribution)),
  };
});
console.log(`  attribution control: "${credits.attribution}"`);
ok('base map credits are shown', /Mapbox|OpenStreetMap|MapTiler|Esri|OpenTopoMap/i.test(credits.attribution),
   credits.attribution);
ok('no product label names a weather source',
   credits.offendingLabels.length === 0, JSON.stringify(credits.offendingLabels));
ok('no weather product carries an attribution string', !credits.anyCatalogAttribution);

/* ================================================================== *
 * The strike cue
 * ================================================================== */
console.log('\n=== strike cue ===');
const cue = await page.evaluate(async () => {
  window.RadarLoop.lightning.sound = true;
  const before = window.RadarLoop.soundPool().map((a) => a.currentTime);
  const countBefore = window.RadarLoop.lightningFiltered().length;

  // Exactly what the live poll delivers: one strike, timestamped now.
  window.RadarLoop.lightning.all.push({ ms: Date.now(), lat: 51.5, lon: -0.12 });
  window.RadarLoop.refreshLightning({ force: true, fromData: true });
  await new Promise((r) => setTimeout(r, 2200));

  const after = window.RadarLoop.soundPool().map((a) => a.currentTime);
  return {
    countBefore,
    countAfter: window.RadarLoop.lightningFiltered().length,
    played: after.some((t, i) => t !== (before[i] ?? 0)),
    gates: {
      sound: window.RadarLoop.lightning.sound,
      showLayer: window.RadarLoop.lightning.showLayer,
      atLive: window.RadarLoop.time.atLive,
      playing: window.RadarLoop.time.playing,
      unlocked: window.RadarLoop.soundUnlocked(),
      poolSize: before.length,
    },
    decision: window.RadarLoop.strikeCueState(),
    pool: window.RadarLoop.soundPool(),
  };
});
console.log(`  filtered ${cue.countBefore} -> ${cue.countAfter}, cue played: ${cue.played}`);
console.log(`  gates: ${JSON.stringify(cue.gates)}`);
console.log(`  decision: ${JSON.stringify(cue.decision)}`);
console.log(`  pool: ${JSON.stringify(cue.pool)}`);
ok('a strike arriving now is inside the live window',
   cue.countAfter > cue.countBefore, `${cue.countBefore} -> ${cue.countAfter}`);
// The assertion is on the decision, not on audible output: headed Chromium
// enforces an autoplay policy that headless does not, so whether the element
// actually reaches the speakers is a property of the harness. `played` here is
// playStrikeSound() reporting that it started the clip.
ok('the cue fires for it', cue.decision?.fresh > 0 && cue.decision?.played === true,
   JSON.stringify(cue.decision));

/* ================================================================== *
 * MapsGL opacity and stacking
 * ================================================================== */
console.log('\n=== MapsGL presentation ===');
await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-all-tile'));
await page.waitForTimeout(11000);

const surface = () => page.evaluate(() => {
  const c = [...(document.querySelector('.leaflet-overlay-pane')?.children || [])]
    .find((n) => n.tagName === 'CANVAS');
  const s = c ? getComputedStyle(c) : null;
  const paneZ = (name) => {
    const p = window.RadarLoop.map().getPane(name);
    return p ? Number(getComputedStyle(p).zIndex) : null;
  };
  return {
    present: !!c,
    opacity: s ? Number(s.opacity) : null,
    zIndex: s ? Number(s.zIndex) : null,
    radarPaneZ: paneZ('radarPane'),
    satellitePaneZ: paneZ('satellitePane'),
  };
});

const initial = await surface();
console.log(`  surface: ${JSON.stringify(initial)}`);
ok('the MapsGL surface exists', initial.present);
ok('it is not pinned below the weather panes',
   initial.zIndex >= Math.min(initial.satellitePaneZ, initial.radarPaneZ),
   `canvas z=${initial.zIndex}, panes ${initial.satellitePaneZ}/${initial.radarPaneZ}`);

await page.evaluate(() => window.RadarLoop.setLayerOpacity('lightning', 0.25));
await page.waitForTimeout(1200);
const dimmed = await surface();
console.log(`  after opacity 0.25: ${JSON.stringify(dimmed)}`);
ok('the opacity slider reaches it', Math.abs(dimmed.opacity - 0.25) < 0.02, String(dimmed.opacity));

// Moving it in the layer-order tab must restack the surface.
const moved = await page.evaluate(async () => {
  const before = Number(getComputedStyle([...document.querySelector('.leaflet-overlay-pane').children]
    .find((n) => n.tagName === 'CANVAS')).zIndex);
  window.RadarLoop.setLayerEnabled('radar', true);
  await new Promise((r) => setTimeout(r, 1500));
  const orderBefore = window.RadarLoop.layerOrder();
  const up = window.RadarLoop.moveLayer('lightning', -1);
  const down = up ? null : window.RadarLoop.moveLayer('lightning', 1);
  await new Promise((r) => setTimeout(r, 1200));
  const after = Number(getComputedStyle([...document.querySelector('.leaflet-overlay-pane').children]
    .find((n) => n.tagName === 'CANVAS')).zIndex);
  return {
    before, after, orderBefore, orderAfter: window.RadarLoop.layerOrder(), up, down,
    slotZ: window.RadarLoop.slots.get('lightning').zIndex,
    radarZ: window.RadarLoop.slots.get('radar').zIndex,
  };
});
console.log(`  order ${JSON.stringify(moved.orderBefore)} -> ${JSON.stringify(moved.orderAfter)} (up=${moved.up} down=${moved.down})`);
console.log(`  z-index across a reorder: ${moved.before} -> ${moved.after} (lightning slot z=${moved.slotZ}, radar slot z=${moved.radarZ})`);
// The invariant is that the surface sits where the layer order says, not merely
// that the number changed — comparing before and after can pass or fail on which
// starting position the run happened to have.
ok('the MapsGL surface sits where the layer order puts it',
   moved.after === moved.slotZ, `canvas ${moved.after} vs slot ${moved.slotZ}`);
ok('moving it below another layer really puts it below',
   moved.slotZ < moved.radarZ, `lightning ${moved.slotZ} vs radar ${moved.radarZ}`);

/* ================================================================== *
 * The card toggle follows the layer-order tab
 * ================================================================== */
console.log('\n=== switching a layer off from the order tab ===');
const toggles = await page.evaluate(async () => {
  // Make sure the card exists by opening the group that owns radar.
  const railBtn = document.querySelector('.rail__btn[data-group="precip"]');
  if (document.getElementById('panel')?.hidden) railBtn?.click();
  await new Promise((r) => setTimeout(r, 900));

  const cardToggle = () => document.getElementById('toggle-radar')?.checked ?? null;

  const before = cardToggle();
  // What the ✕ on a layer-order row does.
  window.RadarLoop.setLayerEnabled('radar', false);
  await new Promise((r) => setTimeout(r, 700));
  return { before, after: cardToggle(), enabled: window.RadarLoop.slots.get('radar').enabled };
});
console.log(`  card toggle ${toggles.before} -> ${toggles.after} (slot enabled=${toggles.enabled})`);
ok('the layer really went off', toggles.enabled === false);
ok('its own card no longer shows the switch on', toggles.after === false,
   `toggle=${toggles.after}`);

/* ================================================================== *
 * Resizing in 3D
 * ================================================================== */
console.log('\n=== resize in 3D ===');
await page.evaluate(() => window.RadarLoop.selectProduct('lightning', 'lightning-all-tile'));
await page.waitForTimeout(8000);
await page.click('#btn-3d');
await page.waitForTimeout(12000);

const geometry = () => page.evaluate(() => {
  const c = window.RadarLoop.mirrorStats().lastCapture;
  const m = window.RadarLoop.map();
  const size = m.getSize();
  return c ? {
    w: c.width, h: c.height,
    containerW: size.x, containerH: size.y,
    span: Math.abs(c.bounds.east - c.bounds.west),
    centreLng: (c.bounds.east + c.bounds.west) / 2,
    glCentreLng: window.RadarLoop.gl().getCenter().lng,
    glSpan: Math.abs(window.RadarLoop.gl().getBounds().getEast() - window.RadarLoop.gl().getBounds().getWest()),
  } : null;
});

const beforeResize = await geometry();
await page.setViewportSize({ width: 1000, height: 700 });
await page.waitForTimeout(9000);
const afterResize = await geometry();

console.log(`  before: ${JSON.stringify(beforeResize)}`);
console.log(`  after:  ${JSON.stringify(afterResize)}`);
ok('the 2D container picked up the new size',
   afterResize && afterResize.containerW < beforeResize.containerW,
   `${beforeResize?.containerW} -> ${afterResize?.containerW}`);
ok('the capture was retaken at the new size',
   afterResize && afterResize.w !== beforeResize.w, `${beforeResize?.w} -> ${afterResize?.w}`);
// Coverage, not exactness: a pitched camera sees past what the 2D view can
// cover at the same scale, and the capture deliberately gives up to three zoom
// levels chasing it (see MAX_DETAIL_LOSS). What must not happen is the still
// drifting away from the camera, which is what the resize bug looked like.
ok('the still still covers most of what the camera sees',
   afterResize && afterResize.span >= afterResize.glSpan * 0.8,
   `capture ${afterResize?.span.toFixed(1)}° vs camera ${afterResize?.glSpan.toFixed(1)}°`);
ok('the still is still centred on the camera',
   afterResize && Math.abs(afterResize.centreLng - afterResize.glCentreLng) < afterResize.glSpan * 0.1,
   `capture centre ${afterResize?.centreLng.toFixed(2)} vs camera ${afterResize?.glCentreLng.toFixed(2)}`);

await page.click('#btn-3d');
await page.waitForTimeout(1500);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
