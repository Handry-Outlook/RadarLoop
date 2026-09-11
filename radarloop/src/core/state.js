/**
 * Single source of truth for application state.
 *
 * The old build kept roughly eighty module-level `let` bindings (`lastRadarType`,
 * `isRadarAnimating`, `lastRequestedSatelliteTimestamp`, …) — one family per layer,
 * duplicated eleven times and read through two large `switch (layerKey)` blocks.
 * Here each layer group owns an identical record in one map, so the renderer is
 * written once and works for every group.
 */

import { LAYER_ORDER } from '../data/layers.js';
import { LAYER_Z, TUNING } from '../config.js';
import { emit, EVENTS } from './bus.js';
import { loadSetting, saveSetting } from './util.js';

/** The eleven weather layer groups, in render order (bottom to top). */
export const LAYER_GROUPS = [
  'satellite',
  'radar',
  'observation',
  'isobar',
  'surfaceFront',
  'wind',
  'nowcast',
  'tropicalStorms',
  'rotation',
  'lightning',
  'warning',
  'roadWeather',
];

/** Per-group human labels used by the UI and legend. */
export const LAYER_LABELS = {
  radar: 'Radar',
  satellite: 'Satellite',
  isobar: 'Pressure',
  surfaceFront: 'Fronts',
  wind: 'Wind',
  lightning: 'Lightning (global)',
  tropicalStorms: 'Tropical storms',
  rotation: 'Rotation & echo tops',
  observation: 'Observations',
  nowcast: 'Nowcast & severe',
  warning: 'Warnings',
  roadWeather: 'Road weather',
};

/**
 * One slot per layer group. `front`/`back` implement the double buffer: the front
 * layer stays visible while the back layer downloads its tiles, and they swap only
 * once the new frame has actually loaded. That is what removes the flash-to-basemap
 * and the stutter when scrubbing.
 */
function createSlot(group) {
  return {
    group,
    enabled: false,
    type: null,
    opacity: 0.8,
    zIndex: LAYER_Z[group] ?? 300,
    front: null,
    back: null,
    /** Frame identity currently on screen — used to skip no-op re-renders. */
    frameKey: null,
    /** Monotonic token; a render whose token is stale discards its result. */
    token: 0,
    lastTimestamp: null,
    lastUrl: null,
    /** True while GL fetches this product itself and the Leaflet copy is skipped. */
    glDirect: false,
    busy: false,
  };
}

export const slots = new Map(LAYER_GROUPS.map((group) => [group, createSlot(group)]));

export const getSlot = (group) => slots.get(group);

/* ------------------------------------------------------------------ *
 * Time model
 * ------------------------------------------------------------------ */

export const time = {
  /** Timestamp the map is currently showing. */
  current: Date.now(),
  /** Scrubber span, in hours back from now. */
  historyHours: loadSetting('historyHours', 6),
  /** True while the scrubber is parked at the newest position. */
  atLive: true,
  playing: false,
  /** Animation speed in steps per second. */
  speed: loadSetting('animationSpeed', 5),
  /** Explicit filter window, when the user set one. */
  filterStart: null,
  filterEnd: null,
  /** 'slider' | 'inputs' — which control last defined the visible window. */
  mode: 'slider',
  /**
   * Explicit scrubber domain. When null the scrubber spans
   * [now - historyHours, live]; when set it spans exactly this window.
   *
   * Without this, the scrubber range was implicitly derived from `historyHours`
   * and any time outside it was clamped away — which is why applying a time
   * filter (or focusing an outlook) could not move the scrubber.
   */
  domainStart: null,
  domainEnd: null,
  /** What the focused domain represents, shown on the timeline. */
  focusLabel: null,
  /** Which subsystem set the focus, for priority resolution. */
  focusSource: null,
  autoLatest: loadSetting('autoLatest', true),
  refreshMinutes: loadSetting('refreshMinutes', TUNING.refreshIntervalMinutes),
};

/* ------------------------------------------------------------------ *
 * Lightning
 * ------------------------------------------------------------------ */

/**
 * The stored strike lifespan, rejecting values the control could not produce.
 *
 * Focusing an outlook overrides the lifespan with that window's length, and it
 * used to persist that override — so a 23.98-hour outlook became the startup
 * default in every later session. The override no longer writes to storage;
 * this discards the ones already written. The panel steps in tenths of an hour,
 * so anything off that grid came from the override.
 */
function storedLifespan() {
  const value = Number(loadSetting('lightningLifespan', 3));
  if (!Number.isFinite(value) || value < 0.1) return 3;
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-6 ? value : 3;
}

export const lightning = {
  /**
   * All known strikes, sorted ascending by `ms`. Records are lean
   * (`{ ms, lat, lon }`) because the archives hold over 1.6 million of them.
   * De-duplication relies on the sort order rather than an index — see
   * lightning/source.js.
   */
  all: [],
  /** Strikes passing the active time filter — what the renderer draws. */
  filtered: [],
  lifespanHours: storedLifespan(),
  colorByAge: loadSetting('lightningColorByAge', true),
  showLayer: loadSetting('lightningShowLayer', true),
  heatmap: false,
  heatmapBlur: 30,
  counter: false,
  counterDensity: 50,
  showAll: false,
  sound: loadSetting('lightningSound', false),
  // On from the start. It was off by default from when it needed a library
  // fetched on demand to draw anything; the hull is computed in-house now, so
  // there is nothing to wait for and it is the reason the app exists.
  nowcast: loadSetting('lightningNowcast', true),
  nowcastConfidence: 0.1,
  lastUpdate: null,
};

/* ------------------------------------------------------------------ *
 * Runtime / performance
 * ------------------------------------------------------------------ */

export const runtime = {
  /** True between map movestart and a short settle after moveend. */
  interacting: false,
  /** True while a pointer or finger is dragging the time scrubber. */
  scrubbing: false,
  /** Bumped whenever a new render supersedes the previous one. */
  generation: 0,
  /** 'auto' | 'high' | 'low' */
  performanceMode: loadSetting('performanceMode', 'auto'),
  lowEnd: false,
  is3D: false,
  theme: loadSetting('theme', 'dark'),
  /** Counters surfaced in the diagnostics panel. */
  stats: { skippedFrames: 0, rendered: 0, failed: 0, probes: 0, cacheHits: 0 },
};

export function beginGeneration() {
  runtime.generation += 1;
  return runtime.generation;
}

export const isCurrentGeneration = (generation) => generation === runtime.generation;

/* ------------------------------------------------------------------ *
 * Persisted mutators
 * ------------------------------------------------------------------ */

export function setTheme(theme) {
  runtime.theme = theme;
  saveSetting('theme', theme);
  document.documentElement.dataset.theme = theme;
  emit(EVENTS.THEME_CHANGED, theme);
}

export function setPerformanceMode(mode) {
  runtime.performanceMode = mode;
  saveSetting('performanceMode', mode);
}

export function setHistoryHours(hours) {
  time.historyHours = hours;
  saveSetting('historyHours', hours);
}

/**
 * @param {object} options
 * @param {boolean} options.persist
 *   False for temporary overrides such as an outlook's window length, which
 *   must not become the next session's default.
 */
export function setLightningOption(key, value, { persist = true } = {}) {
  lightning[key] = value;
  if (!persist) return;
  const persisted = {
    lifespanHours: 'lightningLifespan',
    colorByAge: 'lightningColorByAge',
    showLayer: 'lightningShowLayer',
    sound: 'lightningSound',
    nowcast: 'lightningNowcast',
  }[key];
  if (persisted) saveSetting(persisted, value);
}

/**
 * Snapshot of layer selections, for the shareable URL hash and session restore.
 */
export function serialiseSelection() {
  const out = {};
  for (const [group, slot] of slots) {
    if (slot.enabled && slot.type) out[group] = { type: slot.type, opacity: slot.opacity };
  }
  return out;
}

const offeredIn = (group) => (LAYER_ORDER[group] || []).filter((entry) => typeof entry === 'string');
const isOffered = (group, type) => !!type && offeredIn(group).includes(type);
const firstOffered = (group) => offeredIn(group)[0] ?? null;

export function restoreSelection(data) {
  if (!data) return;
  for (const [group, entry] of Object.entries(data)) {
    const slot = slots.get(group);
    if (!slot || !entry) continue;
    slot.enabled = true;
    // A product retired since the session was saved is replaced by whatever the
    // group offers first, rather than quietly rendering something no picker
    // lists — which the panel could not correct until its card was built, and on
    // a phone the cards start collapsed.
    slot.type = isOffered(group, entry.type) ? entry.type : firstOffered(group) ?? entry.type;
    if (typeof entry.opacity === 'number') slot.opacity = entry.opacity;
  }
}
