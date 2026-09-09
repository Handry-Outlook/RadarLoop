/**
 * Aeris MapsGL products (hail probability and size, lightning density, threats).
 *
 * These are GPU layers owned by the MapsGL controller rather than Leaflet
 * layers, so they are tracked separately from the tile slots. The controller
 * renders every one of its layers into a single shared canvas that it owns, so
 * "removing a layer" and "removing the canvas" are different operations — the
 * canvas only goes when the controller itself is disposed.
 */

import { getMapsGL, mapsglSurfaces, releaseMapsGL, whenMapsGLReady } from '../core/map.js';
import { emit, EVENTS } from '../core/bus.js';
import { slots } from '../core/state.js';

/** group -> MapsGL layer id currently added. */
const active = new Map();

export async function renderMapsGLLayer(group, type, slot, def) {
  // MapsGL identifies products by its own id, which is not always the catalog key.
  const layerId = def?.id || type;

  const previous = active.get(group);
  if (previous === layerId) {
    setMapsGLOpacity(group, slot.opacity);
    return;
  }

  // Record the intent before the (asynchronous) add, so that switching the layer
  // off while the controller is still starting up still tears it down.
  active.set(group, layerId);

  const controller = await whenMapsGLReady();
  if (!controller) {
    active.delete(group);
    return;
  }
  if (previous) removeMapsGLLayer(controller, previous);

  // The user may have switched away while we waited.
  if (active.get(group) !== layerId) return;

  try {
    controller.addWeatherLayer(layerId, { opacity: slot.opacity });
    // The surface is created asynchronously, so presentation is applied again
    // once it exists rather than only on the frame the layer was added.
    applyMapsGLPresentation();
    for (const delay of [400, 1200, 2400]) setTimeout(applyMapsGLPresentation, delay);
    emit(EVENTS.LAYER_RENDERED, { group, type, mapsgl: true });
  } catch (error) {
    console.warn(`[mapsgl] could not add "${layerId}":`, error);
    active.delete(group);
    if (active.size === 0) releaseMapsGL(1200);
  }
}

/**
 * Removes one weather layer, verifying it actually went.
 *
 * The SDK exposes several removal methods and a silent no-op is easy to miss,
 * so `hasWeatherLayer` is used as the check rather than trusting the call.
 */
function removeMapsGLLayer(controller, layerId) {
  const gone = () => {
    try {
      return typeof controller.hasWeatherLayer === 'function'
        ? !controller.hasWeatherLayer(layerId)
        : true;
    } catch {
      return true;
    }
  };

  for (const method of ['removeWeatherLayer', 'removeLayer', 'removeSource']) {
    if (typeof controller[method] !== 'function') continue;
    try {
      controller[method](layerId);
    } catch (error) {
      console.warn(`[mapsgl] ${method}("${layerId}") failed:`, error);
    }
    if (gone()) return true;
  }

  console.warn(`[mapsgl] "${layerId}" could not be removed`);
  return false;
}

export function clearMapsGLLayer(group) {
  const layerId = active.get(group);
  if (!layerId) return;
  const controller = getMapsGL();
  if (controller) removeMapsGLLayer(controller, layerId);
  active.delete(group);
  applyMapsGLPresentation();

  // The controller's canvas stays on the map for as long as the controller
  // lives, so with nothing left to draw it is torn down promptly rather than on
  // a long idle timer — otherwise switching a MapsGL layer off leaves its
  // surface sitting over the map.
  if (active.size === 0) releaseMapsGL(1200);
}

/**
 * Applies opacity and stacking to the MapsGL render surface.
 *
 * The SDK has no working per-layer opacity in this build. `setLayerOpacity` does
 * not exist on the controller at all — the previous call was optional-chained
 * and so silently did nothing — and `setPaintProperty`, `getWeatherLayer` and
 * `findLayer` either return nothing for a weather layer id or leave the surface
 * untouched. The one thing that does work is the canvas element, so opacity is
 * applied there.
 *
 * Stacking has the same root. The controller injects its canvas as a direct
 * child of Leaflet's overlay pane, where it lands at z-index 100 while every
 * weather pane sits at 140 and above — which is why MapsGL products always drew
 * underneath everything else regardless of the layer order. The canvas is given
 * the z-index of the group it is drawing for, so the layer-order tab moves it
 * like any other layer.
 *
 * One surface serves every MapsGL layer, so with products active in two groups
 * at once they share one opacity and one stacking position: the highest z-index
 * of the active groups wins, and so does the opacity that goes with it. That is
 * a limit of the SDK's single-canvas design, not a choice.
 */
export function applyMapsGLPresentation() {
  const surfaces = mapsglSurfaces();
  if (!surfaces.length) return;

  let opacity = 1;
  let zIndex = 0;
  for (const group of active.keys()) {
    const slot = slots.get(group);
    if (!slot?.enabled) continue;
    const z = slot.zIndex || 0;
    if (z >= zIndex) {
      zIndex = z;
      opacity = slot.opacity ?? 1;
    }
  }

  for (const canvas of surfaces) {
    canvas.style.opacity = String(opacity);
    if (zIndex) canvas.style.zIndex = String(zIndex);
  }
}

export function setMapsGLOpacity(group, opacity) {
  const slot = slots.get(group);
  if (slot) slot.opacity = opacity;
  applyMapsGLPresentation();
}

export const activeMapsGLLayers = () => Array.from(active.values());
export const hasMapsGLLayers = () => active.size > 0;
