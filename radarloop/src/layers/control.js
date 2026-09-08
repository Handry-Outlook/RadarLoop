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
import { slots, time, LAYER_GROUPS } from '../core/state.js';
import { getLayerDef } from '../data/layers.js';
import { applyOpacity, clearSlot, renderAll } from './renderer.js';
import { setMapsGLOpacity } from './mapsgl.js';
import { clearMirror, setMirrorOpacity, setMirrorOrder } from '../core/map3d.js';

/** Turns a layer group on or off. */
export function setLayerEnabled(group, enabled) {
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
    const slot = slots.get(g);
    return slot?.enabled && slot.type;
  }).reverse();
}

/**
 * Applies a new order. `topFirst` is the list as the user sees it, so it is
 * reversed back into draw order.
 */
export function setLayerOrder(topFirst) {
  const drawOrder = [...topFirst].reverse();
  // Groups not in the supplied list keep their relative position underneath.
  const rest = order.filter((g) => !drawOrder.includes(g));
  order = [...rest, ...drawOrder];
  applyOrder();
  emit(EVENTS.LAYER_ORDER, { order: [...order] });
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

export function resetLayerOrder() {
  order = [...LAYER_GROUPS];
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
    setPaneZ(group, z);
    setMirrorOrder(group, index);
  }
}

/** Group -> pane name, mirroring the renderer's mapping. */
export function paneFor(group) {
  switch (group) {
    case 'satellite': return 'satellitePane';
    case 'radar': return 'radarPane';
    case 'observation': return 'observationPane';
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
