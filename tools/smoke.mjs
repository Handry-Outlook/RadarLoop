/**
 * Smoke test: loads the built single-file app in Chromium, waits for boot, and
 * reports console errors, page errors and failed requests.
 *
 * Network access to the weather providers may be unavailable in this
 * environment; provider request failures are reported separately from real
 * application errors so the two are never confused.
 */

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = process.argv[2] || 'radarloop/dist/radarloop.html';
const url = target.startsWith('http') ? target : pathToFileURL(resolve(target)).href;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = new Map();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => {
  const host = new URL(request.url()).host;
  failedRequests.set(host, (failedRequests.get(host) || 0) + 1);
});

console.log(`Loading ${url}\n`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);

/* ---- structural assertions ---- */

const checks = await page.evaluate(() => {
  const q = (sel) => document.querySelector(sel);
  return {
    mapCreated: !!q('#map .leaflet-pane'),
    railButtons: document.querySelectorAll('.rail__btn').length,
    timelineBuilt: !!q('.timeline__clock'),
    legendBuilt: !!q('#legend-body')?.children.length,
    searchBound: !!q('#layer-search'),
    panesCreated: document.querySelectorAll('#map .leaflet-pane').length,
    clockText: q('.timeline__clock')?.textContent ?? null,
    globalPresent: typeof window.RadarLoop === 'object',
    slotCount: window.RadarLoop ? window.RadarLoop.slots.size : 0,
    theme: document.documentElement.dataset.theme,
  };
});

console.log('=== STRUCTURE ===');
for (const [key, value] of Object.entries(checks)) {
  console.log(`  ${String(value).padEnd(10)} ${key}`);
}

/* ---- interaction ---- */

console.log('\n=== INTERACTION ===');
async function step(name, fn) {
  const before = pageErrors.length + consoleErrors.length;
  try {
    await fn();
    await page.waitForTimeout(700);
    const added = pageErrors.length + consoleErrors.length - before;
    console.log(`  ${added === 0 ? 'ok  ' : 'ERR '} ${name}${added ? ` (+${added} errors)` : ''}`);
  } catch (error) {
    console.log(`  FAIL ${name} -> ${error.message.split('\n')[0]}`);
  }
}

await step('open radar panel', () => page.click('.rail__btn[data-group="precip"]'));
await step('open lightning panel', () => page.click('.rail__btn[data-group="lightning"]'));
await step('open tools panel', () => page.click('.rail__btn[data-group="tools"]'));
await step('open settings panel', () => page.click('.rail__btn[data-group="settings"]'));
await step('open outlook panel', () => page.click('.rail__btn[data-group="outlook"]'));
await step('open basemap panel', () => page.click('.rail__btn[data-group="basemap"]'));
await step('search for "rain"', async () => {
  await page.fill('#layer-search', 'rain');
  await page.waitForTimeout(300);
});
await step('toggle theme', () => page.click('#btn-theme'));
await step('open help', () => page.click('#btn-help'));
await step('close help', () => page.keyboard.press('Escape'));
await step('scrub timeline', async () => {
  await page.click('.timeline__transport .btn:first-child');
});
await step('play/pause', async () => {
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
});

const searchResults = await page.evaluate(() =>
  document.querySelectorAll('#search-results .search__item').length);
console.log(`  search returned ${searchResults} results`);

try { await page.screenshot({ path: 'shots/smoke.png' }); } catch { /* screenshots are optional */ }

/* ---- report ---- */

const PROVIDER_HOSTS = /windy|aerisapi|meteoguard|mapbox|maptiler|arcgis|metoffice|eumetsat|foreca|accuweather|daneradarowe|googleapis|gstatic|firebase|nwstatic/;
const providerFailures = [...failedRequests].filter(([host]) => PROVIDER_HOSTS.test(host));
const otherFailures = [...failedRequests].filter(([host]) => !PROVIDER_HOSTS.test(host));

console.log('\n=== APPLICATION ERRORS ===');
if (!pageErrors.length && !consoleErrors.length) {
  console.log('  none');
} else {
  [...new Set(pageErrors)].forEach((e) => console.log(`  [pageerror] ${e}`));
  [...new Set(consoleErrors)].slice(0, 25).forEach((e) => console.log(`  [console] ${e.slice(0, 200)}`));
}

console.log('\n=== NETWORK (provider hosts, expected offline here) ===');
providerFailures.slice(0, 10).forEach(([host, n]) => console.log(`  ${String(n).padStart(4)} ${host}`));
if (otherFailures.length) {
  console.log('\n=== NETWORK (other) ===');
  otherFailures.forEach(([host, n]) => console.log(`  ${String(n).padStart(4)} ${host}`));
}

await browser.close();

const fatal = pageErrors.length > 0;
console.log(`\n${fatal ? 'FAILED — page errors present' : 'PASSED — no page errors'}`);
process.exit(fatal ? 1 : 0);
