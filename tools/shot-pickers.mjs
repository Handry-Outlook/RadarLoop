/** The product drop-lists, open, so the ordering can be read at a glance. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

// A real select popup cannot be screenshotted, so the options are laid out as
// the list they represent, group headings included.
await page.evaluate(() => {
  const groups = ['radar', 'satellite', 'lightning'];
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--surface-0,#0b1220);display:flex;gap:18px;padding:18px;z-index:99999;font:12px/1.5 system-ui;color:var(--text-primary,#e2e8f0)';
  document.body.append(host);
  for (const group of groups) {
    const column = document.createElement('div');
    column.style.cssText = 'min-width:280px';
    const title = document.createElement('div');
    title.textContent = group;
    title.style.cssText = 'font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;color:var(--accent,#38bdf8)';
    column.append(title);
    for (const entry of window.__catalog.LAYER_ORDER[group]) {
      const row = document.createElement('div');
      if (typeof entry === 'string') {
        row.textContent = window.__catalog.LAYER_CATALOG[group][entry].label;
        row.style.cssText = 'padding:2px 0 2px 14px';
      } else {
        row.textContent = entry.header;
        row.style.cssText = 'padding:10px 0 2px;font-weight:600;opacity:.65';
      }
      column.append(row);
    }
    host.append(column);
  }
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/pickers.png', fullPage: false });
console.log('written shots/pickers.png');
await browser.close();
