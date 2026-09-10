/** Why the thunder cue does or does not fire, end to end. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(14000);

// A real gesture, so the autoplay policy lets audio start.
await page.mouse.click(650, 400);
await page.waitForTimeout(400);

console.log('sound setting:', await page.evaluate(() => ({
  soundOn: window.RadarLoop.strikeCueState().soundOn,
  unlocked: window.RadarLoop.soundUnlocked(),
  pool: window.RadarLoop.soundPool(),
  atLive: window.RadarLoop.time.atLive,
  playing: window.RadarLoop.time.playing,
  strikes: window.RadarLoop.lightningFiltered().length,
})));

// Turn the cue on through the real control, which lives in the lightning panel.
await page.click('.rail__btn[data-group="lightning"]');
await page.waitForTimeout(1200);
const toggled = await page.evaluate(() => {
  // The checkbox sits in a .switch span, a sibling of the label; .switch-row is
  // the wrapper that actually carries the text.
  const row = [...document.querySelectorAll('.switch-row')]
    .find((n) => /thunder/i.test(n.textContent || ''));
  const input = row?.querySelector('input[type="checkbox"]');
  if (!input) return null;
  if (!input.checked) input.click();
  return { label: row.textContent.trim().slice(0, 40), checked: input.checked };
});
console.log('sound toggle:', JSON.stringify(toggled));
await page.waitForTimeout(600);

// Now inject a brand-new strike the way the poll would, and watch the gate.
const result = await page.evaluate(async () => {
  const all = window.RadarLoop.lightningAll();
  const now = Date.now();
  all.push({ ms: now, lat: 52.5, lon: -1.9 });
  window.RadarLoop.refreshLightning({ force: true, fromData: true });
  await new Promise((r) => setTimeout(r, 1200));
  return window.RadarLoop.strikeCueState();
});
console.log('after injecting one strike:', JSON.stringify(result));
await browser.close();
