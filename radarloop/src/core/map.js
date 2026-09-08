/**
 * Map lifecycle: the Leaflet instance, its pane stack, base map switching and the
 * lazily-created WebGL engines (Mapbox GL for 3D, Aeris MapsGL for GPU layers).
 *
 * The interaction brake lives here too. While the user is panning or zooming we
 * suspend weather re-rendering; resuming it on a settle timer is what keeps the
 * map responsive under a heavy layer stack.
 */

import { DEVICE, MAP_DEFAULTS, PANES, CREDENTIALS } from '../config.js';
import { emit, on, EVENTS } from './bus.js';
import { runtime } from './state.js';
import { BASEMAPS, REFERENCE_OVERLAY } from '../data/basemaps.js';
import { setReferenceMirror } from './mirror3d.js';

/**
 * The Leaflet map.
 *
 * Created at module-evaluation time rather than inside `initMap`, so it is a
 * `const` and not a rebound export. That matters: a mutable `export let` is a
 * live binding under native ES modules but is trivially mis-bundled into a
 * by-value snapshot, and every importer would then hold `null` forever.
 * The application entry script runs after the document body, so the container
 * is guaranteed to exist here.
 */
function createMap(containerId = 'map') {
  // Leaflet defaults tuned for the device before any layer is created.
  L.Map.mergeOptions({
    preferCanvas: true,
    zoomAnimation: !DEVICE.mobile,
    fadeAnimation: !DEVICE.mobile,
    markerZoomAnimation: !DEVICE.mobile,
  });
  L.GridLayer.mergeOptions({
    updateWhenIdle: DEVICE.mobile,
    updateWhenZooming: !DEVICE.mobile,
    keepBuffer: DEVICE.mobile ? 1 : 2,
  });

  const container = document.getElementById(containerId);
  if (!container) throw new Error(`[map] container #${containerId} is missing`);

  const instance = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    minZoom: MAP_DEFAULTS.minZoom,
    maxZoom: MAP_DEFAULTS.maxZoom,
    worldCopyJump: true,
  }).setView(MAP_DEFAULTS.center, MAP_DEFAULTS.zoom);

  // The default 'Leaflet' prefix is library branding, not a data credit.
  instance.attributionControl.setPrefix('');

  return instance;
}

/** @type {L.Map} */
export const map = createMap();

/** Canvas renderers shared by the vector overlays, created once. */
export const renderers = {};

const basemapCache = new Map();
let activeBasemapId = null;
let referenceLayer = null;

/* ------------------------------------------------------------------ *
 * Initialisation
 * ------------------------------------------------------------------ */

/** Panes, renderers, the initial base map and the interaction brake. */
export function initMap() {
  createPanes();
  createRenderers();
  setBasemap(MAP_DEFAULTS.basemap);
  setReferenceOverlay(true);
  installInteractionBrake();

  return map;
}

function createPanes() {
  for (const { name, z, parent, clickThrough } of PANES) {
    if (!map.getPane(name)) {
      map.createPane(name, parent ? map.getPane(parent) : undefined);
    }
    const pane = map.getPane(name);
    pane.style.zIndex = String(z);
    if (clickThrough) pane.style.pointerEvents = 'none';
  }
}

function createRenderers() {
  renderers.nowcastFill = L.canvas({ pane: 'nowcastFillPane', padding: 0.35 });
  renderers.nowcastOutline = L.canvas({ pane: 'nowcastOutlinePane', padding: 0.35 });
  renderers.publishedFill = L.canvas({ pane: 'publishedOutlookFillPane', padding: 0.35 });
  renderers.publishedOutline = L.canvas({ pane: 'publishedOutlookOutlinePane', padding: 0.35 });
  renderers.hocoFill = L.canvas({ pane: 'hocoFillPane', padding: 0.35 });
  renderers.hocoOutline = L.canvas({ pane: 'hocoOutlinePane', padding: 0.35 });
  renderers.lightning = L.canvas({ pane: 'lightningPane', padding: 0.2 });
}

/* ------------------------------------------------------------------ *
 * Base maps
 * ------------------------------------------------------------------ */

function buildBasemap(id) {
  const def = BASEMAPS[id];
  if (!def) return null;
  if (def.kind === 'maptiler') {
    if (!L.maptiler?.maptilerLayer) return null;
    const style = def.style.split('.').reduce((acc, part) => acc?.[part], L.maptiler.MapStyle);
    return L.maptiler.maptilerLayer({
      apiKey: CREDENTIALS.maptiler,
      attribution: '© MapTiler © OpenStreetMap contributors',
      style,
    });
  }
  return L.tileLayer(def.url, { ...def.options, zIndex: 1 });
}

export function setBasemap(id) {
  if (!BASEMAPS[id] || id === activeBasemapId) return;
  let layer = basemapCache.get(id);
  if (!layer) {
    layer = buildBasemap(id);
    if (!layer) {
      console.warn(`[map] base map "${id}" is unavailable`);
      return;
    }
    basemapCache.set(id, layer);
  }
  const previous = activeBasemapId ? basemapCache.get(activeBasemapId) : null;
  layer.addTo(map);
  layer.bringToBack();
  if (previous && previous !== layer) map.removeLayer(previous);
  activeBasemapId = id;
  emit(EVENTS.BASEMAP_CHANGED, { id, dark: !!BASEMAPS[id].dark });
}

export const getBasemap = () => activeBasemapId;

let referenceEnabled = true;

export function setReferenceOverlay(enabled) {
  referenceEnabled = enabled;
  if (enabled) {
    if (!referenceLayer) referenceLayer = L.tileLayer(REFERENCE_OVERLAY.url, REFERENCE_OVERLAY.options);
    referenceLayer.addTo(map);
  } else if (referenceLayer) {
    map.removeLayer(referenceLayer);
  }
  // The 3D view needs its own copy; it cannot share a Leaflet layer.
  setReferenceMirror(enabled);
}

export const isReferenceOverlayEnabled = () => referenceEnabled;

/* ------------------------------------------------------------------ *
 * Interaction brake
 * ------------------------------------------------------------------ */

let settleTimer = null;

/**
 * Weather work is suspended while the map is being manipulated and resumes a
 * short time after it settles. Without this, a pan issues a fresh tile request
 * storm on every animation frame and the map feels like treacle.
 */
function installInteractionBrake() {
  const begin = () => {
    clearTimeout(settleTimer);
    if (runtime.interacting) return;
    runtime.interacting = true;
    emit(EVENTS.MAP_INTERACTION, { interacting: true });
  };
  const end = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      runtime.interacting = false;
      emit(EVENTS.MAP_INTERACTION, { interacting: false });
    }, DEVICE.mobile ? 220 : 140);
  };

  map.on('movestart zoomstart dragstart', begin);
  map.on('moveend zoomend dragend', end);
}

/** Resolves once the map is no longer being panned or zoomed. */
export function whenSettled() {
  if (!runtime.interacting) return Promise.resolve();
  return new Promise((resolve) => {
    const dispose = on(EVENTS.MAP_INTERACTION, (payload) => {
      if (payload.interacting) return;
      dispose();
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ *
 * WebGL engines — created on demand, disposed when idle
 * ------------------------------------------------------------------ */

let mapsglController = null;
let mapsglIdleTimer = null;
let map3d = null;
let map3dIdleTimer = null;

/**
 * Aeris MapsGL shares the Leaflet viewport. Holding its GPU context open for the
 * whole session costs memory on every device and battery on mobile, so it is
 * created on first use and released once nothing needs it.
 */
/** Canvases the controller added, so teardown can detach them. */
let mapsglCanvases = [];

function canvasesInOverlay() {
  const pane = map.getPane('overlayPane');
  return pane ? [...pane.querySelectorAll(':scope > canvas')] : [];
}

/**
 * The render surfaces MapsGL owns.
 *
 * 3D has no tile URL for a MapsGL product — the controller draws every one of
 * its layers into this one canvas — so the mirror captures the canvas instead,
 * and needs to know which element that is.
 */
export const mapsglSurfaces = () => mapsglCanvases.filter((c) => c.isConnected);

export function ensureMapsGL() {
  clearTimeout(mapsglIdleTimer);
  if (mapsglController) return mapsglController;

  // The controller injects its own render surface; note what it adds so the
  // element can be detached later. `dispose()` releases the GL context but
  // leaves the canvas in the DOM, where it would accumulate on repeated use.
  const before = new Set(canvasesInOverlay());

  try {
    const account = new aerisweather.mapsgl.Account(CREDENTIALS.xweatherId, CREDENTIALS.xweatherSecret);
    mapsglController = new aerisweather.mapsgl.LeafletMapController(map, { account });
  } catch (error) {
    console.error('[map] MapsGL initialisation failed:', error);
  }

  // The surface may appear a tick later, so check again once settled.
  const capture = () => {
    mapsglCanvases = canvasesInOverlay().filter((c) => !before.has(c));
  };
  capture();
  setTimeout(capture, 1500);

  window.__mapsglController = mapsglController;
  return mapsglController;
}

/**
 * Resolves once the MapsGL controller can accept layers.
 *
 * Construction is asynchronous: the controller sets up its own GL surface and
 * rejects `addWeatherLayer` until then with "Map controller is not initialized".
 * Calling it immediately after construction therefore threw, the layer was never
 * registered, and — because nothing tracked it — the controller and its
 * full-map canvas were never torn down either. That is what a MapsGL layer
 * "failing to turn off" actually was.
 */
export function whenMapsGLReady({ timeoutMs = 10000 } = {}) {
  const controller = ensureMapsGL();
  if (!controller) return Promise.resolve(null);
  if (controller.isReady) return Promise.resolve(controller);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(controller);
    };

    try {
      controller.addEventListener?.('load', finish);
      controller.on?.('load', finish);
    } catch {
      /* SDK build without an event surface — the poll below covers it */
    }
    // Belt and braces: the event name has changed between SDK versions.
    const poll = setInterval(() => {
      if (controller.isReady) finish();
    }, 120);
    const timer = setTimeout(finish, timeoutMs);
  });
}

export function releaseMapsGL(delayMs = 30000) {
  clearTimeout(mapsglIdleTimer);
  mapsglIdleTimer = setTimeout(() => {
    if (!mapsglController) return;
    try {
      // The SDK's teardown is `dispose()`. An earlier `destroy?.()` matched
      // nothing and, being optional-chained, failed silently — so the
      // controller and its full-map canvas survived every attempt to remove it.
      if (typeof mapsglController.dispose === 'function') mapsglController.dispose();
      else if (typeof mapsglController.remove === 'function') mapsglController.remove();
      else console.warn('[map] MapsGL exposes no teardown method');
    } catch (error) {
      console.warn('[map] MapsGL teardown failed:', error);
    }

    // dispose() frees the GL context but leaves the canvas element behind.
    for (const canvas of mapsglCanvases) canvas.remove();
    mapsglCanvases = [];

    mapsglController = null;
    window.__mapsglController = null;
  }, delayMs);
}

export const getMapsGL = () => mapsglController;

export function ensureMap3D(containerId = 'map-3d') {
  clearTimeout(map3dIdleTimer);
  if (map3d) return map3d;
  mapboxgl.accessToken = CREDENTIALS.mapbox;
  const centre = map.getCenter();
  map3d = new mapboxgl.Map({
    container: containerId,
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [centre.lng, centre.lat],
    zoom: map.getZoom() - 1,
    pitch: 55,
    bearing: -12,
    antialias: true,
  });
  return map3d;
}

export function releaseMap3D(delayMs = 30000) {
  clearTimeout(map3dIdleTimer);
  map3dIdleTimer = setTimeout(() => {
    if (!map3d) return;
    try {
      map3d.remove();
    } catch (error) {
      console.warn('[map] 3D teardown failed:', error);
    }
    map3d = null;
  }, delayMs);
}

export const getMap3D = () => map3d;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export function safeRemove(layer) {
  try {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  } catch {
    /* layer already detached */
  }
}

export function setLayerOpacity(layer, value) {
  if (!layer) return;
  if (typeof layer.setOpacity === 'function') layer.setOpacity(value);
  else if (typeof layer.setStyle === 'function') layer.setStyle({ opacity: value, fillOpacity: value });
  else if (layer.getElement?.()) layer.getElement().style.opacity = String(value);
}

/** Recomputes the map size after a panel resize, but only when it changed. */
let lastSize = '';
export function invalidateSizeIfChanged() {
  if (!map) return;
  const container = map.getContainer();
  const size = `${container.clientWidth}x${container.clientHeight}`;
  if (size === lastSize) return;
  lastSize = size;
  map.invalidateSize({ animate: false });
}
