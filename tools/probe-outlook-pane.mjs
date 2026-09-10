/**
 * Is the outlook pane empty once the test's probe polygon is taken away?
 *
 * The 3D suite asserts that removing the probe drops its 3D mirror. That only
 * holds if the probe was the only thing in the pane — if the real outlook has
 * loaded, the pane still has content and keeping the mirror is correct, not a
 * leak. This says which of the two happened.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 880 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(11000);

const report = await page.evaluate(async () => {
  const map = window.RadarLoop.map();
  /** Fraction of sampled pixels in a pane that are painted. */
  const inked = () => {
    const pane = map.getPane('hocoFillPane');
    const canvases = [...(pane?.querySelectorAll('canvas') || [])];
    let painted = 0;
    let total = 0;
    for (const c of canvases) {
      if (!c.width || !c.height) continue;
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 400) { total += 1; if (d[i] > 4) painted += 1; }
    }
    return { canvases: canvases.length, painted, total };
  };

  const before = inked();
  const c = map.getCenter();
  const probe = L.polygon([
    [c.lat - 3, c.lng - 5], [c.lat + 3, c.lng - 5], [c.lat + 3, c.lng + 5], [c.lat - 3, c.lng + 5],
  ], { pane: 'hocoFillPane', renderer: L.canvas({ pane: 'hocoFillPane', padding: 0.35 }), color: '#ff0000', fillOpacity: 0.6 });
  probe.addTo(map);
  await new Promise((r) => setTimeout(r, 1500));
  const withProbe = inked();
  map.removeLayer(probe);
  await new Promise((r) => setTimeout(r, 1500));
  return { before, withProbe, afterRemoval: inked() };
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
