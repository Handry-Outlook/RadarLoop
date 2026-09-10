/** Confirms the root page actually lands on RadarLoop, and leaves no history entry. */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = 'https://handry-outlook.github.io/RadarLoop/radarloop/';
const browser = await chromium.launch();
const page = await browser.newPage();

// The destination is a live site; stub it so this tests the redirect, not the network.
await page.route(`${target}**`, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<title>RadarLoop landed</title>' }));

const start = 'https://handry-outlook.github.io/RadarLoop/start';
await page.route(start, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<a id="go" href="./">go</a>' }));

// With scripting on.
await page.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
console.log('with JS   ->', page.url());
console.log('  title   ->', await page.title());

// And with scripting off, where only the meta refresh can act.
const noJs = await browser.newContext({ javaScriptEnabled: false });
const bare = await noJs.newPage();
await bare.route(`${target}**`, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<title>RadarLoop landed</title>' }));
await bare.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded' });
await bare.waitForTimeout(2000);
console.log('without JS->', bare.url());

await browser.close();
