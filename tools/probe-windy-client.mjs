/**
 * What Windy's own client asks for when it shows lightning, and with what code.
 *
 * The archive frames are a binary format that has not yielded to analysis of the
 * bytes alone, so the next place to look is the client that reads them: which
 * endpoints it calls for past times, and which script carries the parser.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.argv[2] || 'windy-capture';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const blitz = [];
const scripts = new Set();
page.on('request', (r) => {
  const u = r.url();
  if (/blitz|lightning|thunder/i.test(u)) blitz.push({ method: r.method(), url: u });
  if (/\.js(\?|$)/.test(u) && /windy/.test(u)) scripts.add(u);
});

// The lightning overlay, at a point in the past.
await page.goto('https://www.windy.com/-Thunderstorms-thunder?thunder,51.5,0.0,5', {
  waitUntil: 'domcontentloaded', timeout: 90000,
});
await page.waitForTimeout(12000);

// Dismiss whatever consent dialog is in the way, if any.
for (const label of ['Agree', 'Accept', 'I agree', 'Got it', 'Continue']) {
  const b = page.getByRole('button', { name: label }).first();
  if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break; }
}
await page.waitForTimeout(6000);

console.log(`blitz-ish requests so far: ${blitz.length}`);
for (const r of blitz.slice(0, 10)) console.log(`   ${r.method} ${r.url}`);
console.log(`\nwindy scripts seen: ${scripts.size}`);
writeFileSync(`${out}/requests.json`, JSON.stringify({ blitz, scripts: [...scripts] }, null, 1));
await page.screenshot({ path: `${out}/windy.png` });
console.log(`written ${out}/requests.json`);
await browser.close();
