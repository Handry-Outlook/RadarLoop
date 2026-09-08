/**
 * Keeps provider names out of the interface.
 *
 * Product labels, legend rows, base map groups and the map attribution control
 * all named the organisation behind the data. This is the single place that
 * decides what counts as a source name, so a catalog regeneration cannot
 * reintroduce one: `data/layers.js` runs `scrubCatalog` over itself at load, and
 * the base map catalog and the popup builder use `cleanLabel` directly.
 *
 * Note that tile and API requests are unchanged — hostnames, keys and response
 * payloads are all still visible to anyone opening the network tab. This removes
 * the names from the interface, which is a presentation change, not concealment.
 */

/**
 * Acronyms, matched case-sensitively.
 *
 * This matters: `GOES` is also an ordinary English word, and matching it without
 * regard to case would eat its way through alert prose ("the warning goes out
 * to…"). Every entry here is an initialism that only ever appears capitalised.
 */
const ACRONYMS = [
  'NOAA', 'GOES', 'JMA', 'NASA', 'GPM', 'DTN', 'MTG',
  'EUMETSAT', 'EUMETNET', 'OPERA', 'UKMO', 'ECMWF', 'NWS',
];

/**
 * Full names, matched case-insensitively. Longest first so prefixes lose.
 *
 * Base map providers are deliberately absent. Mapbox, OpenStreetMap, MapTiler,
 * OpenTopoMap and Esri credits stay in the attribution control: those are the
 * licence-required ones, and they identify the *map*, not the weather data.
 */
const NAMES = [
  'Met Office', 'MetOffice', 'Meteoguard', 'MeteoSat', 'Copernicus',
  'X Weather', 'XWeather', 'Xweather', 'MapsGL',
  'RainViewer', 'Foreca', 'Aeris', 'Windy',
];

const ACRONYM_RE = new RegExp(`\\b(?:${ACRONYMS.join('|')})\\b`, 'g');
const NAME_RE = new RegExp(`\\b(?:${NAMES.join('|')})\\b`, 'gi');
/** A copyright notice is a source credit whatever follows it. */
const CREDIT_RE = /©\s*[^,·|/()]*/g;

/**
 * Removes source names from a piece of display text and tidies what is left.
 *
 * The tidy-up is the fiddly half: taking "GOES" out of "Global infrared (GOES)"
 * leaves an empty bracket, and taking "NASA" out of a slash-separated credit
 * leaves stranded separators.
 */
export function cleanLabel(text) {
  if (typeof text !== 'string' || !text) return text;

  let out = text
    .replace(CREDIT_RE, ' ')
    .replace(NAME_RE, ' ')
    .replace(ACRONYM_RE, ' ');

  // Brackets and separators left holding nothing.
  out = out
    .replace(/\(\s*\)/g, ' ')
    .replace(/\[\s*\]/g, ' ')
    .replace(/\s*\/\s*(?=\/)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:%])/g, '$1')
    .replace(/(^|\s)[-–—·/|]+(\s|$)/g, '$1')
    .replace(/[\s\-–—·/|,]+$/, '')
    .replace(/^[\s\-–—·/|,]+/, '')
    .trim();

  return out;
}

/**
 * Strips source names from a layer catalog, in place.
 *
 * Attribution strings are removed outright rather than cleaned: they exist only
 * to name a provider, so there is nothing left worth showing.
 */
export function scrubCatalog(catalog) {
  for (const defs of Object.values(catalog || {})) {
    for (const [key, def] of Object.entries(defs)) {
      if (key === '__order' || !def || typeof def !== 'object') continue;
      if (typeof def.label === 'string') def.label = cleanLabel(def.label) || def.label;
      if ('attribution' in def) delete def.attribution;
    }
  }
  return catalog;
}
