/**
 * Minimal synchronous event bus.
 *
 * The old code coupled subsystems by calling each other directly — the lightning
 * renderer called `updateLegend()`, which read DOM state owned by the layer code,
 * and so on. Subsystems now announce what happened and whoever cares subscribes.
 */

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

export function once(event, handler) {
  const dispose = on(event, (...args) => {
    dispose();
    handler(...args);
  });
  return dispose;
}

export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  // Copy so a handler that unsubscribes mid-dispatch cannot corrupt iteration.
  for (const handler of Array.from(set)) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[bus] handler for "${event}" failed:`, error);
    }
  }
}

/** Event name constants — keeps typos out of the wiring. */
export const EVENTS = {
  TIME_CHANGED: 'time:changed',
  TIME_COMMITTED: 'time:committed',
  /** The scrubber has been re-based onto a specific window, or released. */
  TIME_FOCUS: 'time:focus',
  ANIMATION_STATE: 'animation:state',
  LAYER_SELECTED: 'layer:selected',
  LAYER_TOGGLED: 'layer:toggled',
  LAYER_OPACITY: 'layer:opacity',
  LAYER_ORDER: 'layer:order',
  LAYER_RENDERED: 'layer:rendered',
  LAYER_FAILED: 'layer:failed',
  BASEMAP_CHANGED: 'basemap:changed',
  LIGHTNING_DATA: 'lightning:data',
  LIGHTNING_FILTERED: 'lightning:filtered',
  /** A lightning option changed programmatically; controls should re-sync. */
  LIGHTNING_OPTIONS: 'lightning:options',
  LEGEND_INVALIDATED: 'legend:invalidated',
  MAP_INTERACTION: 'map:interaction',
  MAP3D_READY: 'map3d:ready',
  MODE_CHANGED: 'mode:changed',
  THEME_CHANGED: 'theme:changed',
  STATUS: 'status',
  TOAST: 'toast',
};
