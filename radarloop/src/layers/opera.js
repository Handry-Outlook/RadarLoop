/**
 * EUMETNET OPERA reflectivity composite.
 *
 * The product is a raw 3800 x 4400 byte grid in a Lambert azimuthal equal-area
 * projection — not tiles. Displaying it means reprojecting every screen pixel back
 * into grid space and colouring it.
 *
 * Three caches make that affordable when scrubbing:
 *
 *  - **Projection index cache.** The screen-pixel → grid-index mapping depends on
 *    the map view, not on the frame time, so it is computed once per view and
 *    reused for every frame. This is the expensive part (a proj4 call per pixel).
 *  - **Rendered frame cache.** A frame already drawn at this view is put back with
 *    a single `putImageData`.
 *  - **Colour LUT.** See layers/radarScale.js — colouring is two array reads per
 *    pixel rather than a rate conversion.
 *
 * The binary payloads are also cached, capped tightly because each is ~16 MB.
 */

import { DEVICE } from '../config.js';
import { getEncodedLut, dbzToMmh, getSignature, MIN_VISIBLE_MMH } from './radarScale.js';
import { DEPS } from '../core/deps.js';

export const OPERA_WIDTH = 3800;
export const OPERA_HEIGHT = 4400;

/** Screen pixels rendered per frame; the canvas is upscaled to fit. */
const MAX_RENDER_PIXELS = 220000;
const MIN_RENDER_SCALE = 0.38;

/* ------------------------------------------------------------------ *
 * Bounded LRU caches
 * ------------------------------------------------------------------ */

function touch(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

const binaryCache = new Map();
const projectionCache = new Map();
const renderedCache = new Map();

const BINARY_LIMIT = DEVICE.mobile ? 2 : 3;
const PROJECTION_LIMIT = 4;
const RENDERED_LIMIT = DEVICE.mobile ? 2 : 3;

export const hasOperaFrame = (url) => binaryCache.has(url);
export const getOperaFrame = (url) => binaryCache.get(url);
export const cacheOperaFrame = (url, buffer) => touch(binaryCache, url, buffer, BINARY_LIMIT);

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export async function fetchOperaFrame(url, def) {
  const cached = binaryCache.get(url);
  if (cached) return cached;

  const response = await fetch(url, { method: 'GET', cache: 'force-cache' });
  if (!response.ok) throw new Error(`OPERA HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();

  const expected = (def.width || OPERA_WIDTH) * (def.height || OPERA_HEIGHT);
  if (buffer.byteLength !== expected) {
    throw new Error(`OPERA payload is ${buffer.byteLength} bytes, expected ${expected}`);
  }
  return cacheOperaFrame(url, buffer);
}

/* ------------------------------------------------------------------ *
 * Cache keys
 * ------------------------------------------------------------------ */

function viewKey(map, width, height) {
  const centre = map.getCenter();
  const size = map.getSize();
  return [map.getZoom(), centre.lat.toFixed(6), centre.lng.toFixed(6), size.x, size.y, width, height].join(':');
}

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

export const OperaCanvasLayer = L.Layer.extend({
  initialize(buffer, options = {}) {
    L.setOptions(this, options);
    this._values = new Uint8Array(buffer);
    this._sw = Number(options.width) || OPERA_WIDTH;
    this._sh = Number(options.height) || OPERA_HEIGHT;
    this._projection = options.projection;
    this._extent = options.projectedExtent;
    this._frameUrl = options.frameUrl || '';
    this._opacity = options.opacity ?? 1;
    this._generation = 0;
    this._isOperaLayer = true;
    this._onViewChange = () => this._schedule();
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'opera-radar-canvas');
    this._canvas.style.opacity = String(this._opacity);
    map.getPane(this.options.pane || 'operaRadarPane').appendChild(this._canvas);
    map.on('moveend zoomend resize', this._onViewChange);
    this._schedule();
    return this;
  },

  onRemove(map) {
    this._generation += 1;
    map.off('moveend zoomend resize', this._onViewChange);
    this._canvas?.remove();
    this._canvas = null;
    this._map = null;
    return this;
  },

  setOpacity(value) {
    this._opacity = Number(value);
    if (this._canvas) this._canvas.style.opacity = String(value);
    return this;
  },

  /** Swaps in a new frame without rebuilding the projection geometry. */
  setFrame(buffer, frameUrl) {
    this._values = new Uint8Array(buffer);
    this._frameUrl = frameUrl || '';
    this._schedule();
    return this;
  },

  /** Reads the rainfall rate under a lat/lng, for the click-to-inspect popup. */
  sampleAt(latlng) {
    if (!latlng || typeof proj4 !== 'function') return null;
    const [minX, minY, maxX, maxY] = this._extent;
    const [px, py] = proj4('EPSG:4326', this._projection, [latlng.lng, latlng.lat]);
    if (px < minX || px >= maxX || py < minY || py >= maxY) return null;

    const sx = Math.floor(((px - minX) / (maxX - minX)) * this._sw);
    const sy = Math.floor(((maxY - py) / (maxY - minY)) * this._sh);
    if (sx < 0 || sx >= this._sw || sy < 0 || sy >= this._sh) return null;

    const encoded = this._values[sy * this._sw + sx];
    if (encoded === 255) return { mmh: 0, dbz: 0, encoded, noData: true };
    const dbz = encoded * 0.5 - 32;
    const mmh = dbz > 0 ? dbzToMmh(dbz) : 0;
    return { mmh, dbz, encoded, noData: false, belowFloor: mmh < MIN_VISIBLE_MMH };
  },

  _schedule() {
    const generation = ++this._generation;
    requestAnimationFrame(() => this._render(generation));
  },

  /** Builds the screen-pixel → grid-index map for the current view. */
  _buildProjectionIndex(width, height, generation) {
    const map = this._map;
    const size = map.getSize();
    const indices = new Int32Array(width * height).fill(-1);
    const [minX, minY, maxX, maxY] = this._extent;
    const dx = size.x / width;
    const dy = size.y / height;

    // Chunked so a large viewport cannot lock the main thread outright; the
    // generation check lets a superseded view abandon the work.
    for (let chunk = 0; chunk < height; chunk += 64) {
      const limit = Math.min(height, chunk + 64);
      for (let y = chunk; y < limit; y += 1) {
        const containerY = (y + 0.5) * dy;
        for (let x = 0; x < width; x += 1) {
          const ll = map.containerPointToLatLng([(x + 0.5) * dx, containerY]);
          const [px, py] = proj4('EPSG:4326', this._projection, [ll.lng, ll.lat]);
          if (px < minX || px >= maxX || py < minY || py >= maxY) continue;
          const sx = Math.floor(((px - minX) / (maxX - minX)) * this._sw);
          const sy = Math.floor(((maxY - py) / (maxY - minY)) * this._sh);
          if (sx >= 0 && sx < this._sw && sy >= 0 && sy < this._sh) {
            indices[y * width + x] = sy * this._sw + sx;
          }
        }
      }
      if (generation !== this._generation) return null;
    }
    return indices;
  },

  _render(generation) {
    const map = this._map;
    const canvas = this._canvas;
    if (!map || !canvas || generation !== this._generation) return;

    const size = map.getSize();
    const scale = Math.min(1, Math.max(MIN_RENDER_SCALE, Math.sqrt(MAX_RENDER_PIXELS / (size.x * size.y))));
    const width = Math.max(1, Math.round(size.x * scale));
    const height = Math.max(1, Math.round(size.y * scale));

    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const lut = getEncodedLut({ opera: true });
    const view = viewKey(map, width, height);
    // The scale is part of the key: the same frame at the same view looks
    // different after the rainfall colour picker changes, and without this the
    // cache would hand back the old pixels.
    const frameKey = `${this._frameUrl}|${view}|${getSignature()}`;

    const done = renderedCache.get(frameKey);
    if (done) {
      touch(renderedCache, frameKey, done, RENDERED_LIMIT);
      if (generation !== this._generation || !canvas.isConnected) return;
      ctx.putImageData(done, 0, 0);
      this.fire('load');
      return;
    }

    let indices = projectionCache.get(view);
    if (indices) {
      touch(projectionCache, view, indices, PROJECTION_LIMIT);
    } else {
      indices = this._buildProjectionIndex(width, height, generation);
      if (!indices) return;
      touch(projectionCache, view, indices, PROJECTION_LIMIT);
    }

    if (generation !== this._generation || !canvas.isConnected) return;

    const image = ctx.createImageData(width, height);
    const out = image.data;
    const values = this._values;
    for (let pixel = 0; pixel < indices.length; pixel += 1) {
      const source = indices[pixel];
      if (source < 0) continue;
      const l = values[source] * 4;
      const o = pixel * 4;
      out[o] = lut[l];
      out[o + 1] = lut[l + 1];
      out[o + 2] = lut[l + 2];
      out[o + 3] = lut[l + 3];
    }

    if (generation !== this._generation || !canvas.isConnected) return;
    ctx.putImageData(image, 0, 0);
    touch(renderedCache, frameKey, image, RENDERED_LIMIT);
    this.fire('load');
  },
});

/** Builds an OPERA layer for a resolved frame URL. */
export async function createOperaLayer(url, def, { pane = 'operaRadarPane', opacity = 1 } = {}) {
  // The reprojection library is only needed by this one product.
  await DEPS.proj4();
  const buffer = await fetchOperaFrame(url, def);
  return new OperaCanvasLayer(buffer, {
    width: def.width || OPERA_WIDTH,
    height: def.height || OPERA_HEIGHT,
    projection: def.projection,
    projectedExtent: def.projectedExtent,
    frameUrl: url,
    pane,
    opacity,
  });
}
