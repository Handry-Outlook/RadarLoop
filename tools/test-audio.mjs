/**
 * The strike cue, which the user reported as "not playing occasionally".
 *
 * Chromium is launched with autoplay restrictions left at their default so the
 * gesture-unlock path is genuinely exercised: without it, `play()` rejects and
 * the cue is silent, which is exactly the intermittent failure being tested.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({
  args: ['--autoplay-policy=document-user-activation-required'],
});
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

console.log('\n=== before any gesture ===');
ok('audio starts locked', (await page.evaluate(() => window.RadarLoop.soundUnlocked())) === false);

console.log('\n=== after a user gesture ===');
await page.mouse.click(700, 450);
await page.waitForTimeout(1500);
ok('a gesture unlocks the pool', (await page.evaluate(() => window.RadarLoop.soundUnlocked())) === true);

// Play repeatedly and confirm every attempt actually starts audio.
const result = await page.evaluate(async () => {
  const attempts = [];
  for (let i = 0; i < 6; i += 1) {
    attempts.push(window.RadarLoop.playSound());
    // Longer than the 50 ms cooldown so each attempt is allowed through.
    await new Promise((r) => setTimeout(r, 140));
  }
  // The pool elements are detached from the document, so they are read through
  // the module's own diagnostics rather than the DOM.
  const pool = window.RadarLoop.soundPool();
  return {
    attempts,
    pool,
    poolSize: pool.length,
    played: pool.filter((a) => !a.paused || a.currentTime > 0).length,
    readyStates: pool.map((a) => a.readyState),
    errored: pool.filter((a) => a.error !== null).length,
  };
});

console.log(`  attempts: ${JSON.stringify(result.attempts)}`);
console.log(`  pool=${result.poolSize} playedOrPlaying=${result.played} readyStates=${JSON.stringify(result.readyStates)}`);

ok('every play attempt was accepted', result.attempts.every(Boolean));
ok('a pool of elements exists (overlapping strikes)', result.poolSize >= 4, `pool=${result.poolSize}`);
ok('no element reported a media error', result.errored === 0, `errored=${result.errored}`);
ok('the audio decoded (readyState >= 2)', result.readyStates.every((s) => s >= 2),
   JSON.stringify(result.readyStates));
ok('at least one element actually played', result.played > 0,
   JSON.stringify(result.pool));

console.log('\n=== rate limiting ===');
const burst = await page.evaluate(() => {
  const out = [];
  for (let i = 0; i < 5; i += 1) out.push(window.RadarLoop.playSound());
  return out;
});
console.log(`  burst: ${JSON.stringify(burst)}`);
ok('a tight burst is rate-limited', burst.filter(Boolean).length === 1,
   `accepted=${burst.filter(Boolean).length}`);

console.log('\n=== page errors ===');
const real = [...new Set(errors)];
if (real.length) real.forEach((e) => console.log(`  ${e}`));
else console.log('  none');

console.log(`\n${fail === 0 && real.length === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} failed, ${real.length} page errors`}`);
await browser.close();
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
