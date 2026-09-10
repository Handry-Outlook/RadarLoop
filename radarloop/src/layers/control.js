/**
 * The single entry point for changing what a layer group shows.
 *
 * Enabling, selecting a product, opacity and stacking order all funnel through
 * here so that every route into them — the layer cards, the search box, the
 * layer manager, the 3D fallback offer — behaves identically. Previously
 * `selectProduct` lived in the search UI and the enable path existed only as an
 * inline handler on the card, which is how they drifted apart.
 */

import { emit, EVENTS } from '../core/bus.js';
import { slots, time, LAYER_GROUPS, LAYER_LABELS } from '../core/state.js';
import { LAYER_Z } from '../config.js';
import { getLayerDef } from '../data/layers.js';
import { applyOpacity, clearSlot, renderAll } from './renderer.js';
import { setMapsGLOpacity } from './mapsgl.js';
import { clearMirror, setMirrorOpacity, setMirrorOrder } from '../core/map3d.js';
import { applyMapsGLPresentation } from './mapsgl.js';

/** Turns a layer group on or off. */
export function setLayerEnabled(group, enabled) {
  const external = externals.get(group);
  if (external) {
    if (external.isEnabled() === enabled) return;
    external.setEnabled(enabled);
    // Never moved by hand, so it takes its preset place rather than whatever
    // position being switched off left it in.
    if (enabled && !positioned.has(group)) {
      seatByPreset(group);
      applyOrder();
    }
    emit(EVENTS.LAYER_TOGGLED, { group, enabled });
    return;
  }

  const slot = slots.get(group);
  if (!slot || slot.enabled === enabled) return;

  slot.enabled = enabled;
  if (!enabled) {
    // Clear before announcing, so listeners see the cleared state.
    clearSlot(group);
    clearMirror(group);
  }
  emit(EVENTS.LAYER_TOGGLED, { group, enabled });
  renderAll(time.current);
}

/** Switches a group to a different product, enabling it if needed. */
export function selectProduct(group, type) {
  const slot = slots.get(group);
  if (!slot) return;

  // A different product invalidates everything drawn for this slot, in both views.
  clearSlot(group);
  clearMirror(group);

  slot.enabled = true;
  slot.type = type;
  slot.frameKey = null;

  emit(EVENTS.LAYER_SELECTED, { group, type });
  renderAll(time.current);
}

export function setLayerOpacity(group, opacity) {
  const external = externals.get(group);
  if (external) {
    external.setOpacity(opacity);
    emit(EVENTS.LAYER_OPACITY, { group, opacity });
    return;
  }

  const slot = slots.get(group);
  if (!slot) return;
  slot.opacity = opacity;
  applyOpacity(group);
  setMapsGLOpacity(group, opacity);
  setMirrorOpacity(group, opacity);
  emit(EVENTS.LAYER_OPACITY, { group, opacity });
}

/* ------------------------------------------------------------------ *
 * Stacking order
 * ------------------------------------------------------------------ */

/**
 * The draw order of the active groups, bottom first.
 *
 * `LAYER_GROUPS` gives the default; a user reorder is stored as an explicit
 * list. Only the relative order matters — z-indexes are recomputed from it.
 */
let order = [...LAYER_GROUPS];

export const layerOrder = () => [...order];

/** Active groups in draw order, top of the stack first (as a list reads). */
export function activeInOrder() {
  return order.filter((g) => {
    const external = externals.get(g);
    if (external) return !!external.isEnabled();
    const slot = slots.get(g);
    return slot?.enabled && slot.type;
  }).reverse();
}

/**
 * Applies a new order. `topFirst` is the list as the user sees it, so it is
 * reversed back into draw order.
 */
export function setLayerOrder(topFirst) {
  for (const id of topFirst) positioned.add(id);
  const drawOrder = [...topFirst].reverse();
  // Groups not in the supplied list keep their relative position underneath.
  const rest = order.filter((g) => !drawOrder.includes(g));
  order = [...rest, ...drawOrder];
  applyOrder();
  emit(EVENTS.LAYER_ORDER, { order: [...order] });
}

/* ------------------------------------------------------------------ *
 * Overlays that behave like layers but are not catalog products
 * ------------------------------------------------------------------ */

/**
 * The outlook polygons and anything drawn with the polygon tool are real map
 * overlays, but they have no catalog product behind them, so they never appeared
 * in the layer list and their stacking could not be changed. Rather than forcing
 * them through the tile pipeline — which would mean a slot, a frame resolver and
 * a product picker for something that has none of those — they register here and
 * take part in ordering, visibility and opacity like anything else.
 *
 * A descriptor supplies:
 *   id         stable key, also used in the saved order
 *   label      shown in the layer list
 *   group      the muted line under it
 *   accent     colour of the row's left edge
 *   defaultZ   where it sits before the user reorders anything
 *   isEnabled/setEnabled, getOpacity/setOpacity, applyZ
 */
const externals = new Map();

export const isExternalLayer = (id) => externals.has(id);
export const externalLayer = (id) => externals.get(id) || null;

/** Preset stacking position, used only to place a layer on first registration. */
const presetZ = (id) => externals.get(id)?.defaultZ ?? LAYER_Z[id] ?? 300;

/**
 * Layers the user has deliberately positioned.
 *
 * `setLayerOrder` drops everything not currently active to the bottom of the
 * stack, which is harmless for a weather group that is switched off but wrong
 * for an overlay that appears later: the first shape you drew turned up
 * underneath everything. An overlay the user has never moved is re-seated at its
 * preset when it becomes visible.
 */
const positioned = new Set();

function seatByPreset(id) {
  const at = order.indexOf(id);
  if (at >= 0) order.splice(at, 1);
  const target = order.findIndex((other) => presetZ(other) > presetZ(id));
  if (target < 0) order.push(id);
  else order.splice(target, 0, id);
}

/**
 * Brings an overlay that has just appeared to the top of the stack.
 *
 * The drawn shapes become visible the moment the first polygon closes, without
 * anyone switching them on, and they were inheriting whatever position an
 * inactive entry had drifted to — underneath the weather, where a shape you just
 * drew is invisible.
 *
 * The top, not the preset: presets place a layer at registration, before anyone
 * has reordered anything, and seating against a list the user has since
 * rearranged puts it somewhere arbitrary. Something you have this second drawn
 * belongs on top.
 */
export function bringOverlayToFront(id) {
  if (!externals.has(id) || positioned.has(id)) return;
  const at = order.indexOf(id);
  if (at >= 0) order.splice(at, 1);
  order.push(id);
  applyOrder();
}

export function registerExternalLayer(descriptor) {
  if (!descriptor?.id) return;
  externals.set(descriptor.id, descriptor);

  // `order` runs bottom-to-top, so the layer goes in front of the first entry
  // that is meant to sit above it. This is what puts the automated outlook above
  // satellite and below radar without hard-coding neighbours.
  if (!order.includes(descriptor.id)) seatByPreset(descriptor.id);
  applyOrder();
}

/** Everything the layer list needs about one entry, slot or overlay. */
export function layerView(id) {
  const external = externals.get(id);
  if (external) {
    return {
      title: external.label,
      meta: external.group || 'Overlay',
      accent: external.accent || 'var(--wx-outlook)',
      opacity: external.getOpacity?.() ?? 1,
      external: true,
    };
  }
  const slot = slots.get(id);
  const def = slot ? getLayerDef(id, slot.type) : null;
  return {
    title: def?.label || slot?.type || id,
    meta: LAYER_LABELS[id] || id,
    accent: null,
    opacity: slot?.opacity ?? 1,
    external: false,
  };
}

/**
 * Moves one group up or down within the active stack.
 * @param {number} delta -1 moves it towards the top of the list
 */
export function moveLayer(group, delta) {
  const active = activeInOrder();
  const index = active.indexOf(group);
  if (index < 0) return false;
  const target = index + delta;
  if (target < 0 || target >= active.length) return false;

  const next = [...active];
  next.splice(index, 1);
  next.splice(target, 0, group);
  setLayerOrder(next);
  return true;
}

/**
 * Restores the default stacking.
 *
 * `LAYER_GROUPS` is only the catalog groups, so assigning it wholesale dropped
 * every registered overlay — the station models, the outlooks, anything drawn —
 * out of `order` entirely. They stayed on the map, because nothing had removed
 * their layers, but `activeInOrder` reads `order`, so their rows vanished from
 * the list: cards gone, map unchanged. Each one is re-seated at its preset
 * instead, which is where it would have been had nobody moved anything.
 *
 * The record of what the user positioned by hand goes too. A reset means the
 * arrangement is forgotten, and keeping those marks would leave an overlay
 * pinned to wherever it last sat the next time it appeared.
 */
export function resetLayerOrder() {
  positioned.clear();
  order = [...LAYER_GROUPS];
  for (const id of externals.keys()) seatByPreset(id);
  applyOrder();
  emit(EVENTS.LAYER_ORDER, { order: [...order] });
}

/**
 * Writes the order back onto the panes.
 *
 * Each group owns a pane, and panes are ordered by z-index, so re-stacking is a
 * matter of renumbering them. The base spacing leaves room between groups for
 * the outlook fills that deliberately interleave with the weather.
 */
const BASE_Z = 140;
const STEP = 4;

export function applyOrder() {
  for (const [index, group] of order.entries()) {
    const z = BASE_Z + index * STEP;
    const slot = slots.get(group);
    if (slot) slot.zIndex = z;
    externals.get(group)?.applyZ(z);
    setPaneZ(group, z);
    setMirrorOrder(group, index);
    // MapsGL owns its own canvas outside the pane stack, so it has to be moved
    // explicitly or it stays pinned below every weather pane.
    applyMapsGLPresentation();
  }
}

/** Group -> pane name, mirroring the renderer's mapping. */
export function paneFor(group) {
  switch (group) {
    case 'satellite': return 'satellitePane';
    case 'radar': return 'radarPane';
    case 'observation': return 'observationPane';
    case 'roadWeather': return 'roadWeatherPane';
    case 'isobar': return 'isobarPane';
    case 'surfaceFront': return 'frontPane';
    case 'warning': return 'warningPane';
    default: return 'overlayPane';
  }
}

let mapRef = null;
/** Injected to avoid a cycle between the map module and this one. */
export function bindMap(map) {
  mapRef = map;
}

function setPaneZ(group, z) {
  const name = paneFor(group);
  // overlayPane is shared by several groups; its own order is not meaningful.
  if (!mapRef || name === 'overlayPane' || name === 'warningPane') return;
  const pane = mapRef.getPane(name);
  if (pane) pane.style.zIndex = String(z);
}

/** Human label for a group's current product. */
export function describeLayer(group) {
  const slot = slots.get(group);
  if (!slot?.type) return null;
  const def = getLayerDef(group, slot.type);
  return def?.label || slot.type;
}
