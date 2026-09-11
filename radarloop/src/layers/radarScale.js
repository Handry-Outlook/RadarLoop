/**
 * The shared rainfall-rate colour scale.
 *
 * Two products are recoloured client-side: the Global High Resolution (Windy)
 * composite, whose tiles encode reflectivity in the pixel value, and the OPERA
 * binary DBZH grid. Both convert to mm/h and then look the colour up here, so a
 * preset change updates them together and the legend stays truthful.
 *
 * The conversion constants are calibrated against Windy's own picker and must not
 * be "tidied" — changing them silently changes what the colours mean.
 */

import { clampByte, hexToRgba, loadSetting, rgbaToHex, saveSetting } from '../core/util.js';
import { buildPalette, DEFAULT_PALETTE, MMH_INTERVALS, PALETTE_NAMES, PALETTE_RAMPS } from '../data/palettes.js';

/** Windy encodes dBZ in the tile's red channel at this scale. */
const DBZ_PER_ENCODED_UNIT = 56 / 94; // RGB(93,95,26) → 56 dBZ
/** Below this rate a pixel is treated as "no measurable rainfall" and left clear. */
export const MIN_VISIBLE_MMH = 0.03;
/** Empirical correction bringing Marshall–Palmer output in line with Windy's scale. */
const MMH_NERF = 0.3;

export function dbzToMmh(dbz) {
  return (10 ** (dbz / 10) * 0.005) ** 0.625 * MMH_NERF;
}

export const encodedToDbz = (encoded) => Math.max(0, encoded * DBZ_PER_ENCODED_UNIT);
export const encodedToMmh = (encoded) => dbzToMmh(encodedToDbz(encoded));

/* ------------------------------------------------------------------ *
 * Active scale
 * ------------------------------------------------------------------ */

/**
 * Which products are drawn through the shared rainfall scale.
 *
 * Only these two are data rather than pictures: their tiles carry reflectivity
 * in the pixel channels and are coloured here, so the scale and the smoothing
 * apply to them and to nothing else. Every other radar product arrives already
 * coloured by its provider, and offering a colour editor for one of those is an
 * offer the app cannot keep.
 */
export const SHARED_SCALE_TYPES = ['windy-radar', 'opera-dbzh'];
export const usesSharedScale = (type) => SHARED_SCALE_TYPES.includes(type);

/**
 * Whether to interpolate the reflectivity field before colouring it.
 *
 * The tiles are data, so this smooths the *values* and lets the colour table
 * re-quantise them — which is why it does not look blurred. Interpolating the
 * finished picture would blend one class's colour into the next and turn a
 * banded scale into a wash; interpolating what the bands are computed from moves
 * the boundaries onto a smooth field and leaves them as sharp as they were.
 */
let smoothing = loadSetting('radarSmoothing', false) === true;

export const isSmoothing = () => smoothing;

export function setSmoothing(value) {
  const next = value === true;
  if (next === smoothing) return;
  smoothing = next;
  saveSetting('radarSmoothing', next);
  // The signature keys every cached tile and the worker's colour table, so it
  // has to change or nothing would redraw.
  invalidate();
}

let activePreset = loadSetting('radarPalette', DEFAULT_PALETTE);
if (!PALETTE_RAMPS[activePreset]) activePreset = DEFAULT_PALETTE;

/** Per-interval colour overrides the user typed in, keyed by interval index. */
let overrides = loadSetting('radarPaletteOverrides', {}) || {};

/** Bumped whenever the scale changes, so caches keyed on it invalidate. */
let signature = '';

function computeSignature(levels) {
  return `${smoothing ? 's' : 'n'}|${levels.map(([value, rgba]) => `${value}:${rgba.join(',')}`).join('|')}`;
}

let cachedLevels = null;

/** The active scale as `[mmhThreshold, [r,g,b,a]]` pairs, ascending. */
export function getLevels() {
  if (cachedLevels) return cachedLevels;
  const levels = buildPalette(PALETTE_RAMPS[activePreset]);
  for (const [index, hex] of Object.entries(overrides)) {
    const i = Number(index);
    if (!levels[i]) continue;
    const alpha = levels[i][1][3];
    levels[i][1] = hexToRgba(hex, alpha);
  }
  cachedLevels = levels;
  signature = computeSignature(levels);
  return levels;
}

export const getSignature = () => {
  getLevels();
  return signature;
};

function invalidate() {
  cachedLevels = null;
  getLevels();
}

export function setPreset(name) {
  if (!PALETTE_RAMPS[name]) return;
  activePreset = name;
  overrides = {};
  saveSetting('radarPalette', name);
  saveSetting('radarPaletteOverrides', overrides);
  invalidate();
}

export const getPreset = () => activePreset;

export function setLevelColour(index, hex) {
  overrides[index] = hex;
  saveSetting('radarPaletteOverrides', overrides);
  invalidate();
}

export function resetOverrides() {
  overrides = {};
  saveSetting('radarPaletteOverrides', overrides);
  invalidate();
}

export const presetNames = () => PALETTE_NAMES;

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/**
 * Colour for a rainfall rate, or null when it is below the visible floor.
 * Levels are ascending, so the last threshold not exceeding `mmh` wins.
 */
export function colourForMmh(mmh, levels = getLevels()) {
  if (!Number.isFinite(mmh) || mmh < MIN_VISIBLE_MMH) return null;
  let chosen = null;
  for (let i = 1; i < levels.length; i += 1) {
    if (mmh >= levels[i - 1][0]) chosen = levels[i][1];
    else break;
  }
  return chosen;
}

/**
 * A 256-entry RGBA lookup table mapping an encoded byte straight to a colour.
 *
 * Building this once per scale change turns per-pixel colouring into two array
 * reads — the reason a full-viewport OPERA reprojection colours in milliseconds.
 */
let lutCache = null;
let lutSignature = '';

export function getEncodedLut({ opera = false } = {}) {
  const sig = `${getSignature()}|${opera ? 'opera' : 'windy'}`;
  if (lutCache && lutSignature === sig) return lutCache;

  const levels = getLevels();
  const lut = new Uint8ClampedArray(256 * 4);
  for (let encoded = 0; encoded < 255; encoded += 1) {
    // OPERA stores DBZH as `value * 0.5 - 32`; Windy uses its own linear scale.
    const dbz = opera ? encoded * 0.5 - 32 : encodedToDbz(encoded);
    const mmh = dbz > 0 ? dbzToMmh(dbz) : 0;
    const colour = mmh >= MIN_VISIBLE_MMH ? colourForMmh(mmh, levels) : null;
    if (!colour) continue;
    const i = encoded * 4;
    lut[i] = colour[0];
    lut[i + 1] = colour[1];
    lut[i + 2] = colour[2];
    lut[i + 3] = colour[3];
  }
  lutCache = lut;
  lutSignature = sig;
  return lut;
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export function formatMmhLabel(value, index, total) {
  if (index === 0) return `<${value} mm/h`;
  if (index === total - 1) return `≥${value} mm/h`;
  return `${value} mm/h`;
}

export function describeMmh(mmh) {
  if (!Number.isFinite(mmh) || mmh < MIN_VISIBLE_MMH) return 'No measurable rainfall';
  if (mmh < 0.5) return `${mmh.toFixed(2)} mm/h · light`;
  if (mmh < 4) return `${mmh.toFixed(1)} mm/h · moderate`;
  if (mmh < 16) return `${mmh.toFixed(1)} mm/h · heavy`;
  return `${Math.round(mmh)} mm/h · violent`;
}

/** Legend swatches for the active scale, skipping the transparent floor. */
export function legendStops() {
  const levels = getLevels();
  return levels.slice(1).map(([value, rgba], index) => ({
    index: index + 1,
    value,
    hex: rgbaToHex(rgba),
    alpha: clampByte(rgba[3]) / 255,
    label: formatMmhLabel(value, index, levels.length - 1),
  }));
}

export { MMH_INTERVALS };
