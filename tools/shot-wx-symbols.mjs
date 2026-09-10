/**
 * A contact sheet of the present-weather symbols.
 *
 * Drawn straight onto a canvas through the layer's own code path, at plot size
 * and at four times it, because these are eight-pixel glyphs and the question is
 * whether each is still itself at that size.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 460 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);

await page.evaluate(() => {
  const reports = [
    'light rain', 'rain', 'heavy rain', 'light drizzle', 'drizzle',
    'light rain shower', 'heavy rain shower', 'light snow', 'snow', 'heavy snow',
    'snow shower', 'hail', 'ice pellets', 'heavy frz rain', 'freezing drizzle',
    'thunderstorm', 'fog', 'mist', 'haze', 'clear',
  ];
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:#0b1220;display:grid;grid-template-columns:repeat(10,1fr);gap:6px;padding:10px;z-index:99999;font:10px system-ui;color:#cbd5e1;text-align:center';
  document.body.append(host);

  for (const report of reports) {
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext('2d');
    // Four times plot size, so the shapes are judged rather than the pixels.
    window.__drawWeatherProbe(ctx, 48, 48, report, '#e2e8f0', 4);
    c.style.cssText = 'width:96px;height:96px;background:#111826;border:1px solid #24334a;border-radius:6px';
    const box = document.createElement('div');
    box.append(c, Object.assign(document.createElement('div'), { textContent: report }));
    host.append(box);
  }
});

await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/wx-symbols.png' });
console.log('written shots/wx-symbols.png');
await browser.close();
