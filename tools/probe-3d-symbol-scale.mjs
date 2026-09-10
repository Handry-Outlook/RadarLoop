/**
 * How large a station model ends up in 3D, against the camera, at each pitch.
 *
 * The plot is drawn at a fixed pixel size onto the hidden 2D map, and that image
 * is stretched over the GL scene. So the apparent size depends entirely on the
 * zoom the composite was captured at compared with the camera's own — capture
 * one level低 and every symbol is twice the size it should be.
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8080/index.html';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);
await page.evaluate(() => {
  window.RadarLoop.setLayerEnabled('radar', false);
  window.RadarLoop.setLayerEnabled('satellite', false);
  window.RadarLoop.map().setView([40.5, -76.0], 7, { animate: false });
  window.RadarLoop.setLayerEnabled('observations', true);
});
await page.waitForTimeout(10000);
await page.click('#btn-3d');
await page.waitForTimeout(14000);

console.log('  pitch  camera z  capture z  leaflet z  ratio   symbol scale');
for (const pitch of [0, 15, 30, 45, 60, 70]) {
  const r = await page.evaluate(async (p) => {
    const gl = window.RadarLoop.gl();
    gl.jumpTo({ pitch: p, bearing: 0 });
    await new Promise((r2) => setTimeout(r2, 3500));
    window.RadarLoop.refreshOverlayMirror();
    await new Promise((r2) => setTimeout(r2, 1800));
    const cap = window.RadarLoop.mirrorStats().lastCapture;
    return {
      cameraZoom: +(gl.getZoom() + 1).toFixed(2),
      captureZoom: cap ? cap.zoom : null,
      leafletZoom: window.RadarLoop.map().getZoom(),
      scale: cap ? cap.scale : null,
      plotScale: window.RadarLoop.observations().scale,
    };
  }, pitch);

  // Each zoom level below the camera's doubles the apparent size of a fixed-pixel symbol.
  const ratio = r.captureZoom === null ? null : 2 ** (r.cameraZoom - r.captureZoom);
  const onScreen = ratio === null ? null : ratio * r.plotScale;
  console.log(
    `  ${String(pitch).padStart(4)}째  ${String(r.cameraZoom).padStart(8)}  `
    + `${String(r.captureZoom).padStart(9)}  ${String(r.leafletZoom).padStart(9)}  `
    + `${ratio === null ? '  n/a' : ratio.toFixed(2).padStart(5)}   `
    + `drawn ${r.plotScale.toFixed(3)}  on screen ${onScreen === null ? '?' : onScreen.toFixed(2)}x`,
  );
}
await browser.close();
