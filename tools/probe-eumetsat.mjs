/**
 * What the resolver and the tile layer actually do with the EUMETSAT WMS.
 *
 * The service answers 502 for a frame it has not published yet and 200 once it
 * has, so the interesting questions are which frame gets chosen, how many
 * requests that costs, and whether any tile is left permanently failed.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const calls = [];
page.on('response', (r) => {
  if (!/view\.eumetsat\.int/.test(r.url())) return;
  const time = /TIME=([^&]+)/.exec(r.url())?.[1] || '?';
  const retry = /_retry=(\d+)/.test(r.url()) ? ' (retry)' : '';
  const probe = /_probe=/.test(r.url()) ? ' (probe)' : '';
  calls.push({ status: r.status(), time: decodeURIComponent(time), kind: probe || retry || ' (tile)' });
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const t0 = Date.now();
await page.evaluate(() => window.RadarLoop.selectProduct('satellite', 'eumetsat-geocolor'));
await page.waitForTimeout(25000);

const slot = await page.evaluate(() => {
  const s = window.RadarLoop.slots.get('satellite');
  return {
    drew: !!s.front,
    lastUrl: (s.lastUrl || '').match(/TIME=([^&]+)/)?.[1] || null,
    stale: s.lastTimestamp ? ((Date.now() - s.lastTimestamp) / 60000).toFixed(0) + ' min' : null,
    tiles: document.querySelectorAll('#map .leaflet-pane img[src*="eumetsat"]').length,
    broken: [...document.querySelectorAll('#map img[src*="eumetsat"]')]
      .filter((i) => i.complete && i.naturalWidth === 0).length,
  };
});

console.log(`\nresolved after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('slot:', JSON.stringify(slot));

const byStatus = {};
for (const c of calls) byStatus[`${c.status}${c.kind}`] = (byStatus[`${c.status}${c.kind}`] || 0) + 1;
console.log('\nrequests by outcome:', JSON.stringify(byStatus, null, 2));

const frames = {};
for (const c of calls) (frames[c.time] ||= []).push(c.status);
console.log('\nper frame:');
for (const [time, list] of Object.entries(frames)) {
  const counts = {};
  for (const s of list) counts[s] = (counts[s] || 0) + 1;
  console.log(`  ${time}  ${JSON.stringify(counts)}`);
}
await browser.close();
