const fs = require('fs');
const src = fs.readFileSync('UK (9).html', 'utf8');
const selects = {
  radarLayer: 'radar',
  satelliteLayerSelect: 'satellite',
  isobarLayerSelect: 'isobar',
  windLayerSelect: 'wind',
  lightningLayerSelect: 'lightning',
  tropicalStormsLayerSelect: 'tropicalStorms',
  rotationLayerSelect: 'rotation',
  surfaceFrontLayerSelect: 'surfaceFront',
  observationLayerSelect: 'observation',
  nowcastLayerSelect: 'nowcast',
  warningLayerSelect: 'warning',
};
const out = {};
for (const [id, group] of Object.entries(selects)) {
  const re = new RegExp('<select[^>]*id="' + id + '"[\\s\\S]*?</select>');
  const m = re.exec(src);
  if (!m) { console.log('MISS', id); continue; }
  const opts = [...m[0].matchAll(/<option[^>]*value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)];
  out[group] = opts.map((o) => ({
    value: o[1],
    disabled: /disabled/.test(o[2]),
    label: o[3].replace(/\s+/g, ' ').trim(),
  }));
  console.log(group.padEnd(16), out[group].length, 'options');
}
fs.writeFileSync('extract/labels.json', JSON.stringify(out, null, 2));
