/**
 * Which part of the rainfall scale real echoes actually reach.
 *
 * The ladder runs in powers of two from 0.03 mm/h to 8192, which is twenty
 * classes. If the intense ones sit above anything the radar ever reports, then
 * most of the palette — including every dramatic colour at the top of it — is
 * unreachable, and every storm on the map is drawn in the middle of the ramp
 * whatever it is doing. That would explain a scale looking flat without any of
 * the colours themselves being wrong.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto('http://localhost:8080/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const report = await page.evaluate(async () => {
  const { MMH_INTERVALS } = window.__palettes;
  const { dbzToMmh } = window.__radarScale;

  // Reflectivities a composite like this actually produces, and what the ladder
  // makes of them.
  const marks = [20, 30, 35, 40, 45, 50, 55, 60, 65].map((dbz) => {
    const mmh = dbzToMmh(dbz);
    let index = 0;
    for (let i = 0; i < MMH_INTERVALS.length; i += 1) if (mmh >= MMH_INTERVALS[i]) index = i;
    return { dbz, mmh: +mmh.toFixed(1), classIndex: index };
  });

  return {
    classes: MMH_INTERVALS.length,
    intervals: MMH_INTERVALS,
    marks,
  };
});

console.log(`ladder has ${report.classes} classes, topping out at ${report.intervals[report.intervals.length - 2]} mm/h`);
console.log('\n dBZ   mm/h     class');
for (const m of report.marks) {
  console.log(`  ${String(m.dbz).padStart(2)}  ${String(m.mmh).padStart(7)}   ${m.classIndex}`);
}
const top = report.marks[report.marks.length - 1].classIndex;
console.log(`\nA 65 dBZ core — about as intense as this product reports — reaches class ${top} of ${report.classes - 1}.`);
console.log(`So ${report.classes - 2 - top} classes above it are unreachable.`);
await browser.close();
