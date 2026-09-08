/**
 * Mirroring weather layers into the Mapbox GL view.
 *
 * Each product kind needs a different GL representation, and getting the tile
 * scheme wrong is silently wrong rather than broken — a flipped-Y product simply
 * renders upside down and misplaced, which is what "wrong projection" looked
 * like for the DTN satellite products.
 *
 *   kind          GL representation
 *   ------------  ------------------------------------------------------------
 *   raster        raster source, `scheme` set from the product's tile addressing
 *   wms           raster source using {bbox-epsg-3857}, which GL can template
 *   pbf           vector source + fill layer driven by the provider's fill-color
 *   geojson       geojson source + fill/line/circle layers
 *   xweather      geojson source built from the already-normalised features
 *   opera/windy   viewport texture: our own canvas as an image source
 *
 * Every layer this module adds is prefixed `wx-` so the whole weather stack can
 * be found, reordered and removed without touching the base style.
 */

import { isImagePayload } from '../layers/urlTemplate.js';
import { REFERENCE_OVERLAY } from '../data/basemaps.js';

const PREFIX = 'wx-';

/** The GL layer drawing lightning strikes; owned by map3d, ordered here. */
export const STRIKES_LAYER = `${PREFIX}strikes-layer`;

/**
 * Marks a mirrored group as an overlay that belongs above the weather stack —
 * the nowcast cones and the outlook polygons, which in 2D live in panes above
 * everything else.
 */
export const OVERLAY_PREFIX = 'ov-';
const sourceId = (group) => `${PREFIX}${group}-src`;
const layerId = (group) => `${PREFIX}${group}`;

/** Layers currently mirrored, so ordering and teardown know what exists. */
const mirrored = new Map(); // group -> { kind, layerIds: [] }

let gl = null;
let ready = false;

export function bindGl(instance, isReady) {
  gl = instance;
  ready = isReady;
  if (!instance) mirrored.clear();
}

export const mirrorReady = () => !!gl && ready;

/* ------------------------------------------------------------------ *
 * Tile addressing
 * ------------------------------------------------------------------ */

/**
 * Whether a product is published with flipped-Y (TMS) addressing.
 *
 * This has to agree with what the 2D renderer tells Leaflet, and it did not.
 * 3D treated *every* DTN URL as TMS while 2D flipped only DTN satellite, so DTN
 * isobars and surface fronts came out vertically mirrored in 3D — the reported
 * "isobars and fronts are in the wrong place". DTN serves flipped-Y only for its
 * satellite imagery; the rest of its catalogue is ordinary XYZ.
 *
 * Exported so `layers/renderer.js` uses the same rule rather than its own copy.
 */
export const usesFlippedY = (group, url) =>
  group === 'satellite' && /^https:\/\/tiles\.meteoguard\.dtn\.com\//i.test(String(url));

/**
 * The GL `scheme` for a tile source.
 *
 * Leaflet expresses a flip either as `tms: true` or with a `{-y}` token in the
 * template; GL has only `scheme`, and `toGlTemplate` rewrites `{-y}` away, so
 * both forms converge here.
 */
export function tileScheme(group, url) {
  if (usesFlippedY(group, url)) return 'tms';
  if (/\{-y\}/.test(String(url))) return 'tms';
  return 'xyz';
}

/** Strips Leaflet-only tokens GL does not understand. */
function toGlTemplate(url) {
  return url.replace('{-y}', '{y}').replace(/\{s\}/g, 'a');
}

/**
 * Rewrites an EPSG:4326 WMS template into the EPSG:3857 form GL can fill in.
 *
 * GL substitutes `{bbox-epsg-3857}` per tile but has no 4326 equivalent, so the
 * request is switched to Web Mercator — which these services serve natively.
 */
export function toGlWmsTemplate(url) {
  return url
    .replace(/CRS=EPSG(%3A|:)4326/i, 'CRS=EPSG%3A3857')
    .replace(/SRS=EPSG(%3A|:)4326/i, 'SRS=EPSG%3A3857')
    .replace('{bbox}', '{bbox-epsg-3857}');
}

/* ------------------------------------------------------------------ *
 * Adding
 * ------------------------------------------------------------------ */

function removeIfPresent(ids, src) {
  for (const id of ids) {
    if (gl.getLayer(id)) gl.removeLayer(id);
  }
  if (src && gl.getSource(src)) gl.removeSource(src);
}

/** Removes whatever a group has mirrored. */
export function clearMirror(group) {
  if (!mirrorReady()) return;
  const entry = mirrored.get(group);
  if (!entry) return;
  try {
    removeIfPresent(entry.layerIds, sourceId(group));
  } catch (error) {
    console.warn(`[3d] could not clear ${group}:`, error);
  }
  mirrored.delete(group);
}

/** Raster and WMS tile products. */
function mirrorRaster(group, url, opacity, { wms = false } = {}) {
  const src = sourceId(group);
  const id = layerId(group);
  const template = wms ? toGlWmsTemplate(url) : toGlTemplate(url);

  const existing = gl.getSource(src);
  if (existing && mirrored.get(group)?.url !== template) {
    // setTiles keeps the layer in place, avoiding a teardown flash on each frame.
    if (typeof existing.setTiles === 'function') {
      existing.setTiles([template]);
      mirrored.set(group, { kind: 'raster', layerIds: [id], url: template });
      gl.setPaintProperty(id, 'raster-opacity', opacity);
      return true;
    }
    clearMirror(group);
  } else if (existing) {
    gl.setPaintProperty(id, 'raster-opacity', opacity);
    return true;
  }

  gl.addSource(src, {
    type: 'raster',
    tiles: [template],
    tileSize: 256,
    // Wrong scheme = vertically mirrored imagery.
    scheme: wms ? 'xyz' : tileScheme(group, url),
  });
  gl.addLayer({
    id,
    type: 'raster',
    source: src,
    paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 },
  });
  mirrored.set(group, { kind: 'raster', layerIds: [id], url: template });
  restackTop();
  return true;
}

/** DTN protobuf products, styled from the provider's own fill-color property. */
function mirrorVector(group, url, opacity) {
  const src = sourceId(group);
  const id = layerId(group);
  const template = toGlTemplate(url);

  if (mirrored.get(group)?.url === template) return true;
  clearMirror(group);

  gl.addSource(src, { type: 'vector', tiles: [template], scheme: tileScheme(group, url) });
  gl.addLayer({
    id,
    type: 'fill',
    source: src,
    'source-layer': 'geojsonLayer',
    paint: {
      // The provider ships the colour per feature, exactly as in 2D.
      'fill-color': ['coalesce', ['get', 'fill-color'], 'rgba(0,0,0,0)'],
      'fill-opacity': opacity,
      'fill-outline-color': 'rgba(0,0,0,0)',
    },
  });
  mirrored.set(group, { kind: 'pbf', layerIds: [id], url: template });
  restackTop();
  return true;
}

/** GeoJSON feature collections: polygons, lines and points in one source. */
export function mirrorGeoJson(group, data, opacity, { accent = '#38bdf8' } = {}) {
  if (!mirrorReady() || !data) return false;
  const src = sourceId(group);
  const fill = `${layerId(group)}-fill`;
  const line = `${layerId(group)}-line`;
  const point = `${layerId(group)}-point`;

  const existing = gl.getSource(src);
  if (existing) {
    existing.setData(data);
    return true;
  }

  gl.addSource(src, { type: 'geojson', data });

  const colour = ['coalesce', ['get', 'color'], ['get', 'colour'], accent];
  gl.addLayer({
    id: fill,
    type: 'fill',
    source: src,
    filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    paint: { 'fill-color': colour, 'fill-opacity': opacity * 0.35 },
  });
  gl.addLayer({
    id: line,
    type: 'line',
    source: src,
    filter: ['match', ['geometry-type'],
      ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'], true, false],
    paint: { 'line-color': colour, 'line-width': 2, 'line-opacity': opacity },
  });
  gl.addLayer({
    id: point,
    type: 'circle',
    source: src,
    filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
    paint: {
      'circle-radius': 4,
      'circle-color': colour,
      'circle-opacity': opacity,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#0b0f17',
    },
  });

  mirrored.set(group, { kind: 'geojson', layerIds: [fill, line, point] });
  restackTop();
  return true;
}

/**
 * Products rendered by our own canvas — the recoloured Windy composite and the
 * reprojected OPERA grid.
 *
 * GL cannot run our per-pixel recolouring inside a raster source, so the canvas
 * we already produce is handed over as an image pinned to its geographic
 * bounds. It is re-rendered when the view settles rather than continuously,
 * which is the same trade-off the 2D OPERA layer makes.
 */
/**
 * Latest pending image per group.
 *
 * `updateImage` starts an asynchronous decode, and calling it again before the
 * previous one settles drops the earlier update. Scrubbing produces exactly that
 * pattern, which is why the 3D radar intermittently stopped following the
 * slider. Updates are therefore coalesced to one per frame, and the most recent
 * one always wins.
 */
const pendingImages = new Map();
let imageFlush = null;

function flushImages() {
  imageFlush = null;
  if (!mirrorReady()) {
    pendingImages.clear();
    return;
  }
  for (const [group, payload] of pendingImages) applyImage(group, payload);
  pendingImages.clear();
}

function applyImage(group, { dataUrl, bounds, opacity }) {
  const src = sourceId(group);
  const id = layerId(group);

  // [west, north], [east, north], [east, south], [west, south]
  const coordinates = [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
  ];

  try {
    const existing = gl.getSource(src);
    if (existing && typeof existing.updateImage === 'function') {
      existing.updateImage({ url: dataUrl, coordinates });
      if (gl.getLayer(id)) gl.setPaintProperty(id, 'raster-opacity', opacity);
      mirrored.set(group, { kind: 'image', layerIds: [id] });
      return;
    }
    if (existing) clearMirror(group);

    gl.addSource(src, { type: 'image', url: dataUrl, coordinates });
    gl.addLayer({
      id,
      type: 'raster',
      source: src,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 },
    });
    mirrored.set(group, { kind: 'image', layerIds: [id] });
    restackTop();
  } catch (error) {
    console.warn(`[3d] image mirror for ${group} failed:`, error);
  }
}

export function mirrorImage(group, dataUrl, bounds, opacity) {
  if (!mirrorReady() || !dataUrl || !bounds) return false;
  pendingImages.set(group, { dataUrl, bounds, opacity });
  if (imageFlush === null) imageFlush = requestAnimationFrame(flushImages);
  return true;
}

/* ------------------------------------------------------------------ *
 * Canvas sources
 * ------------------------------------------------------------------ */

const canvasSources = new Set();

/**
 * Mirrors a canvas we own, without encoding it.
 *
 * The image path costs a full PNG encode of the viewport on every frame plus a
 * decode inside GL — tens of milliseconds each, which is what made scrubbing the
 * Global High Resolution radar in 3D so heavy. A `canvas` source samples the
 * element's pixels directly, so a new frame costs one texture upload.
 *
 * `animate: false` keeps GL from re-reading every frame; a brief play/pause
 * after each redraw uploads exactly the frames that changed.
 */
export function mirrorCanvas(group, canvas, bounds, opacity) {
  if (!mirrorReady() || !canvas || !bounds) return false;
  const src = sourceId(group);
  const id = layerId(group);

  const coordinates = [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
  ];

  try {
    const existing = gl.getSource(src);
    if (existing && canvasSources.has(group)) {
      existing.setCoordinates?.(coordinates);
      if (gl.getLayer(id)) gl.setPaintProperty(id, 'raster-opacity', opacity);
      refreshCanvasSource(existing);
      return true;
    }
    // A different source kind was here (or none); start clean.
    if (existing) clearMirror(group);

    gl.addSource(src, { type: 'canvas', canvas, coordinates, animate: false });
    gl.addLayer({
      id,
      type: 'raster',
      source: src,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 },
    });
    canvasSources.add(group);
    mirrored.set(group, { kind: 'canvas', layerIds: [id] });
    restackTop();
    return true;
  } catch (error) {
    console.warn(`[3d] canvas mirror for ${group} failed:`, error);
    canvasSources.delete(group);
    return false;
  }
}

/** Nudges a paused canvas source into re-reading its element once. */
function refreshCanvasSource(source) {
  try {
    if (typeof source.play !== 'function' || typeof source.pause !== 'function') return;
    source.play();
    requestAnimationFrame(() => {
      try {
        source.pause();
      } catch {
        /* source removed between frames */
      }
    });
  } catch {
    /* older SDK without play/pause — the source will still refresh on move */
  }
}

/** True when GL accepted a canvas source for this group. */
export const usesCanvasSource = (group) => canvasSources.has(group);

/* ------------------------------------------------------------------ *
 * Reference overlay (coastline and place labels)
 * ------------------------------------------------------------------ */

const REFERENCE_SRC = `${PREFIX}reference-src`;
export const REFERENCE_LAYER = `${PREFIX}reference`;
let referenceWanted = false;

/**
 * The coastline/labels overlay.
 *
 * In 2D this lives in `labelsPane` above the weather stack. It is a Leaflet
 * layer, so 3D needs its own copy — without one the 3D view has no coastline at
 * all, which is what made weather over the sea impossible to place.
 */
export function setReferenceMirror(enabled) {
  referenceWanted = enabled;
  if (!mirrorReady()) return;

  try {
    if (!enabled) {
      if (gl.getLayer(REFERENCE_LAYER)) gl.removeLayer(REFERENCE_LAYER);
      if (gl.getSource(REFERENCE_SRC)) gl.removeSource(REFERENCE_SRC);
      return;
    }
    if (gl.getSource(REFERENCE_SRC)) {
      restackTop();
      return;
    }
    gl.addSource(REFERENCE_SRC, {
      type: 'raster',
      tiles: [REFERENCE_OVERLAY.url],
      // Leaflet pairs tileSize 512 with zoomOffset -1; GL expresses the same
      // thing as a 512px tile source with no offset.
      tileSize: 512,
      scheme: 'xyz',
    });
    gl.addLayer({
      id: REFERENCE_LAYER,
      type: 'raster',
      source: REFERENCE_SRC,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    });
    restackTop();
  } catch (error) {
    console.warn('[3d] reference overlay failed:', error);
  }
}

/**
 * Enforces the top of the GL stack, in the order the 2D pane stack uses.
 *
 * GL appends a new layer above everything, so whatever was mirrored last ended
 * up on top — which is why turning on the Windy radar buried the lightning
 * strikes. Anything that must stay above the weather is moved back to the top
 * here, bottom-first, after every add.
 *
 * The two callers that tried to do this before both looked for a layer called
 * `wx-strikes`. That is the *source* id; the layer is `wx-strikes-layer`, so the
 * lookup never matched and the guard silently did nothing.
 */
function restackTop() {
  if (!mirrorReady()) return;
  try {
    // Bottom to top: coastline, then strikes, then the outlook and nowcast
    // overlays, whose outlines are meant to survive everything beneath them.
    const ids = [REFERENCE_LAYER, STRIKES_LAYER];
    for (const group of mirrored.keys()) {
      if (!group.startsWith(OVERLAY_PREFIX)) continue;
      ids.push(...(mirrored.get(group)?.layerIds || []));
    }
    // moveLayer with no `beforeId` moves to the very top, so applying them in
    // ascending order leaves them stacked in that order.
    for (const id of ids) {
      if (gl.getLayer(id)) gl.moveLayer(id);
    }
  } catch {
    /* style still settling */
  }
}

/** Re-adds the overlay after a restyle, which discards every source. */
export function restoreReferenceMirror() {
  if (referenceWanted) setReferenceMirror(true);
}

export const referenceMirrored = () =>
  mirrorReady() && !!gl.getLayer(REFERENCE_LAYER);

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/**
 * Mirrors one resolved frame.
 * @returns {boolean} true when something was drawn
 */
export function mirrorFrame(group, def, url, opacity) {
  if (!mirrorReady() || !def) return false;

  try {
    switch (def.kind) {
      case 'wms':
        return mirrorRaster(group, url, opacity, { wms: true });
      case 'pbf':
        // Some "pbf" entries actually serve images; classify on the payload.
        return isImagePayload(url)
          ? mirrorRaster(group, url, opacity)
          : mirrorVector(group, url, opacity);
      case 'raster':
        return mirrorRaster(group, url, opacity);
      default:
        return false; // handled by a dedicated path
    }
  } catch (error) {
    console.warn(`[3d] could not mirror ${group} (${def.kind}):`, error);
    return false;
  }
}

export function setMirrorOpacity(group, opacity) {
  if (!mirrorReady()) return;
  const entry = mirrored.get(group);
  if (!entry) return;
  for (const id of entry.layerIds) {
    if (!gl.getLayer(id)) continue;
    const type = gl.getLayer(id).type;
    try {
      if (type === 'raster') gl.setPaintProperty(id, 'raster-opacity', opacity);
      else if (type === 'fill') gl.setPaintProperty(id, 'fill-opacity', opacity * 0.35);
      else if (type === 'line') gl.setPaintProperty(id, 'line-opacity', opacity);
      else if (type === 'circle') gl.setPaintProperty(id, 'circle-opacity', opacity);
    } catch {
      /* layer removed mid-update */
    }
  }
}

/**
 * Re-stacks the mirrored layers.
 * GL draws in insertion order, so ordering means moving layers explicitly.
 */
export function setMirrorOrder(group, index) {
  if (!mirrorReady()) return;
  const entry = mirrored.get(group);
  if (!entry) return;
  try {
    // Strikes always stay on top of the weather stack.
    const before = gl.getLayer(STRIKES_LAYER) ? STRIKES_LAYER : undefined;
    for (const id of entry.layerIds) {
      if (gl.getLayer(id)) gl.moveLayer(id, before);
    }
    restackTop();
  } catch {
    /* style still loading */
  }
}

export const mirroredGroups = () => [...mirrored.keys()];
export const mirrorKind = (group) => mirrored.get(group)?.kind ?? null;
