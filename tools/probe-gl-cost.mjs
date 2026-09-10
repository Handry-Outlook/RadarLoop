/**
 * What the 3D scenery costs during playback on a slow device.
 *
 * Terrain, fog, stars and extruded buildings are drawn every GL frame and share
 * a CPU with the tile workers. This measures playback with each of them removed,
 * so the decision to drop any of them is made on a number rather than a hunch.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });

async function run(label, strip) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  const client = await context.newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000);
  await page.evaluate(() => {
    window.RadarLoop.setLayerEnabled('satellite', false);
    window.RadarLoop.selectProduct('radar', 'windy-radar');
  });
  await page.waitForTimeout(10000);
  await page.click('#btn-3d');
  await page.waitForTimeout(16000);

  const out = await page.evaluate(async ({ what, ms }) => {
    const gl = window.RadarLoop.gl();
    if (what.includes('terrain')) gl.setTerrain(null);
    if (what.includes('fog')) gl.setFog(null);
    if (what.includes('buildings') && gl.getLayer('3d-buildings')) gl.removeLayer('3d-buildings');
    await new Promise((r) => setTimeout(r, 1500));

    window.RadarLoop.time.speed = 4;
    const seen = [];
    const start = performance.now();
    let lastUrl = window.RadarLoop.slots.get('radar').lastUrl;
    window.RadarLoop.playback.play();
    const poll = setInterval(() => {
      const s = window.RadarLoop.slots.get('radar');
      if (s.lastUrl && s.lastUrl !== lastUrl) { seen.push(Math.round(performance.now() - start)); lastUrl = s.lastUrl; }
    }, 20);
    await new Promise((r) => setTimeout(r, ms));
    clearInterval(poll);
    window.RadarLoop.playback.stop();
    const gaps = seen.slice(1).map((t, i) => t - seen[i]).sort((a, b) => a - b);
    return {
      frames: seen.length,
      median: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      phases: window.RadarLoop.phases().radar,
    };
  }, { what: strip, ms: 14000 });

  console.log(`  ${label.padEnd(24)} ${String(out.frames).padStart(2)} frames  median ${String(out.median).padStart(5)}ms  phases=${JSON.stringify(out.phases)}`);
  await context.close();
}

console.log('\n=== 3D playback at 4x, CPU throttled 6x ===');
await run('everything on', []);
await run('no terrain', ['terrain']);
await run('no fog', ['fog']);
await run('no terrain, fog, buildings', ['terrain', 'fog', 'buildings']);
await browser.close();
