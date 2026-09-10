/**
 * Why the strike cue does not fire.
 *
 * The low-level audio is covered by tools/test-audio.mjs and passes, so this
 * walks the trigger instead: every gate between "new strikes arrived" and
 * playStrikeSound() being called, reported individually.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (/audio|cue/i.test(m.text())) console.log(`  [console] ${m.text()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);

await page.mouse.click(660, 420);
await page.waitForTimeout(600);

console.log('\n=== gates before enabling the cue ===');
console.log(JSON.stringify(await page.evaluate(() => ({
  sound: window.RadarLoop.lightning.sound,
  showLayer: window.RadarLoop.lightning.showLayer,
  atLive: window.RadarLoop.time.atLive,
  playing: window.RadarLoop.time.playing,
  unlocked: window.RadarLoop.soundUnlocked(),
  filtered: window.RadarLoop.lightningFiltered().length,
})), null, 2));

console.log('\n=== cue on, then a data-driven refresh ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  window.RadarLoop.lightning.sound = true;
  const before = window.RadarLoop.soundPool().map((a) => a.currentTime);

  // What a live poll does.
  window.RadarLoop.refreshLightning({ force: true, fromData: true });
  await new Promise((r) => setTimeout(r, 2000));

  const after = window.RadarLoop.soundPool().map((a) => a.currentTime);
  return {
    poolBefore: before,
    poolAfter: after,
    played: after.some((t, i) => t !== (before[i] ?? 0)),
    atLive: window.RadarLoop.time.atLive,
  };
}), null, 2));

console.log('\n=== a genuinely new strike arrives ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const all = window.RadarLoop.lightning.all;
  const before = window.RadarLoop.soundPool().map((a) => a.currentTime);
  // The live feed appends in ascending time order; this is what one new strike
  // landing in the live window looks like.
  all.push({ ms: Date.now(), lat: 51.5, lon: -0.12 });
  window.RadarLoop.refreshLightning({ force: true, fromData: true });
  await new Promise((r) => setTimeout(r, 2000));
  const after = window.RadarLoop.soundPool().map((a) => a.currentTime);
  return {
    filtered: window.RadarLoop.lightningFiltered().length,
    played: after.some((t, i) => t !== (before[i] ?? 0)),
    before,
    after,
  };
}), null, 2));

console.log('\n=== calling the cue directly ===');
console.log(JSON.stringify(await page.evaluate(async () => {
  const before = window.RadarLoop.soundPool().map((a) => a.currentTime);
  const returned = window.RadarLoop.playSound();
  await new Promise((r) => setTimeout(r, 1200));
  return { returned, before, after: window.RadarLoop.soundPool().map((a) => a.currentTime) };
}), null, 2));

await browser.close();
