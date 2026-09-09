/**
 * Bridges a rendered 2D layer into the 3D view.
 *
 * Tile products can be handed to GL as a source directly. Products we render
 * ourselves onto a canvas — the recoloured Windy composite and the reprojected
 * OPERA grid — have no tile URL GL could use, so their finished pixels are
 * captured for the current viewport and pinned as a geographic image.
 *
 * The capture is deliberately viewport-sized and refreshed when the view
 * settles, matching what the 2D OPERA layer already does. It is a still of the
 * current frame, not a live tile pipeline.
 */

import { map, mapsglSurfaces } from '../core/map.js';
import {
  clearMirror, mirrorCanvas, mirrorFrame, mirrorGeoJson, mirrorImage, mirrorReady, OVERLAY_PREFIX,
} from '../core/mirror3d.js';
import { devicePixelRatioStep as captureRatio, recolourTile } from './windy.js';
import { slots } from '../core/state.js';
import { getLayerDef } from '../data/layers.js';

/** Bounds of the Leaflet view, in the shape mirrorImage expects. */
function viewBounds() {
  const b = map.getBounds();
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

/**
 * Composites a Windy tile layer's canvas tiles into one viewport image.
 *
 * Each tile is already recoloured on its own canvas, so this only has to place
 * them at their screen positions and read the result back.
 */
/** Counters for the 3D diagnostics; see window.RadarLoop.mirrorStats(). */
export const stats = {
  attempts: 0, captured: 0, noTiles: 0, noneDrawn: 0, tainted: 0, mirrored: 0,
  lastBytes: 0, lastDrew: 0,
  /** Geometry of the most recent capture, for placement diagnostics. */
  lastCapture: null,
};

const TILE_SIZE = 256;

/**
 * Where a tile belongs inside the captured image.
 *
 * Placement is computed from the tile's own coordinates through the map
 * projection, **not** from where Leaflet put its element in the DOM.
 *
 * This is the fix for the misplaced 3D radar. `L.DomUtil.getPosition(tile)`
 * returns a position relative to the tile *level* container, which carries its
 * own translation (and, mid-zoom, a scale). Subtracting only the map-pane origin
 * therefore leaves that container's offset in, so every tile landed at a
 * constant offset from where it belonged — the whole composite shifted.
 *
 * Working in projected pixels at a single zoom is exact and immune to whatever
 * Leaflet is doing with its containers.
 *
 * @param {{x:number,y:number,z:number}} coords tile coordinates
 * @param {{x:number,y:number}} originPx projected pixel of the image's top-left
 * @param {number} zoom zoom the projection is taken at
 */
export function tilePlacement(coords, originPx, zoom) {
  // A tile at zoom z covers 2^(zoom - z) times as many pixels at `zoom`.
  const scale = 2 ** (zoom - coords.z);
  const span = TILE_SIZE * scale;
  return {
    x: coords.x * span - originPx.x,
    y: coords.y * span - originPx.y,
    w: span,
    h: span,
  };
}

/**
 * How finely a capture is sampled.
 *
 * The mirrored composite has to hold up against the 2D view, so it is captured
 * at the same device pixel ratio the tiles were rendered at: with `scale === dpr`
 * each tile's backing store lands 1:1 in the composite and nothing is resampled.
 *
 * The only ceiling is the GPU's own — a texture wider than `MAX_TEXTURE_SIZE` is
 * rejected outright — so that value is queried once and used as the cap instead
 * of an arbitrary edge length. An earlier version capped at 1280px to make
 * scrubbing bearable, which visibly softened the radar in 3D; the cost that
 * bought is now paid by the tile workers instead.
 */
let maxTextureEdge = 0;

function textureLimit() {
  if (maxTextureEdge) return maxTextureEdge;
  maxTextureEdge = 4096;
  try {
    const probe = document.createElement('canvas');
    const ctx = probe.getContext('webgl2') || probe.getContext('webgl');
    const value = ctx?.getParameter(ctx.MAX_TEXTURE_SIZE);
    // Clamped at 8192 regardless: beyond that the upload cost outgrows any
    // detail a raster overlay can show.
    if (Number.isFinite(value) && value >= 2048) maxTextureEdge = Math.min(value, 8192);
  } catch {
    /* no WebGL context available; the conservative default stands */
  }
  return maxTextureEdge;
}


/** One reusable canvas per group — a canvas source must keep the same element. */
const captureCanvases = new Map();

function canvasFor(group, width, height) {
  let canvas = captureCanvases.get(group);
  if (!canvas) {
    canvas = document.createElement('canvas');
    captureCanvases.set(group, canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/**
 * Composites a Windy tile layer's canvas tiles into one canvas covering the view.
 * Returns the canvas itself; nothing is encoded.
 */
/**
 * Prepares a capture canvas spanning exactly the current view.
 *
 * The image is defined by the view's geographic bounds, so it is built in
 * projected pixels spanning those bounds. One uniform scale is applied to the
 * whole composite, never per source, so geometry stays correct; it matches the
 * device pixel ratio the tiles were rendered at unless that would exceed what
 * the GPU can hold.
 */
function captureFrame(group) {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const nw = map.project(bounds.getNorthWest(), zoom);
  const se = map.project(bounds.getSouthEast(), zoom);

  const fullWidth = se.x - nw.x;
  const fullHeight = se.y - nw.y;
  if (!(fullWidth > 0) || !(fullHeight > 0)) return null;

  const scale = Math.min(captureRatio(), textureLimit() / Math.max(fullWidth, fullHeight));
  const width = Math.max(1, Math.round(fullWidth * scale));
  const height = Math.max(1, Math.round(fullHeight * scale));

  const out = canvasFor(group, width, height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  return {
    canvas: out,
    ctx,
    scale,
    width,
    height,
    fullWidth,
    fullHeight,
    originPx: nw,
    zoom,
    /** Records the geometry the placement diagnostics read, and hands the canvas back. */
    finish() {
      stats.lastCapture = {
        canvas: out,
        originX: nw.x,
        originY: nw.y,
        zoom,
        scale,
        width,
        height,
        bounds: viewBounds(),
      };
      return out;
    },
  };
}

function captureTiledCanvas(group, layer) {
  stats.attempts += 1;
  const tiles = layer?._tiles;
  if (!tiles) {
    stats.noTiles += 1;
    return null;
  }

  const frame = captureFrame(group);
  if (!frame) return null;
  const { ctx, scale, originPx, zoom, fullWidth, fullHeight } = frame;

  let drew = 0;
  for (const entry of Object.values(tiles)) {
    const el = entry?.el;
    if (!el || el.tagName !== 'CANVAS' || !entry.current || !entry.coords) continue;
    const place = tilePlacement(entry.coords, originPx, zoom);
    if (place.x + place.w < 0 || place.y + place.h < 0) continue;
    if (place.x > fullWidth || place.y > fullHeight) continue;
    try {
      ctx.drawImage(el, place.x * scale, place.y * scale, place.w * scale, place.h * scale);
      drew += 1;
    } catch {
      /* tainted or not yet painted */
    }
  }

  stats.lastDrew = drew;
  if (!drew) {
    stats.noneDrawn += 1;
    return null;
  }

  stats.captured += 1;
  return frame.finish();
}

/**
 * True for products captured as a still image rather than handed to GL as a
 * tile source: the recoloured Windy composite and the reprojected OPERA grid.
 * Only these depend on where the 2D map is pointed.
 */
export function isCanvasBacked(def, layer) {
  if (!def) return false;
  // MapsGL owns its render surface, so it is a still like the rest of these.
  if (def.kind === 'opera' || def.kind === 'mapsgl') return true;
  return !!(layer?._tiles && layer.options?.className?.includes('windy-radar-tile'));
}

/**
 * Mirrors one rendered frame into 3D.
 *
 * @param {string} group
 * @param {object} def     catalog definition
 * @param {object} layer   the Leaflet layer just promoted
 * @param {string} url     resolved frame URL
 * @param {number} opacity
 * @returns {boolean} whether anything was mirrored
 */
export function mirrorTo3D(group, def, layer, url, opacity) {
  if (!mirrorReady() || !def) return false;

  switch (def.kind) {
    case 'raster':
    case 'wms':
    case 'pbf': {
      // The Windy composite is a raster product but its tiles are data, not
      // colours — it must go through the canvas path instead.
      if (isCanvasBacked(def, layer)) {
        const canvas = captureTiledCanvas(group, layer);
        if (!canvas) return false;
        stats.mirrored += 1;
        return mirrorCanvas(group, canvas, viewBounds(), opacity);
      }
      return mirrorFrame(group, def, url, opacity);
    }

    case 'opera': {
      // The layer already renders the whole viewport onto one canvas, so it can
      // be handed over directly — no encode, same as the tiled path.
      const canvas = layer?._canvas;
      if (!canvas || !canvas.width || !canvas.height) return false;
      stats.mirrored += 1;
      return mirrorCanvas(group, canvas, viewBounds(), opacity);
    }

    case 'image':
      // Already a georeferenced image; its bounds come from the catalog.
      if (!def.bounds) return false;
      return mirrorImage(group, url, {
        south: def.bounds[0][0],
        west: def.bounds[0][1],
        north: def.bounds[1][0],
        east: def.bounds[1][1],
      }, opacity);

    case 'mapsgl':
      // MapsGL draws into its own canvas; capture that.
      return mirrorMapsGL(group, opacity);

    case 'geojson':
    case 'esri-feature': {
      const data = layer?.toGeoJSON?.();
      return data ? mirrorGeoJson(group, data, opacity) : false;
    }

    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Overlays that are not layer slots
 * ------------------------------------------------------------------ */

/**
 * The in-house nowcast cones and the HOCO outlook polygons are Leaflet vector
 * layers, not catalog products, so nothing in the slot pipeline ever offered
 * them to 3D and they simply did not exist there.
 *
 * They are drawn onto Leaflet canvas panes, which means they can be mirrored the
 * same way the recoloured radar is: composite the panes into one image over the
 * current view and hand GL a canvas source. Re-deriving their styling as GL
 * paint properties would have meant duplicating the risk ladders and losing the
 * per-feature colours; this keeps exactly what 2D draws.
 *
 * Each entry composites its panes in listed order, so fills land under outlines.
 */
const OVERLAY_PANES = [
  ['nowcast', ['nowcastFillPane', 'nowcastOutlinePane']],
  ['outlook', ['publishedOutlookFillPane', 'publishedOutlookOutlinePane']],
  ['outlook-auto', ['hocoFillPane', 'hocoOutlinePane']],
  // Hand-drawn shapes are an overlay like the rest: registering them as an
  // orderable layer put them in the layer list but did nothing for 3D, where
  // they stayed invisible because this list is what reaches the GL view.
  ['drawings', ['drawPane']],
];

/** Every canvas element currently painted into a named Leaflet pane. */
function paneCanvases(names) {
  const out = [];
  for (const name of names) {
    const pane = map.getPane(name);
    if (!pane) continue;
    for (const canvas of pane.querySelectorAll('canvas')) {
      if (canvas.width && canvas.height) out.push(canvas);
    }
  }
  return out;
}

/**
 * Whether a composite actually has anything visible in it.
 *
 * A Leaflet canvas renderer keeps its element in the pane after its last layer
 * is removed — cleared, but present — so "are there canvases?" is not the same
 * question as "is anything drawn?", and the mirror kept a blank layer alive
 * after the outlook was dismissed.
 *
 * The test is done on a small downscale rather than the full capture: scanning
 * several million pixels per frame would cost more than the capture itself, and
 * smoothing means even a one-pixel outline still contributes alpha here.
 */
const PROBE_EDGE = 128;
let probeCanvas = null;

function hasContent(canvas) {
  if (!probeCanvas) probeCanvas = document.createElement('canvas');
  probeCanvas.width = PROBE_EDGE;
  probeCanvas.height = PROBE_EDGE;
  const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, PROBE_EDGE, PROBE_EDGE);
  ctx.imageSmoothingEnabled = true;
  try {
    ctx.drawImage(canvas, 0, 0, PROBE_EDGE, PROBE_EDGE);
    const { data } = ctx.getImageData(0, 0, PROBE_EDGE, PROBE_EDGE);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 2) return true;
  } catch {
    // Unreadable: assume it has content rather than dropping a live overlay.
    return true;
  }
  return false;
}

/**
 * Composites arbitrary on-screen canvases into one capture over the view.
 *
 * Placement comes from the elements' own screen rectangles rather than from
 * Leaflet's internal transforms: a canvas renderer positions its element
 * relative to its pane, MapsGL positions its own differently again, and the
 * bounding rectangle is the one thing that is true for both.
 */
function captureOverlayCanvases(name, canvases) {
  if (!canvases.length) return null;
  const frame = captureFrame(name);
  if (!frame) return null;

  const { ctx, scale, width, height } = frame;
  const mapRect = map.getContainer().getBoundingClientRect();

  let drew = 0;
  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // Entirely off-view.
    if (rect.right < mapRect.left || rect.left > mapRect.right) continue;
    if (rect.bottom < mapRect.top || rect.top > mapRect.bottom) continue;
    try {
      ctx.drawImage(
        canvas,
        (rect.left - mapRect.left) * scale,
        (rect.top - mapRect.top) * scale,
        rect.width * scale,
        rect.height * scale,
      );
      drew += 1;
    } catch {
      /* tainted, or not yet painted */
    }
  }

  if (!drew || !hasContent(frame.canvas)) return null;
  stats.captured += 1;
  stats.lastDrew = drew;
  return frame.finish();
}

/**
 * Mirrors the overlays that live outside the layer slots.
 *
 * Called whenever they are redrawn and whenever the camera settles, so they
 * track the view like everything else.
 */
export function mirrorOverlays(opacity = 1) {
  if (!mirrorReady()) return;

  for (const [name, panes] of OVERLAY_PANES) {
    const group = `${OVERLAY_PREFIX}${name}`;
    const canvas = captureOverlayCanvases(group, paneCanvases(panes));
    if (canvas) mirrorCanvas(group, canvas, viewBounds(), opacity);
    else clearMirror(group);
  }
}

/**
 * Mirrors whatever MapsGL has drawn for `group`.
 *
 * MapsGL renders every one of its layers into one canvas that it owns, so there
 * is no per-product tile URL to hand GL — the canvas is captured instead, like
 * the recoloured radar.
 */
function mirrorMapsGL(group, opacity) {
  const canvas = captureOverlayCanvases(group, mapsglSurfaces());
  if (!canvas) return false;
  stats.mirrored += 1;
  return mirrorCanvas(group, canvas, viewBounds(), opacity);
}

let overlayFrame = 0;

/**
 * Re-captures the nowcast and outlook overlays after they redraw.
 *
 * Leaflet canvas renderers paint on the next frame, so capturing synchronously
 * from a draw call reads the previous picture. Two frames of delay is what makes
 * it the current one, and the request is coalesced so a burst of edits captures
 * once. A no-op outside 3D.
 */
export function refreshOverlayMirror() {
  if (!mirrorReady() || overlayFrame) return;
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0;
      mirrorOverlays();
    });
  });
}

/**
 * Captures MapsGL once it has actually painted.
 *
 * The controller adds its layer asynchronously and emits nothing when the
 * surface is drawn, so the capture is simply retried for a few seconds. A failed
 * attempt costs one empty canvas read.
 */
export function mirrorMapsGLSoon(group, opacity) {
  for (const delay of [500, 1200, 2400, 4000]) {
    setTimeout(() => {
      if (mirrorReady()) mirrorMapsGL(group, opacity);
    }, delay);
  }
}

/**
 * Mirrors whatever is already on the 2D map.
 *
 * Entering 3D cannot rely on `renderAll` to do this: the renderer skips any slot
 * whose frame is already drawn, so nothing would reach the mirror. This walks
 * the slots and hands over the layers they already hold, with no refetching.
 *
 * @returns {string[]} the groups that could not be mirrored
 */
export function remirrorAll({ canvasOnly = false } = {}) {
  const failed = [];
  // The nowcast and outlook overlays are stills like the radar, so they have to
  // be re-captured whenever the view moves.
  mirrorOverlays();
  for (const [group, slot] of slots) {
    if (!slot.enabled || !slot.type || !slot.front) continue;
    const def = getLayerDef(group, slot.type);
    if (!def) continue;
    // Tile-sourced products follow the GL camera by themselves; only the stills
    // have to be re-captured when the view moves.
    if (canvasOnly && !isCanvasBacked(def, slot.front)) continue;
    const done = mirrorTo3D(group, def, slot.front, slot.lastUrl, slot.opacity);
    if (!done) failed.push(group);
  }
  return failed;
}

export { recolourTile };
