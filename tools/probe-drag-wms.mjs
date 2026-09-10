/** Exactly which EUMETSAT requests a scrubber drag causes. */
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const seen = [];
page.on('request', (r) => {
  if (!r.url().includes('view.eumetsat.int')) return;
  seen.push({
    time: /TIME=([^&]+)/.exec(r.url())?.[1] || '?',
    probe: /_probe=/.test(r.url()),
    retry: /_retry=/.test(r.url()),
  });
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor'));
await page.waitForTimeout(14000);

const before = seen.length;
await page.evaluate(async () => {
  const slider = document.querySelector('.timeline__scrub .range');
  const max = Number(slider.max);
  slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  for (let i = 1; i <= 14; i += 1) {
    slider.value = String(Math.round(max - i * 6));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 90));
  }
});
await page.waitForTimeout(1500);
const midState = await page.evaluate(() => ({
  scrubbing: window.RadarLoop.runtime.scrubbing,
  url: (window.RadarLoop.slots.get('satellite').lastUrl || '').match(/TIME=([^&]+)/)?.[1],
  frameKey: window.RadarLoop.slots.get('satellite').frameKey,
  time: new Date(window.RadarLoop.time.current).toISOString(),
}));
console.log('mid-drag state:', JSON.stringify(midState));

await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
await page.waitForTimeout(16000);
const afterState = await page.evaluate(() => ({
  scrubbing: window.RadarLoop.runtime.scrubbing,
  url: (window.RadarLoop.slots.get('satellite').lastUrl || '').match(/TIME=([^&]+)/)?.[1],
  frameKey: window.RadarLoop.slots.get('satellite').frameKey,
  time: new Date(window.RadarLoop.time.current).toISOString(),
}));
console.log('after release:  ', JSON.stringify(afterState));

const during = seen.slice(before);
console.log(`requests during the drag: ${during.length}`);
const kinds = { probe: 0, retry: 0, tile: 0 };
const times = new Set();
for (const r of during) {
  kinds[r.probe ? 'probe' : r.retry ? 'retry' : 'tile'] += 1;
  times.add(decodeURIComponent(r.time));
}
console.log('  kinds:', JSON.stringify(kinds));
console.log('  distinct frames:', [...times].join(', '));
console.log('  scrubbing flag:', await page.evaluate(() => window.RadarLoop.runtime.scrubbing));
await browser.close();
