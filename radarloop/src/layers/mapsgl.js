/**
 * Aeris MapsGL products (hail probability and size, lightning density, threats).
 *
 * These are GPU layers owned by the MapsGL controller rather than Leaflet
 * layers, so they are tracked separately from the tile slots. The controller
 * renders every one of its layers into a single shared canvas that it owns, so
 * "removing a layer" and "removing the canvas" are different operations — the
 * canvas only goes when the controller itself is disposed.
 */

import { getMapsGL, releaseMapsGL, whenMapsGLReady } from '../core/map.js';
import { emit, EVENTS } from '../core/bus.js';

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

  // The controller's canvas stays on the map for as long as the controller
  // lives, so with nothing left to draw it is torn down promptly rather than on
  // a long idle timer — otherwise switching a MapsGL layer off leaves its
  // surface sitting over the map.
  if (active.size === 0) releaseMapsGL(1200);
}

export function setMapsGLOpacity(group, opacity) {
  const layerId = active.get(group);
  const controller = getMapsGL();
  if (!layerId || !controller) return;
  try {
    controller.setLayerOpacity?.(layerId, opacity);
  } catch {
    /* older SDK builds do not expose per-layer opacity */
  }
}

export const activeMapsGLLayers = () => Array.from(active.values());
export const hasMapsGLLayers = () => active.size > 0;
