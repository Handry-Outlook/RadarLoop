/**
 * Generates radarloop/src/data/layers.js from the legacy option objects.
 * Every definition is carried across verbatim; only the `type` tag is replaced
 * by a `kind` that names the renderer that will actually be used.
 */
const fs = require('fs');
const path = require('path');

const GROUPS = ['radar', 'satellite', 'isobar', 'wind', 'lightning', 'tropicalStorms',
  'rotation', 'surfaceFront', 'observation', 'nowcast', 'warning'];

const labels = JSON.parse(fs.readFileSync('extract/labels.json', 'utf8'));

/**
 * The legacy file mutated two option maps with `Object.assign` *after* their
 * literals, replacing tile definitions with MapsGL ones. The literal alone is
 * therefore not what ran — these overrides are the real runtime values.
 */
const RUNTIME_OVERRIDES = {
  lightning: {
    'lightning-all-tile': { type: 'mapsgl', id: 'lightning-all' },
    'lightning-density': { type: 'mapsgl', id: 'lightning-density' },
    'lightning-density-accum': { type: 'mapsgl', id: 'lightning-density-accum' },
  },
  nowcast: {
    'hail-severe-probability': { type: 'mapsgl', id: 'hail-severe-probability' },
    'hail-severe-probability-max': { type: 'mapsgl', id: 'hail-severe-probability-max' },
    'hail-size': { type: 'mapsgl', id: 'hail-size' },
    'hail-size-max': { type: 'mapsgl', id: 'hail-size-max' },
    'hail-threats': { type: 'mapsgl', id: 'hail-threats' },
    'lightning-threats': { type: 'mapsgl', id: 'lightning-threats' },
  },
};

function loadGroup(group) {
  const file = `extract/${group}Options.txt`;
  if (!fs.existsSync(file)) return {};
  // eslint-disable-next-line no-eval
  const defs = eval('(' + fs.readFileSync(file, 'utf8') + ')');
  return Object.assign(defs, RUNTIME_OVERRIDES[group] || {});
}

function classify(key, def) {
  const t = def.type;
  if (t === 'mapsgl') return 'mapsgl';
  if (t === 'opera-scalar') return 'opera';
  if (t === 'image') return 'image';
  if (t === 'wms-xyz') return 'wms';
  if (t === 'feature-layer') return 'esri-feature';
  if (t === 'geojson' || t === 'geojson-layer') return 'geojson';
  if (t === 'custom-live-windy-lightning') return 'windy-lightning';
  if (key.startsWith('xweather-') || key === 'stormHailThreat') return 'xweather';
  const url = String(def.url || '');
  if (/\.pbf(\?|$)/i.test(url)) return 'pbf';
  if (/\.(png|webp|jpe?g|jpg)(\?|$)/i.test(url)) return 'raster';
  if (!url) return 'custom';
  return 'raster';
}

const catalog = {};
const stats = {};
const unlabelled = [];

for (const group of GROUPS) {
  const defs = loadGroup(group);
  const labelMap = new Map((labels[group] || []).filter((o) => !o.disabled).map((o) => [o.value, o.label]));
  const selectable = new Set(labelMap.keys());
  catalog[group] = {};
  for (const [key, def] of Object.entries(defs)) {
    const kind = classify(key, def);
    stats[kind] = (stats[kind] || 0) + 1;
    const entry = { kind };
    if (def.id) entry.id = def.id;
    if (def.url) entry.url = def.url;
    if (def.interval) entry.interval = def.interval;
    if (def.bounds) entry.bounds = def.bounds;
    if (def.attribution) entry.attribution = def.attribution;
    if (def.coverage) entry.coverage = def.coverage;
    if (def.allowFuture) entry.allowFuture = true;
    if (def.isNowcast) entry.isNowcast = true;
    if (def.width) entry.width = def.width;
    if (def.height) entry.height = def.height;
    if (def.bytesPerPixel) entry.bytesPerPixel = def.bytesPerPixel;
    if (def.projection) entry.projection = def.projection;
    if (def.projectedExtent) entry.projectedExtent = def.projectedExtent;
    entry.label = labelMap.get(key) || def.label || key;
    if (!labelMap.has(key)) unlabelled.push(`${group}:${key}`);
    entry.listed = selectable.has(key);
    catalog[group][key] = entry;
  }
  // Preserve the exact order and grouping headers the select used.
  catalog[group].__order = (labels[group] || []).map((o) => (o.disabled ? { header: o.label } : o.value));
}

const header = `/**
 * Layer catalog — every remote weather product the application can display.
 *
 * GENERATED from the legacy inline option objects; see scripts_catalog.cjs.
 * Hand edits are fine, but keep the shape: the renderer dispatches on \`kind\`.
 *
 *   kind          renderer
 *   ------------  ------------------------------------------------------------
 *   raster        XYZ image tiles (png / webp / jpg)
 *   pbf           Mapbox vector tiles via L.vectorGrid.protobuf
 *   image         single georeferenced image overlay
 *   opera         EUMETNET OPERA binary scalar grid, reprojected to a canvas
 *   wms           WMS with a {bbox} template
 *   geojson       GeoJSON fetched per frame
 *   esri-feature  Esri FeatureServer layer
 *   mapsgl        Aeris MapsGL GPU layer
 *   xweather      Xweather point/plot data drawn as markers
 *   windy-lightning  bespoke live strike feed
 *
 * \`listed\` marks the products offered in the layer picker; the rest are
 * internal (for example radar-nowcast-forecast, used for future timestamps).
 */

`;

let body = 'import { mergeMapsGLLayers } from \x27./mapsglLayers.js\x27;
'
  + 'import { scrubCatalog } from \x27./sourceNames.js\x27;

'
  + 'export const LAYER_CATALOG = ' + JSON.stringify(catalog, null, 2)
  .replace(/"([A-Za-z_$][A-Za-z0-9_$-]*)":/g, (m, k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? `${k}:` : m))
  + ';\n\n';

body += `export const LAYER_ORDER = Object.fromEntries(
  Object.entries(LAYER_CATALOG).map(([group, defs]) => [group, defs.__order || []]),
);

/** Look up one product definition. */
export function getLayerDef(group, type) {
  const defs = LAYER_CATALOG[group];
  return defs && type ? defs[type] || null : null;
}

/** Every selectable product in a group, in picker order, headers included. */
export function listLayers(group) {
  const defs = LAYER_CATALOG[group] || {};
  return (LAYER_ORDER[group] || [])
    .map((entry) => (typeof entry === 'string'
      ? (defs[entry] ? { value: entry, ...defs[entry] } : null)
      : entry))
    .filter(Boolean);
}
`;

fs.mkdirSync('radarloop/src/data', { recursive: true });
fs.writeFileSync(path.join('radarloop/src/data/layers.js'), header + body);

console.log('=== KIND DISTRIBUTION ===');
Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(4), k));
console.log('\ntotal definitions:', Object.values(stats).reduce((a, b) => a + b, 0));
console.log('unlisted (internal / not in picker):', unlabelled.length);
console.log(unlabelled.join('\n  '));
