/** Where boot time goes. Repeated, because the first run pays a cold cache. */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const runs = Number(process.env.RUNS || 3);
const browser = await chromium.launch();

for (let i = 1; i <= runs; i += 1) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const net = [];
  page.on('requestfinished', async (r) => {
    const t = r.timing();
    if (t && t.responseEnd > 0) {
      net.push({ url: r.url(), ms: Math.round(t.responseEnd), type: r.resourceType() });
    }
  });

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const domReady = Date.now() - t0;
  await page.waitForSelector('.rail__btn', { timeout: 40000 });
  const shell = Date.now() - t0;

  // When the first weather frame is actually on the map.
  await page.waitForFunction(
    () => [...window.RadarLoop.slots.values()].some((s) => s.front),
    { timeout: 60000 },
  ).catch(() => {});
  const firstFrame = Date.now() - t0;

  const marks = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const scripts = performance.getEntriesByType('resource')
      .filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js'))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 8)
      .map((r) => ({ name: r.name.split('/').pop().slice(0, 46), ms: Math.round(r.duration) }));
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      resources: performance.getEntriesByType('resource').length,
      slowestScripts: scripts,
    };
  });

  console.log(`\nrun ${i}: dom ${domReady}ms  shell ${shell}ms  first frame ${firstFrame}ms`);
  console.log(`  navigation: DCL ${marks.domContentLoaded}ms, load ${marks.loadEvent}ms, ${marks.resources} resources`);
  console.log('  slowest scripts:');
  for (const s of marks.slowestScripts) console.log(`    ${String(s.ms).padStart(6)}ms  ${s.name}`);

  await context.close();
}
await browser.close();
