/**
 * Finds the code in Windy's client that reads the lightning frames.
 *
 * The archive format did not yield to analysis of the bytes, so the parser is
 * the next place to look. This drives their radar view — the one that draws
 * strikes — captures every script it loads, and searches those for the endpoint
 * and the code around it.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const blitz = [];
const bodies = new Map();
page.on('request', (r) => {
  if (/blitz/i.test(r.url())) blitz.push(`${r.method()} ${r.url()}`);
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/\.js(\?|$)/.test(u)) return;
  try {
    const text = await r.text();
    if (/blitz|5mins|lightning/i.test(text)) bodies.set(u, text);
  } catch { /* streamed or binary */ }
});

await page.goto('https://www.windy.com/-Weather-radar-radar?radar,51.5,0.0,5', {
  waitUntil: 'domcontentloaded', timeout: 90000,
});
await page.waitForTimeout(20000);
for (const label of ['Agree', 'Accept', 'I agree', 'Got it']) {
  const b = page.getByRole('button', { name: label }).first();
  if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(15000);

console.log(`blitz requests: ${blitz.length}`);
for (const u of blitz.slice(0, 12)) console.log(`   ${u}`);
console.log(`\nscripts mentioning blitz/5mins/lightning: ${bodies.size}`);
let n = 0;
for (const [u, text] of bodies) {
  const hits = [...text.matchAll(/blitz|5mins/gi)].length;
  console.log(`   ${hits} hits  ${u.split('/').pop().slice(0, 60)}  (${(text.length / 1024).toFixed(0)} KB)`);
  writeFileSync(`${out}/script-${n}.js`, text);
  n += 1;
}
writeFileSync(`${out}/blitz-requests.txt`, blitz.join('\n'));
await page.screenshot({ path: `${out}/radar.png` });
await browser.close();
