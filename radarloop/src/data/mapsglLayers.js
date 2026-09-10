/**
 * The MapsGL weather catalogue.
 *
 * Hand-written rather than generated: `data/layers.js` is extracted from the
 * original file, which only ever used nine MapsGL products. These are the rest
 * of what the SDK offers, merged in at load so regenerating the catalog cannot
 * drop them.
 *
 * Every id here was checked against the loaded SDK with
 * `tools/probe-mapsgl-supported.mjs`, which calls `addWeatherLayer` for each and
 * records what the controller accepts — 210 of the 215 documented ids, the other
 * five being names that turned out not to exist. Acceptance means the SDK holds
 * a configuration for the layer; whether the account is entitled to the data is
 * a separate question the renderer already fails softly on.
 *
 * Labels are derived rather than typed out. Two hundred hand-written strings is
 * two hundred chances to leave a typo somewhere nobody looks, and the ids are
 * regular enough that a humaniser plus a table of the genuinely irregular parts
 * is both shorter and harder to get wrong.
 */

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/** Word-level fixes the generic humaniser cannot infer. */
const WORDS = {
  co: 'CO', no: 'NO', no2: 'NO₂', o3: 'O₃', so2: 'SO₂',
  pm10: 'PM10', pm2p5: 'PM2.5', aqi: 'AQI', msl: 'Mean Sea Level',
  cai: 'CAI', eaqi: 'European AQI', daqi: 'DAQI', uba: 'German',
  uk: 'UK', us: 'US', vpd: 'Vapour Pressure Deficit',
  viz: 'Visibility', obs: 'Observations', accum: 'Accumulation',
  precip: 'Precipitation', dir: 'Direction', vapor: 'Vapour',
};

/** Phrase-level fixes applied after the words are joined. */
const PHRASES = [
  [/Cloud To Ground/g, 'Cloud-to-Ground'],
  [/Mean Sea Level Pressure|Pressure Mean Sea Level/g, 'Mean Sea Level Pressure'],
  [/Temperature Freeze/g, 'Freezing Surface'],
];

/** Trailing qualifiers, rendered as a parenthetical rather than run into the name. */
const QUALIFIERS = {
  text: 'text', icons: 'icons', outline: 'outline', heat: 'heatmap',
  max: 'max', points: 'points', polygons: 'polygons', tracks: 'tracks',
  pulse: 'pulse', particles: 'particles', contour: 'contour',
  categories: 'categories', names: 'names', perimeter: 'perimeter',
};

/** Regions the road-weather products are published for. */
const REGIONS = {
  us: 'US', europe: 'Europe', japan: 'Japan',
  australia: 'Australia', 'new-zealand': 'New Zealand',
};

const titleCase = (word) => WORDS[word] || (word.charAt(0).toUpperCase() + word.slice(1));

/**
 * Turns a layer id into something worth reading.
 *
 * `air-quality-pm2p5-text` becomes "Air Quality PM2.5 (text)";
 * `froad-weather-risk-low-viz-fog-europe` becomes
 * "Road Forecast · Low Visibility Fog Risk — Europe".
 */
export function humanise(id) {
  let rest = id;
  let prefix = '';
  let region = '';

  // Road weather carries both a forecast marker and a region.
  const road = /^(f?)road-weather-(.*?)-(us|europe|japan|australia|new-zealand)$/.exec(id);
  if (road) {
    prefix = road[1] ? 'Road Forecast · ' : 'Road · ';
    rest = road[2];
    region = ` — ${REGIONS[road[3]]}`;
  }

  const parts = rest.split('-');
  const tail = [];
  // Peel qualifiers off the end while they are qualifiers, so `-accum-text`
  // reads as "(accumulation, text)" rather than becoming part of the name.
  while (parts.length > 1 && QUALIFIERS[parts[parts.length - 1]]) {
    tail.unshift(QUALIFIERS[parts.pop()]);
  }

  let name = parts.map(titleCase).join(' ');
  // "Risk Hydroplane" reads better the other way round.
  name = name.replace(/^Risk (.+)$/, (m, tail) => `${tail} Risk`);
  for (const [pattern, replacement] of PHRASES) name = name.replace(pattern, () => replacement);

  return `${prefix}${name}${tail.length ? ` (${tail.join(', ')})` : ''}${region}`;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

/**
 * Which RadarLoop group a layer belongs in, most specific rule first.
 *
 * Road weather gets its own group: eighty entries dropped into observations
 * would bury the surface fields that are already there.
 */
const PLACEMENT = [
  [/^f?road-weather-/, 'roadWeather'],
  [/^satellite/, 'satellite'],
  [/^radar$/, 'radar'],
  [/^lightning-/, 'lightning'],
  [/^hail-/, 'nowcast'],
  [/^(alerts|convective|drought-monitor|fires|earthquakes)/, 'warning'],
  [/^(tropical-cyclones|stormcells)/, 'tropicalStorms'],
  [/^pressure-msl/, 'isobar'],
  [/^wind-/, 'wind'],
  [/^air-quality-/, 'observation'],
  // Everything else is a surface, marine or accumulated field.
  [/./, 'observation'],
];

const groupFor = (id) => PLACEMENT.find(([test]) => test.test(id))[1];

/**
 * Every MapsGL layer the SDK accepts.
 *
 * Kept as a flat list because the placement rules above decide where each one
 * goes; adding a layer is one line here rather than a nested edit.
 */
export const MAPSGL_IDS = [
  /* --- radar and satellite --- */
  'radar',
  'satellite', 'satellite-geocolor', 'satellite-infrared-color',
  'satellite-visible', 'satellite-water-vapor',

  /* --- lightning --- */
  'lightning-all', 'lightning-all-icons',
  'lightning-density', 'lightning-density-accum',
  'lightning-density-cloud-to-ground', 'lightning-density-cloud-to-ground-accum',
  'lightning-density-intracloud', 'lightning-density-intracloud-accum',
  'lightning-flash', 'lightning-strikes', 'lightning-strikes-icons',
  'lightning-strikes-pulse', 'lightning-threats', 'lightning-threats-points',
  'lightning-threats-polygons', 'lightning-threats-tracks',

  /* --- hail --- */
  'hail-severe-probability', 'hail-severe-probability-max',
  'hail-size', 'hail-size-max', 'hail-threats',
  'hail-threats-points', 'hail-threats-polygons', 'hail-threats-tracks',

  /* --- alerts, severe and hazards --- */
  'alerts', 'alerts-outline', 'convective', 'convective-outline',
  'drought-monitor', 'drought-monitor-outline',
  'earthquakes', 'earthquakes-heat',
  'fires', 'fires-icons', 'fires-obs', 'fires-obs-heat', 'fires-obs-icons',
  'fires-obs-names', 'fires-outlook', 'fires-perimeter', 'fires-vpd',
  'tropical-cyclones', 'stormcells',

  /* --- pressure, wind and cloud --- */
  'pressure-msl', 'pressure-msl-contour', 'pressure-msl-text',
  'wind-speeds', 'wind-speeds-text', 'wind-gusts', 'wind-gusts-text',
  'wind-particles', 'wind-barbs', 'wind-dir', 'wind-chill', 'wind-chill-text',
  'cloud-cover', 'cloud-cover-text',

  /* --- temperature and comfort --- */
  'temperatures', 'temperatures-text', 'dew-points', 'dew-points-text',
  'feels-like', 'feels-like-text', 'heat-index', 'heat-index-text',
  'humidity', 'humidity-text', 'visibility', 'visibility-text',

  /* --- precipitation --- */
  'precip', 'precip-text', 'precip-accum', 'precip-accum-text',
  'precip-rate', 'precip-rate-text',
  'ice', 'ice-text', 'ice-accum', 'ice-accum-text',
  'sleet', 'sleet-text', 'sleet-accum', 'sleet-accum-text',
  'snow', 'snow-text', 'snow-accum', 'snow-accum-text',
  'snow-depth', 'snow-depth-text',

  /* --- marine and water --- */
  'ocean-currents', 'ocean-currents-particles',
  'wave-heights', 'wave-periods', 'river-observations',

  /* --- air quality --- */
  'air-quality-index', 'air-quality-index-text', 'air-quality-index-categories',
  'air-quality-health-index-categories',
  'air-quality-index-cai-categories', 'air-quality-index-cai-text',
  'air-quality-index-china-categories', 'air-quality-index-china-text',
  'air-quality-index-eaqi-categories', 'air-quality-index-eaqi-text',
  'air-quality-index-india-categories', 'air-quality-index-india-text',
  'air-quality-index-uba-daqi-categories', 'air-quality-index-uba-daqi-text',
  'air-quality-index-uk-daqi-categories', 'air-quality-index-uk-daqi-text',
  'air-quality-co', 'air-quality-co-text', 'air-quality-no', 'air-quality-no-text',
  'air-quality-no2', 'air-quality-no2-text', 'air-quality-o3', 'air-quality-o3-text',
  'air-quality-pm10', 'air-quality-pm10-text', 'air-quality-pm2p5', 'air-quality-pm2p5-text',
  'air-quality-so2', 'air-quality-so2-text',

  /* --- road weather, current and forecast, per region --- */
  ...['road-weather', 'froad-weather'].flatMap((prefix) =>
    ['risk-hydroplane', 'risk-low-viz-fog', 'risk-low-viz-snow', 'risk-rollover',
      'summary', 'surface', 'temperature', 'temperature-freeze'].flatMap((kind) =>
      Object.keys(REGIONS).map((region) => `${prefix}-${kind}-${region}`))),
];

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

/**
 * Adds these layers to a catalog, in place.
 *
 * Existing entries win: the nine MapsGL products carried over from the original
 * file already have their own keys and labels, and rewriting those would change
 * what a saved session restores. A layer already present under any key in its
 * group — matched on the MapsGL id, not the catalog key — is skipped.
 */
export function mergeMapsGLLayers(catalog) {
  for (const id of MAPSGL_IDS) {
    const group = groupFor(id);
    const defs = (catalog[group] ||= { __order: [] });

    const already = Object.entries(defs)
      .some(([key, def]) => key !== '__order' && def?.kind === 'mapsgl' && (def.id || key) === id);
    if (already) continue;

    // Prefixed so a MapsGL layer can never collide with a tile product that
    // happens to share a name — `radar` and `satellite` both would.
    const key = `mapsgl-${id}`;
    if (defs[key]) continue;

    // Declared, but not filed: pushing these onto the end of `__order` put them
    // under whatever heading happened to be last, which filed a radar layer
    // under "Satellite Precipitation Estimation". orderProducts collects
    // anything listed that no section names and gives it a section of its own.
    defs[key] = { kind: 'mapsgl', id, label: humanise(id), listed: true };
    defs.__order ||= [];
  }
  return catalog;
}
