/**
 * 3D mode — Mapbox GL with terrain, sky and extruded buildings.
 *
 * The Leaflet map stays authoritative for state; 3D is a second view onto the
 * same time and layer selection. Entering 3D copies the current camera across,
 * mirrors the active radar/satellite frames as raster sources, and draws strikes
 * as a GL layer. Leaving it returns the camera to Leaflet so the two never
 * disagree about where the user is looking.
 *
 * The GL context is created on first use and torn down when 3D is left, because
 * holding a second WebGL context open costs memory on every device and battery
 * on mobile.
 */

import { CREDENTIALS, MAP_DEFAULTS } from '../config.js';
import { ageStops as strikeAgeStops, strikeFreshColour, traceBolt } from '../lightning/render.js';
import { emit, EVENTS } from './bus.js';
import { runtime, slots } from './state.js';
import { getBasemap, map } from './map.js';
import { BASEMAPS } from '../data/basemaps.js';
import { bindGl, restoreReferenceMirror } from './mirror3d.js';
import { isCanvasBacked, remirrorAll } from '../layers/mirrorBridge.js';
import { getLayerDef } from '../data/layers.js';
import { DEPS } from './deps.js';

let gl = null;
let container = null;
let ready = false;
/** The style currently applied, so a no-op restyle is not requested. */
let currentStyle = null;

const STYLE_DARK = 'mapbox://styles/mapbox/dark-v11';
const STYLE_LIGHT = 'mapbox://styles/mapbox/light-v11';
const STYLE_SATELLITE = 'mapbox://styles/mapbox/satellite-streets-v12';

export const is3D = () => runtime.is3D;

/**
 * How much the mirrored composite is magnified on screen.
 *
 * The hidden 2D map is fitted to what the camera can see, and a pitched camera
 * sees far more than a flat view holds at the same scale — so the composite is
 * captured one to three zoom levels lower and GL stretches it back up. Anything
 * drawn at a fixed pixel size is stretched with it: a station model came out
 * twice its proper size at 45 degrees of pitch, four times at 60 and eight
 * times at 70. A drawing that wants to keep its size divides by this.
 */
export function mirrorMagnification() {
  if (!runtime.is3D || !gl) return 1;
  try {
    // Leaflet sits one zoom level ahead of GL for the same ground scale.
    return 2 ** ((gl.getZoom() + 1) - map.getZoom());
  } catch {
    return 1;
  }
}
export const getGl = () => gl;

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * The GL style to open with.
 *
 * The base map picker had no effect at all in 3D: whatever you chose in 2D, the
 * GL view used dark or light by theme and the `satellite` branch was never
 * reached by anything. Mapbox base maps now carry a native `glStyle`, so the
 * choice follows you into 3D.
 *
 * Non-Mapbox base maps (OpenTopoMap, Esri, MapTiler) have no GL equivalent, so
 * those fall back to the theme: Light in light mode, Dark otherwise.
*/
function styleFor(mode) {
  if (mode === 'satellite') return STYLE_SATELLITE;
  // Only an explicit choice carries over. The shipped default is a night style,
  // so honouring it unconditionally would open 3D dark for a light-mode user —
  // the opposite of what the theme asks for.
  const id = getBasemap();
  const chosen = id && id !== MAP_DEFAULTS.basemap ? BASEMAPS[id]?.glStyle : null;
  if (chosen) return chosen;
  return runtime.theme === 'light' ? STYLE_LIGHT : STYLE_DARK;
}

/** Creates the GL map, matching the Leaflet camera. */
function create(styleMode) {
  if (typeof mapboxgl === 'undefined') {
    console.warn('[3d] mapbox-gl is unavailable');
    return null;
  }
  mapboxgl.accessToken = CREDENTIALS.mapbox;

  const centre = map.getCenter();
  currentStyle = styleFor(styleMode);
  gl = new mapboxgl.Map({
    container,
    style: currentStyle,
    center: [centre.lng, centre.lat],
    // Leaflet and GL differ by one zoom level for the same scale.
    zoom: Math.max(1, map.getZoom() - 1),
    pitch: 55,
    bearing: -12,
    antialias: true,
    // Lets the rendered frame be read back — needed for screenshots and for the
    // geometric checks that verify mirrored layers land in the right place.
    preserveDrawingBuffer: true,
    attributionControl: true,
  });

  gl.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  // The still-image products are captured from the 2D map, which therefore has
  // to be pointed wherever the camera goes.
  gl.on('moveend', scheduleFollow);
  gl.on('resize', handleResize);

  gl.on('style.load', () => {
    addTerrain();
    addBuildings();
    ready = true;
    // A restyle discards every source; the mirror must forget what it had.
    bindGl(gl, true);
    // A restyle discards every source, including the coastline overlay.
    restoreReferenceMirror();
    emit(EVENTS.MAP3D_READY, { gl });
    // The camera starts pitched, so it already sees more than the 2D view did.
    scheduleFollow();
  });

  gl.on('error', (event) => {
    // A missing sprite or tile should not take the whole view down.
    console.warn('[3d]', event?.error?.message || event);
  });

  return gl;
}

function addTerrain() {
  if (!gl || gl.getSource('mapbox-dem')) return;
  try {
    gl.addSource('mapbox-dem', {
      type: 'raster-dem',
      url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
      tileSize: 512,
      maxzoom: 14,
    });
    gl.setTerrain({ source: 'mapbox-dem', exaggeration: 1.4 });
    gl.setFog({
      range: [1, 12],
      color: runtime.theme === 'light' ? '#dfe7f2' : '#0d1219',
      'high-color': runtime.theme === 'light' ? '#b9d0ea' : '#1a2536',
      'horizon-blend': 0.15,
      'space-color': runtime.theme === 'light' ? '#c8d8ee' : '#05070c',
      'star-intensity': runtime.theme === 'light' ? 0 : 0.35,
    });
  } catch (error) {
    console.warn('[3d] terrain unavailable:', error);
  }
}

/** Extruded buildings, which are what make the pitch read as 3D at street level. */
function addBuildings() {
  if (!gl || gl.getLayer('3d-buildings')) return;
  try {
    const layers = gl.getStyle()?.layers || [];
    // Insert beneath the first symbol layer so labels stay legible.
    const firstSymbol = layers.find((l) => l.type === 'symbol' && l.layout?.['text-field'])?.id;

    gl.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': runtime.theme === 'light' ? '#c7cfdb' : '#2a3444',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 15.5, ['get', 'height']],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 15.5, ['get', 'min_height']],
        'fill-extrusion-opacity': 0.75,
      },
    }, firstSymbol);
  } catch (error) {
    console.warn('[3d] building extrusions unavailable:', error);
  }
}

/* ------------------------------------------------------------------ *
 * Weather mirroring
 *
 * The per-kind GL representations live in core/mirror3d.js; this module owns the
 * lifecycle and re-exports them so callers have one 3D entry point.
 * ------------------------------------------------------------------ */

export {
  mirrorFrame,
  mirrorGeoJson,
  mirrorImage,
  clearMirror,
  setMirrorOpacity,
  setMirrorOrder,
  mirrorReady,
  mirroredGroups,
  setReferenceMirror,
  referenceMirrored,
  mirrorKind,
  toGlWmsTemplate,
} from './mirror3d.js';

/** A bolt icon for GL, drawn once and registered under a name. */
function ensureBoltIcon(map) {
  if (map.hasImage('wx-strike-bolt')) return 'wx-strike-bolt';
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  ctx.beginPath();
  traceBolt(ctx, half, half, half * 0.92);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(2,6,23,0.75)';
  ctx.stroke();
  ctx.fillStyle = strikeFreshColour();
  ctx.fill();
  map.addImage('wx-strike-bolt', ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
  return 'wx-strike-bolt';
}

/**
 * Draws the filtered strikes.
 *
 * The colours and the banding come from the 2D renderer rather than being
 * written out again. They were written out again, and went stale: the ramp here
 * was still gold-to-violet under a comment claiming it matched, long after 2D had
 * moved to the operational white-to-navy scale.
 *
 * A step expression, not an interpolation. 2D draws discrete bands, so a
 * gradient here would be a second way of not matching — and a gradient through a
 * ramp that crosses from red to blue passes through colours that are in neither.
 *
 * Strikes from the last minute are a bolt, as in 2D. Those are few, so they can
 * afford a symbol layer; the rest stay circles, which is the one thing 3D still
 * does differently — at these sizes a two-pixel circle and a two-pixel square are
 * the same handful of pixels, and a symbol layer for forty thousand of them is
 * not.
 */
export function setStrikes(strikes, { end, lifespanHours, freshSince = 0 }) {
  if (!gl || !ready) return;
  const sourceId = 'wx-strikes';
  const layerId = 'wx-strikes-layer';
  const freshSourceId = 'wx-strikes-fresh';
  const freshLayerId = 'wx-strikes-fresh-layer';

  const lifespanMs = Math.max(1, lifespanHours) * 3600 * 1000;
  const endMs = end instanceof Date ? end.getTime() : end;

  const aged = [];
  const fresh = [];
  for (const s of strikes) {
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { age: Math.min(1, Math.max(0, (endMs - s.ms) / lifespanMs)) },
    };
    (freshSince && s.ms >= freshSince ? fresh : aged).push(feature);
  }

  const data = { type: 'FeatureCollection', features: aged };
  const freshData = { type: 'FeatureCollection', features: fresh };

  // ['step', input, first, limit1, second, limit2, third, ...]
  const stops = strikeAgeStops();
  const colourExpression = ['step', ['get', 'age'], stops[0][1]];
  for (let i = 0; i < stops.length - 1; i += 1) colourExpression.push(stops[i][0], stops[i + 1][1]);

  try {
    const existing = gl.getSource(sourceId);
    if (existing) {
      existing.setData(data);
      gl.getSource(freshSourceId)?.setData(freshData);
      return;
    }
    gl.addSource(sourceId, { type: 'geojson', data });
    gl.addLayer({
      id: layerId,
      type: 'circle',
      source: sourceId,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 10, 5],
        'circle-color': colourExpression,
        'circle-opacity': 0.95,
        // The same dark edge the 2D marks carry, for the same reason: the
        // newest band is white and the base map underneath might be too.
        'circle-stroke-width': 0.8,
        'circle-stroke-color': 'rgba(2,6,23,0.55)',
      },
    });

    gl.addSource(freshSourceId, { type: 'geojson', data: freshData });
    gl.addLayer({
      id: freshLayerId,
      type: 'symbol',
      source: freshSourceId,
      layout: {
        'icon-image': ensureBoltIcon(gl),
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 10, 0.9],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  } catch (error) {
    console.warn('[3d] strike layer failed:', error);
  }
}

/* ------------------------------------------------------------------ *
 * Keeping the capture under the camera
 * ------------------------------------------------------------------ */

/**
 * The Windy composite and the OPERA grid are recoloured or reprojected by us, so
 * GL has no tile URL for them; they are mirrored as a still of whatever the 2D
 * map is showing. The 2D map used to be left wherever it was when 3D was
 * entered, which had two visible consequences: zooming out in 3D revealed radar
 * only over the area you happened to be looking at on entry, and the texture's
 * pixel size drifted with every zoom because it was fixed at the entry scale.
 *
 * So the hidden 2D map is pointed at what the camera can see, and the stills are
 * re-captured once it settles.
 */

/** Debounce on the camera move, so a flick of the wheel captures once. */
const FOLLOW_DEBOUNCE_MS = 90;
/** How long tiles for a new view are given to arrive before capturing again. */
const TILE_SETTLE_MS = 700;

/** Latitude limit of Web Mercator; a pitched camera can see past it. */
const MAX_LAT = 85.05112878;

/** How far below the camera's own scale the capture may drop, in zoom levels. */
const MAX_DETAIL_LOSS = 3;

let followTimer = 0;
let settleTimer = 0;

/** The geographic box the camera can currently see, clamped to what 2D can draw. */
function cameraBounds() {
  let bounds;
  try {
    bounds = gl.getBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;

  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  if (![sw.lat, sw.lng, ne.lat, ne.lng].every(Number.isFinite)) return null;

  const south = Math.max(-MAX_LAT, Math.min(sw.lat, ne.lat));
  const north = Math.min(MAX_LAT, Math.max(sw.lat, ne.lat));
  if (!(north > south)) return null;

  return L.latLngBounds(
    [south, Math.min(sw.lng, ne.lng)],
    [north, Math.max(sw.lng, ne.lng)],
  );
}

/**
 * The (fractional) zoom at which `bounds` fills the 2D map.
 *
 * Leaflet's own getBoundsZoom snaps down to a whole level, which cost a level of
 * detail even when the camera was flat and the two views already agreed.
 * Leaflet rounds the fractional value on setView, so a flat camera lands exactly
 * on its own zoom.
 */
function fitZoom(bounds) {
  const size = map.getSize();
  const nw = map.project(bounds.getNorthWest(), 0);
  const se = map.project(bounds.getSouthEast(), 0);
  const spanX = Math.max(1e-9, se.x - nw.x);
  const spanY = Math.max(1e-9, se.y - nw.y);
  return Math.log2(Math.min(size.x / spanX, size.y / spanY));
}

/** Points the hidden 2D map at the camera's view, at the best scale that covers it. */
function followCamera() {
  if (!gl || !runtime.is3D) return false;
  const bounds = cameraBounds();
  if (!bounds) return false;

  // Leaflet sits one zoom level ahead of GL for the same ground scale.
  const cameraZoom = gl.getZoom() + 1;
  let zoom = fitZoom(bounds);
  if (!Number.isFinite(zoom)) return false;

  // A pitched camera sees to the horizon, and fitting all of that would drop the
  // capture to world scale. Cover what we reasonably can and let the far field,
  // which is behind fog anyway, fall outside the still.
  zoom = Math.max(1, Math.min(cameraZoom, Math.max(zoom, cameraZoom - MAX_DETAIL_LOSS)));

  const centre = bounds.getCenter();
  const current = map.getCenter();
  const settled = Math.abs(map.getZoom() - zoom) < 0.01
    && Math.abs(current.lat - centre.lat) < 1e-6
    && Math.abs(current.lng - centre.lng) < 1e-6;
  if (settled) return false;

  map.setView(centre, zoom, { animate: false });
  return true;
}

/**
 * Re-captures the still-image products.
 *
 * Called twice on purpose: once immediately, so the view is not left holding a
 * stale still while tiles arrive, and again after they have had time to load.
 */
function recapture() {
  if (!runtime.is3D) return;
  remirrorAll({ canvasOnly: true });
}

/**
 * Captures again the moment the 2D layers finish loading tiles for the new view.
 *
 * The handler is removed before being re-added so a camera moved repeatedly does
 * not accumulate listeners for loads that never arrive.
 */
function recaptureWhenLoaded() {
  for (const [group, slot] of slots) {
    if (!slot.enabled || !slot.front) continue;
    if (!isCanvasBacked(getLayerDef(group, slot.type), slot.front)) continue;
    slot.front.off?.('load', recapture);
    slot.front.once?.('load', recapture);
  }
}

/** Debounced follow, bound to the camera's own move events. */
function scheduleFollow() {
  if (!runtime.is3D) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    const moved = followCamera();
    recapture();
    if (!moved) return;
    // Tiles for the new view are still arriving; capture again once they are in,
    // with a timer as a backstop for layers that never fire `load`.
    recaptureWhenLoaded();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(recapture, TILE_SETTLE_MS);
  }, FOLLOW_DEBOUNCE_MS);
}

/**
 * A viewport resize moves both views, but not in step.
 *
 * Every still is captured against the 2D container's size and the 2D bounds, and
 * Leaflet only learns it has been resized when it is told. Until then the
 * captured geometry describes the old viewport while GL has already adopted the
 * new one, so the mirrored layers — the MapsGL surface most visibly — slide
 * around. Telling Leaflet immediately, then re-following and re-capturing, keeps
 * the two in agreement.
 */
function handleResize() {
  if (!gl || !runtime.is3D) return;
  map.invalidateSize({ animate: false });
  scheduleFollow();
}


/** Stops the camera follow when 3D is left. */
function stopFollowing() {
  clearTimeout(followTimer);
  clearTimeout(settleTimer);
}

/* ------------------------------------------------------------------ *
 * Entering and leaving
 * ------------------------------------------------------------------ */

export async function enter3D(containerId = 'map-3d', { styleMode = 'default' } = {}) {
  if (runtime.is3D) return gl;
  container = document.getElementById(containerId);
  if (!container) return null;

  // Mapbox GL is 1.2 MB and reachable only through this button.
  try {
    await DEPS.mapbox();
  } catch (error) {
    console.warn('[3d] Mapbox GL failed to load:', error);
    return null;
  }

  document.getElementById('app')?.setAttribute('data-mode', '3d');
  runtime.is3D = true;
  // Registered with the mode rather than at import: this module is also loaded
  // directly by the Node-side tests, where there is no window to bind to.
  window.addEventListener('resize', handleResize, { passive: true });

  if (!gl) create(styleMode);
  else {
    const centre = map.getCenter();
    gl.jumpTo({ center: [centre.lng, centre.lat], zoom: Math.max(1, map.getZoom() - 1) });
    gl.resize();
    scheduleFollow();
  }

  emit(EVENTS.MODE_CHANGED, { mode: '3d' });
  return gl;
}

export function exit3D() {
  if (!runtime.is3D) return;
  stopFollowing();
  window.removeEventListener('resize', handleResize);

  // Carry the camera back so the two views stay in agreement.
  if (gl) {
    try {
      const c = gl.getCenter();
      map.setView([c.lat, c.lng], Math.round(gl.getZoom() + 1), { animate: false });
    } catch {
      /* GL view was never usable */
    }
  }

  document.getElementById('app')?.setAttribute('data-mode', '2d');
  runtime.is3D = false;

  destroy3D();
  map.invalidateSize({ animate: false });
  emit(EVENTS.MODE_CHANGED, { mode: '2d' });
}

export function destroy3D() {
  if (!gl) return;
  try {
    gl.remove();
  } catch (error) {
    console.warn('[3d] teardown failed:', error);
  }
  gl = null;
  ready = false;
  currentStyle = null;
  bindGl(null, false);
}

export async function toggle3D() {
  if (runtime.is3D) exit3D();
  else await enter3D();
  return runtime.is3D;
}

/** Re-styles the GL view after a theme change. */
export function refresh3DTheme() {
  if (!gl || !runtime.is3D) return;
  const next = styleFor('default');
  if (next === currentStyle) return;
  currentStyle = next;
  ready = false;
  bindGl(gl, false);
  try {
    // Terrain refers to a source the incoming style is about to discard, and
    // restyling with it still attached crashes the renderer. `style.load`
    // re-adds it against the new style.
    gl.setTerrain(null);
  } catch {
    /* no terrain attached */
  }
  gl.setStyle(next);
}

export const MAP3D_DEFAULTS = MAP_DEFAULTS;
