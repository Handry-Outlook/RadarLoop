import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

// Driven through the real control; the theme setter is not exposed for tests.
const setThemeTo = async (want) => {
  const now = await page.evaluate(() => window.RadarLoop.runtime.theme);
  if (now !== want) await page.click('#btn-theme');
};

const readStyle = () => page.evaluate(() => {
  const gl = window.RadarLoop.gl();
  const s = gl && gl.getStyle();
  return {
    theme: window.RadarLoop.runtime.theme,
    domTheme: document.documentElement.dataset.theme,
    styleName: s ? s.name : null,
    sprite: s ? String(s.sprite || '').slice(-40) : null,
  };
});

// Switch to light while still in 2D, the way the settings panel does.
await setThemeTo('light');
await page.waitForTimeout(1200);
await page.click('#btn-3d');
await page.waitForTimeout(11000);
console.log('entered 3D while light:', JSON.stringify(await readStyle()));

// And toggling the theme while already in 3D.
await setThemeTo('dark');
await page.waitForTimeout(6000);
console.log('switched to dark in 3D: ', JSON.stringify(await readStyle()));
await setThemeTo('light');
await page.waitForTimeout(6000);
console.log('switched to light in 3D:', JSON.stringify(await readStyle()));
await browser.close();
