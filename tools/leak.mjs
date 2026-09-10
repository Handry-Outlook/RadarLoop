/**
 * Checks the double buffer retires old frames: after repeated scrubbing there
 * must be at most a small, bounded number of layer containers per pane, not one
 * per frame visited.
 */

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

const survey = () => page.evaluate(() => {
  const out = {};
  for (const pane of document.querySelectorAll('#map .leaflet-pane')) {
    const name = pane.className.replace('leaflet-pane leaflet-', '').trim();
    // A Leaflet grid layer creates one `.leaflet-layer` container per layer.
    const containers = pane.querySelectorAll(':scope > .leaflet-layer').length;
    const media = pane.querySelectorAll(':scope > * img, :scope > * canvas, :scope > canvas').length;
    if (containers || media) out[name] = { containers, media };
  }
  out.__slots = Object.fromEntries(
    [...window.RadarLoop.slots].map(([g, s]) => [g, { enabled: s.enabled, front: !!s.front, back: !!s.back }]),
  );
  out.__stats = { ...window.RadarLoop.runtime.stats };
  return out;
});

console.log('=== AFTER INITIAL RENDER ===');
const before = await survey();
for (const [k, v] of Object.entries(before)) {
  if (k.startsWith('__')) continue;
  console.log(`  ${k.padEnd(22)} containers=${v.containers}  media=${v.media}`);
}
console.log('  slots:', JSON.stringify(before.__slots));

// Step back through 14 distinct frames.
console.log('\n=== STEPPING BACK 14 FRAMES ===');
for (let i = 0; i < 14; i += 1) {
  await page.click('.timeline__transport .btn:first-child');
  await page.waitForTimeout(750);
}
await page.waitForTimeout(4000);

const after = await survey();
console.log('=== AFTER 14 FRAME STEPS ===');
let leaked = false;
for (const [k, v] of Object.entries(after)) {
  if (k.startsWith('__')) continue;
  const wasContainers = before[k]?.containers ?? 0;
  // Front + a transient back buffer is the expected ceiling.
  const suspicious = v.containers > Math.max(2, wasContainers + 1);
  if (suspicious) leaked = true;
  console.log(`  ${k.padEnd(22)} containers=${v.containers}  media=${v.media}${suspicious ? '   <-- LEAK' : ''}`);
}
console.log('  slots:', JSON.stringify(after.__slots));
console.log('  stats:', JSON.stringify(after.__stats));

console.log(`\n${leaked ? 'LEAK DETECTED — old frames are not being retired' : 'PASSED — layer containers bounded'}`);
await browser.close();
process.exit(leaked ? 1 : 0);
