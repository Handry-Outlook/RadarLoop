/** Extracts RADAR_PALETTE_PRESETS verbatim into the new data module. */
const fs = require('fs');
const src = fs.readFileSync('UK (9).html', 'utf8');

const start = src.indexOf('const RADAR_SHARED_MMH_INTERVALS');
const end = src.indexOf("let activeRadarPalettePreset");
if (start < 0 || end < 0) throw new Error('palette block not found');
const block = src.slice(start, end);

// Evaluate in isolation to capture the expanded presets.
const sandbox = {};
const fn = new Function(block + '\nreturn { RADAR_SHARED_MMH_INTERVALS, RADAR_PALETTE_PRESETS };');
const { RADAR_SHARED_MMH_INTERVALS, RADAR_PALETTE_PRESETS } = fn();

// Recover the raw colour ramps (drop the synthesised transparent first stop).
const ramps = {};
for (const [name, levels] of Object.entries(RADAR_PALETTE_PRESETS)) {
  ramps[name] = levels.slice(1).map((l) => l[1]);
}

const names = {
  'windy-clean': 'Global High Resolution Clean',
  classic: 'Classic Weather Radar',
  'high-contrast': 'High Contrast Severe',
  'soft-professional': 'Soft Professional',
  colourblind: 'Colour-blind Friendly',
  'blue-magenta': 'Blue to Magenta',
  turbo: 'Turbo Spectrum',
  viridis: 'Viridis',
  plasma: 'Plasma',
  'ice-fire': 'Ice to Fire',
  'ocean-storm': 'Ocean Storm',
  radarscope: 'RadarScope Inspired',
};

const rampLines = Object.entries(ramps).map(([key, colours]) => {
  const rows = [];
  for (let i = 0; i < colours.length; i += 5) {
    rows.push('    ' + colours.slice(i, i + 5).map((c) => `[${c.join(',')}]`).join(', '));
  }
  return `  '${key}': [\n${rows.join(',\n')},\n  ],`;
}).join('\n');

const out = `/**
 * Rainfall-rate colour scales shared by the Global High Resolution (Windy)
 * radar composite and the OPERA reflectivity product.
 *
 * All presets use the same mm/h interval ladder, so switching preset only swaps
 * colours — the class boundaries never move. Individual stops stay user-editable.
 *
 * GENERATED from the legacy inline presets; see scripts_palettes.cjs.
 */

/** Rainfall-rate class boundaries in mm/h, ascending. */
export const MMH_INTERVALS = ${JSON.stringify(RADAR_SHARED_MMH_INTERVALS)};

/** Display names for the preset picker. */
export const PALETTE_NAMES = ${JSON.stringify(names, null, 2).replace(/"([A-Za-z_$][\w$]*)":/g, '$1:')};

/** Raw [r,g,b,a] ramps, one colour per interval above the transparent floor. */
export const PALETTE_RAMPS = {
${rampLines}
};

/** Expands a ramp into [value, rgba] level pairs with a transparent first stop. */
export function buildPalette(ramp) {
  return MMH_INTERVALS.map((value, index) => [
    value,
    index === 0 ? [0, 0, 0, 0] : ramp[Math.min(index - 1, ramp.length - 1)].slice(),
  ]);
}

export const DEFAULT_PALETTE = 'turbo';
`;

fs.mkdirSync('radarloop/src/data', { recursive: true });
fs.writeFileSync('radarloop/src/data/palettes.js', out);
console.log('presets:', Object.keys(ramps).length);
console.log('intervals:', RADAR_SHARED_MMH_INTERVALS.length);
console.log('colours per ramp:', ramps.turbo.length);
