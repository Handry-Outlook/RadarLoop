/** Traces the 3D windy capture pipeline across scrubber positions. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (/3d|mirror/i.test(t)) console.log(`  [c] ${t.slice(0,160)}`); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(process.argv[2] || 'http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
await page.evaluate(() => window.RadarLoop.selectProduct('radar', 'windy-radar'));
await page.waitForTimeout(6000);
await page.click('#btn-3d');
await page.waitForTimeout(12000);

const out = await page.evaluate(async () => {
  const rows = [];
  const slider = document.querySelector('.timeline__scrub .range');
  const snap = (tag) => {
    const s = window.RadarLoop.mirrorStats();
    const slot = window.RadarLoop.slots.get('radar');
    return { tag, ...s, frameKey: slot.frameKey, url: (slot.lastUrl || '').slice(-38) };
  };
  rows.push(snap('start'));
  for (const f of [0.92, 0.84, 0.76, 0.68]) {
    slider.value = String(Math.round(Number(slider.max) * f));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5500));
    rows.push(snap(`f=${f}`));
  }
  return rows;
});

console.log('\ntag    attempts captured noTiles noneDrawn tainted mirrored lastDrew lastBytes  frame/url');
for (const r of out) {
  console.log(`${r.tag.padEnd(7)}${String(r.attempts).padStart(8)}${String(r.captured).padStart(9)}${String(r.noTiles).padStart(8)}${String(r.noneDrawn).padStart(10)}${String(r.tainted).padStart(8)}${String(r.mirrored).padStart(9)}${String(r.lastDrew).padStart(9)}${String(r.lastBytes).padStart(10)}  ${r.url}`);
}
await browser.close();
