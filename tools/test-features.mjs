/**
 * Covers this round of work:
 *   - brand assets (logos) and the thunder audio actually load
 *   - progressive strike reveal while dragging inside a focused window
 *   - 3D mode enters, mirrors weather + strikes, and exits cleanly
 *   - the phone layout reflows rather than just shrinking
 */

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/* ================================================================== *
 * Desktop
 * ================================================================== */
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(22000); // let archives land

/* ---- assets ---- */
console.log('\n=== brand assets ===');
const assets = await page.evaluate(async () => {
  const logo = document.querySelector('.brand__logo');
  const audioSrc = 'https://handry-outlook.github.io/Lightning-Strike-Visualiser-/mouse-click-117076-%5BAudioTrimmer.com%5D.mp3';
  const audioOk = await new Promise((resolve) => {
    const a = new Audio(audioSrc);
    a.addEventListener('canplaythrough', () => resolve(true), { once: true });
    a.addEventListener('error', () => resolve(false), { once: true });
    setTimeout(() => resolve(a.readyState > 0), 6000);
  });
  return {
    logoSrc: logo?.src ?? null,
    logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
    logoHidden: logo?.hidden ?? true,
    audioOk,
  };
});
ok('RadarLoop logo element present', !!assets.logoSrc, assets.logoSrc);
ok('RadarLoop logo decoded', assets.logoLoaded && !assets.logoHidden);
ok('thunder audio is loadable', assets.audioOk);

// Handry icon appears once the outlook panel is built.
await page.click('.rail__btn[data-group="outlook"]');
await page.waitForTimeout(6000);
const handry = await page.evaluate(() => {
  const img = document.querySelector('.panel-brand__icon');
  return { present: !!img, loaded: !!img && img.complete && img.naturalWidth > 0, src: img?.src };
});
ok('Handry Outlook icon shown on the outlook panel', handry.present, handry.src);
ok('Handry Outlook icon decoded', handry.loaded);

/* ---- progressive reveal ---- */
console.log('\n=== progressive strike reveal ===');
const reveal = await page.evaluate(async () => {
  // Focus a day the archives cover heavily.
  window.RadarLoop.focusWindow(new Date('2026-08-27T00:00:00Z'), new Date('2026-08-28T00:00:00Z'));
  await new Promise((r) => setTimeout(r, 6000));

  const slider = document.querySelector('.timeline__scrub .range');
  const readAt = async (fraction) => {
    slider.value = String(Math.round(Number(slider.max) * fraction));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1400));
    return window.RadarLoop.lightningFiltered().length;
  };

  const atEnd = window.RadarLoop.lightningFiltered().length;
  const at75 = await readAt(0.75);
  const at50 = await readAt(0.5);
  const at25 = await readAt(0.25);
  const at0 = await readAt(0);
  const back = await readAt(1);
  return { atEnd, at75, at50, at25, at0, back };
});

console.log(`  counts: end=${reveal.atEnd} 75%=${reveal.at75} 50%=${reveal.at50} 25%=${reveal.at25} 0%=${reveal.at0} back=${reveal.back}`);
ok('the whole period is shown when parked at the end', reveal.atEnd > 0);
ok('dragging back reveals progressively fewer strikes',
   reveal.at75 < reveal.atEnd && reveal.at50 < reveal.at75 && reveal.at25 < reveal.at50,
   `${reveal.atEnd} -> ${reveal.at75} -> ${reveal.at50} -> ${reveal.at25}`);
ok('the window start shows (almost) none', reveal.at0 < reveal.at25);
ok('returning to the end restores the full set', reveal.back === reveal.atEnd,
   `${reveal.back} vs ${reveal.atEnd}`);

/* ---- 3D ---- */
console.log('\n=== 3D mode ===');
await page.evaluate(() => document.querySelector('.chip--focus')?.click());
await page.waitForTimeout(2000);

await page.click('#btn-3d');
await page.waitForTimeout(9000);

const three = await page.evaluate(() => {
  const gl = window.RadarLoop.gl?.();
  const style = gl?.getStyle?.();
  return {
    is3D: window.RadarLoop.runtime.is3D,
    mode: document.getElementById('app')?.dataset.mode,
    canvasVisible: !!document.querySelector('#map-3d canvas'),
    pressed: document.getElementById('btn-3d')?.getAttribute('aria-pressed'),
    hasTerrain: !!gl?.getSource?.('mapbox-dem'),
    hasBuildings: !!gl?.getLayer?.('3d-buildings'),
    wxLayers: (style?.layers || []).filter((l) => l.id.startsWith('wx-')).map((l) => l.id),
    pitch: gl?.getPitch?.(),
  };
});
console.log(`  ${JSON.stringify(three)}`);
ok('3D mode is active', three.is3D === true && three.mode === '3d');
ok('a GL canvas is rendering', three.canvasVisible);
ok('the toggle reports pressed', three.pressed === 'true');
ok('terrain source added', three.hasTerrain);
ok('building extrusions added', three.hasBuildings);
ok('the camera is pitched', (three.pitch ?? 0) > 30, `pitch=${three.pitch}`);
ok('weather and strikes mirrored into 3D', three.wxLayers.length > 0,
   `layers=${JSON.stringify(three.wxLayers)}`);

try { await page.screenshot({ path: 'shots/mode-3d.png' }); } catch {}

await page.click('#btn-3d');
await page.waitForTimeout(3000);
const back2d = await page.evaluate(() => ({
  is3D: window.RadarLoop.runtime.is3D,
  mode: document.getElementById('app')?.dataset.mode,
  glGone: !window.RadarLoop.gl?.(),
  leafletTiles: document.querySelectorAll('#map .leaflet-pane img, #map .leaflet-pane canvas').length,
}));
ok('returns to 2D', back2d.is3D === false && back2d.mode === '2d');
ok('the GL context is released', back2d.glGone);
ok('the 2D map is still populated', back2d.leafletTiles > 0, `tiles=${back2d.leafletTiles}`);

console.log('\n=== desktop page errors ===');
const deskErrors = [...new Set(errors)];
if (deskErrors.length) deskErrors.forEach((e) => console.log(`  ${e}`));
else console.log('  none');
await page.close();

/* ================================================================== *
 * Phone
 * ================================================================== */
console.log('\n=== phone layout (iPhone 13) ===');
const phone = await browser.newPage({ ...devices['iPhone 13'] });
const phoneErrors = [];
phone.on('pageerror', (e) => phoneErrors.push(e.message));

await phone.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await phone.waitForTimeout(12000);

const layout = await phone.evaluate(() => {
  const r = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const rail = document.querySelector('.rail');
  const style = rail ? getComputedStyle(rail) : null;
  const btn = document.querySelector('.rail__btn');
  return {
    vw: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    railDirection: style?.flexDirection,
    rail: r('.rail'),
    railBtn: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
    timeline: r('.timeline'),
    panelToggleShown: getComputedStyle(document.getElementById('btn-panel')).display !== 'none',
    searchHidden: getComputedStyle(document.querySelector('.search')).display === 'none',
  };
});
console.log(`  ${JSON.stringify(layout)}`);

ok('no horizontal page scroll', layout.docScrollW <= layout.vw + 1,
   `scrollWidth=${layout.docScrollW} vw=${layout.vw}`);
ok('rail becomes a horizontal strip', layout.railDirection === 'row', layout.railDirection);
ok('rail spans the width', layout.rail && layout.rail.w >= layout.vw - 2,
   JSON.stringify(layout.rail));
ok('rail buttons meet touch-target size', layout.railBtn >= 40, `${layout.railBtn}px`);
ok('timeline is docked full width', layout.timeline && layout.timeline.w >= layout.vw - 2);
ok('panel toggle is exposed', layout.panelToggleShown);
ok('layer search is hidden on phone', layout.searchHidden);

// Panel opens as a bottom sheet.
await phone.click('.rail__btn[data-group="lightning"]');
await phone.waitForTimeout(1500);
const sheet = await phone.evaluate(() => {
  const p = document.querySelector('.panel');
  const b = p.getBoundingClientRect();
  return {
    hidden: p.hidden,
    bottom: Math.round(window.innerHeight - b.bottom),
    width: Math.round(b.width),
    vw: window.innerWidth,
    top: Math.round(b.y),
    vh: window.innerHeight,
    // Height of the docked chrome the sheet has to clear.
    chrome: Math.round(
      (document.getElementById('rail')?.getBoundingClientRect().height || 0)
      + (document.getElementById('timeline')?.getBoundingClientRect().height || 0),
    ),
  };
});
console.log(`  sheet: ${JSON.stringify(sheet)}`);
ok('panel opens', !sheet.hidden);
// The sheet is full width and docks on top of the rail rather than flush to the
// bottom of the screen: it used to be pinned to `bottom: 0` and layered by
// z-index, which put it underneath the rail and the timeline.
ok('panel is a full-width sheet docked above the rail',
   sheet.width >= sheet.vw - 2 && sheet.bottom > 2 && sheet.top > 0 && sheet.top < sheet.vh * 0.75,
   JSON.stringify(sheet));
ok('panel sits directly on the rail, with no gap and no overlap',
   Math.abs(sheet.bottom - sheet.chrome) <= 2,
   `panel bottom offset ${sheet.bottom}, rail+timeline ${sheet.chrome}`);

try { await phone.screenshot({ path: 'shots/phone-panel.png' }); } catch {}
await phone.click('.rail__btn[data-group="lightning"]');
await phone.waitForTimeout(1200);
try { await phone.screenshot({ path: 'shots/phone-map.png' }); } catch {}

console.log('\n=== phone page errors ===');
const pErrors = [...new Set(phoneErrors)];
if (pErrors.length) pErrors.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

await browser.close();

const totalErrors = deskErrors.length + pErrors.length;
console.log(`\n${fail === 0 && totalErrors === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${totalErrors} page errors`}`);
process.exit(fail === 0 && totalErrors === 0 ? 0 : 1);
