/**
 * Strike rendering.
 *
 * ## Why this is a single canvas layer
 *
 * The legacy renderer created one `L.crossMarker` per strike — up to 9,000 live
 * Leaflet layers, each with its own popup binding, style object and entry in the
 * renderer's redraw list. Every colour update walked all of them calling
 * `setStyle`, and every pan asked Leaflet to reposition all of them.
 *
 * Here all strikes are drawn onto one canvas in a single pass. Cost per frame is
 * one loop over the visible strikes with no per-strike allocation, so ten
 * thousand strikes cost roughly what a hundred markers used to. Click-to-inspect
 * is preserved through a hit test rather than per-marker interactivity.
 */

import { DEVICE, TUNING } from '../config.js';
import { map } from '../core/map.js';
import { lightning, runtime } from '../core/state.js';

/** Age ramp, newest to oldest. Thresholds are fractions of the lifespan. */
const AGE_STOPS = [
  [0.05, '#ffd700'],
  [0.2, '#ff00ff'],
  [0.5, '#ff69b4'],
  [0.8, '#800080'],
  [Infinity, '#4b0082'],
];

export function colourForAge(fraction) {
  for (const [limit, colour] of AGE_STOPS) if (fraction < limit) return colour;
  return AGE_STOPS[AGE_STOPS.length - 1][1];
}

/** Colour used when age colouring is switched off. */
const STATIC_COLOUR = '#111111';


/* ------------------------------------------------------------------ *
 * Bulk strikes
 * ------------------------------------------------------------------ */

/**
 * Strike sets big enough that an object per strike is the wrong shape.
 *
 * A day of global lightning is approaching two million strikes. As objects that
 * is a couple of hundred megabytes and a garbage collector under permanent
 * load; as three typed arrays it is sixteen megabytes and nothing to collect.
 *
 * The important part is that the position is stored already projected. Web
 * Mercator needs a logarithm and a tangent per point, and doing that two million
 * times per frame is most of a second; done once when the strike arrives, a
 * frame costs one multiply and one subtract per strike. The provider's own
 * client stores its strikes the same way, which is a good sign it is the right
 * shape rather than a clever idea.
 *
 * A buffer is `{ mx, my, t, base, count }`: normalised Mercator x and y in
 * `[0, 1]` as Float32, milliseconds after `base` as Uint32, which covers 49
 * days per buffer.
 */

/** Normalised Mercator x for a longitude, in [0, 1]. */
export const mercatorX = (lon) => (lon + 180) / 360;

/** Normalised Mercator y for a latitude, in [0, 1], clamped at the poles. */
export function mercatorY(lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Inverse of `mercatorY`, for turning a hit test back into a position. */
export function latFromMercatorY(y) {
  return (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
}

/**
 * Above this many strikes in view, each is drawn as a point rather than a cross.
 *
 * Not a cap: every strike in view is still drawn either way. At this density the
 * crosses overlap into solid colour, so the arms cost four path operations each
 * to draw something indistinguishable from a dot — and the dot path writes
 * pixels straight into an image buffer, which is roughly a hundred times faster
 * than asking the canvas to stroke two million line segments.
 */
const DENSE_THRESHOLD = 24000;

/** Age ramp as packed pixels, for the dense path. */
const AGE_PIXELS = AGE_STOPS.map(([, colour]) => packColour(colour));
const STATIC_PIXEL = packColour(STATIC_COLOUR);

/** `#rrggbb` to the little-endian ABGR word an ImageData buffer wants. */
function packColour(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

/** First index in a buffer whose strike is at or after a moment. */
function firstAtOrAfter(buffer, ms) {
  const target = ms - buffer.base;
  const { t, count } = buffer;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

export const StrikeCanvasLayer = L.Layer.extend({
  initialize(options = {}) {
    L.setOptions(this, options);
    this._strikes = [];
    this._buffers = [];
    this._image = null;
    this._pixels = null;
    this._windowEnd = Date.now();
    this._lifespanMs = 3 * 3600 * 1000;
    this._flashes = [];
    this._frame = null;
    this._onViewChange = () => this._schedule();
  },

  onAdd(leafletMap) {
    this._map = leafletMap;
    this._canvas = L.DomUtil.create('canvas', 'strike-canvas');
    leafletMap.getPane(this.options.pane || 'lightningPane').appendChild(this._canvas);
    leafletMap.on('move zoom viewreset resize', this._onViewChange);
    leafletMap.on('click', this._onClick, this);
    this._schedule();
    return this;
  },

  onRemove(leafletMap) {
    cancelAnimationFrame(this._frame);
    leafletMap.off('move zoom viewreset resize', this._onViewChange);
    leafletMap.off('click', this._onClick, this);
    this._canvas?.remove();
    this._canvas = null;
    this._map = null;
    return this;
  },

  /** Replaces the drawn set. `newKeys` marks strikes that should flash. */
  setStrikes(strikes, { end, lifespanHours, newKeys } = {}) {
    this._strikes = strikes;
    if (end) this._windowEnd = end instanceof Date ? end.getTime() : end;
    if (lifespanHours) this._lifespanMs = Math.max(1, lifespanHours * 3600 * 1000);

    if (newKeys?.size) {
      const now = performance.now();
      let budget = DEVICE.mobile ? 6 : 14;
      for (const strike of strikes) {
        if (budget <= 0) break;
        if (!newKeys.has(strike.ms)) continue;
        this._flashes.push({ lat: strike.lat, lon: strike.lon, start: now });
        budget -= 1;
      }
    }
    this._schedule();
    return this;
  },

  /**
   * Replaces the drawn set with typed-array buffers.
   *
   * Used for the bulk sources. `setStrikes` stays for the ones small enough that
   * an object each is no trouble, and the two can be shown at once.
   */
  setStrikeBuffers(buffers, { end, lifespanHours } = {}) {
    this._buffers = buffers || [];
    if (end) this._windowEnd = end instanceof Date ? end.getTime() : end;
    if (lifespanHours) this._lifespanMs = Math.max(1, lifespanHours * 3600 * 1000);
    this._schedule();
    return this;
  },

  /**
   * Draws every buffered strike inside the view.
   *
   * Two things keep this cheap at two million strikes.
   *
   * **No counting pass.** Choosing between the two draw modes needs to know how
   * many strikes are on screen, and finding that out exactly meant walking every
   * buffer twice. The count from the previous frame decides instead: it is the
   * same view a sixtieth of a second earlier, and being one frame late in
   * switching mode is invisible, where walking two million entries twice is not.
   *
   * **No colour lookup per strike.** Strikes are stored in time order and the age
   * ramp is a set of time bands, so each band is a contiguous run. A binary
   * search per band per buffer replaces a comparison chain per strike, and the
   * inner loop draws a run of one colour with no branching in it at all.
   */
  _renderBuffers(ctx, size, dpr) {
    if (!this._buffers.length) return 0;

    // Leaflet's projection, inlined: at this zoom the whole world is `scale`
    // pixels across, so a normalised Mercator position is one multiply away from
    // a pixel. Anything else would put a tangent and a logarithm in this loop.
    const scale = this._map.getPixelWorldBounds().getSize().x;
    const origin = this._map.getPixelBounds().min;
    const dense = (this._lastVisible || 0) > DENSE_THRESHOLD;
    const view = {
      scale, originX: origin.x, originY: origin.y, pad: 8, w: size.x, h: size.y, dpr,
    };

    const runs = this._ageRuns();
    const drawn = dense ? this._splatRuns(ctx, view, runs) : this._strokeRuns(ctx, view, runs);
    this._lastVisible = drawn;
    return drawn;
  },

  /**
   * The buffers cut into runs of one colour.
   *
   * Each run is `[buffer, from, to, colourIndex]`, and because a buffer is in
   * time order the cut points are two binary searches per band.
   */
  _ageRuns() {
    const end = this._windowEnd;
    const lifespan = this._lifespanMs;
    const runs = [];

    for (const buffer of this._buffers) {
      if (!buffer.count) continue;
      if (!lightning.colorByAge) {
        runs.push([buffer, 0, buffer.count, -1]);
        continue;
      }
      // Age rises with time-before-`end`, so the youngest band is the newest
      // strikes: walk the stops from the newest boundary backwards.
      let to = buffer.count;
      for (let band = 0; band < AGE_STOPS.length && to > 0; band += 1) {
        const limit = AGE_STOPS[band][0];
        const from = limit === Infinity
          ? 0
          : firstAtOrAfter(buffer, end - limit * lifespan);
        if (from < to) runs.push([buffer, from, to, band]);
        to = from;
      }
    }
    return runs;
  },

  /** The sparse mode: the same crosses the object path draws. */
  _strokeRuns(ctx, view, runs) {
    const { scale, originX, originY, pad, w, h } = view;
    const arm = runtime.lowEnd ? 3.5 : 4.5;
    let drawn = 0;

    for (const [buffer, from, to, band] of runs) {
      const { mx, my } = buffer;
      ctx.strokeStyle = band < 0 ? STATIC_COLOUR : AGE_STOPS[band][1];
      ctx.beginPath();
      let any = false;
      for (let i = from; i < to; i += 1) {
        const x = mx[i] * scale - originX;
        if (x < -pad || x > w + pad) continue;
        const y = my[i] * scale - originY;
        if (y < -pad || y > h + pad) continue;
        ctx.moveTo(x - arm, y - arm);
        ctx.lineTo(x + arm, y + arm);
        ctx.moveTo(x + arm, y - arm);
        ctx.lineTo(x - arm, y + arm);
        any = true;
        drawn += 1;
      }
      if (any) ctx.stroke();
    }
    return drawn;
  },

  /**
   * The dense mode: one array write per strike, straight into an image buffer.
   *
   * At this density the canvas path API is the whole cost — two million strokes
   * is seconds, two million array writes is milliseconds. The buffer is kept
   * between frames because allocating a canvas-sized `ImageData` every frame is
   * itself a noticeable expense at 4K.
   */
  _splatRuns(ctx, view, runs) {
    const { scale, originX, originY, w: cssW, h: cssH, dpr } = view;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (!this._image || this._image.width !== w || this._image.height !== h) {
      this._image = ctx.createImageData(w, h);
      this._pixels = new Uint32Array(this._image.data.buffer);
    }
    const pixels = this._pixels;
    pixels.fill(0);
    // A single device pixel disappears on a dense field; a 2x2 block is what
    // makes an individual strike visible without merging its neighbours.
    const block = dpr >= 2 ? 2 : 1;
    let drawn = 0;

    for (const [buffer, from, to, band] of runs) {
      const { mx, my } = buffer;
      const colour = band < 0 ? STATIC_PIXEL : AGE_PIXELS[band];
      for (let i = from; i < to; i += 1) {
        const px = (mx[i] * scale - originX) * dpr;
        if (px < 0 || px >= w) continue;
        const py = (my[i] * scale - originY) * dpr;
        if (py < 0 || py >= h) continue;
        const x0 = px | 0;
        const y0 = py | 0;
        for (let dy = 0; dy < block; dy += 1) {
          const row = y0 + dy;
          if (row >= h) break;
          const at = row * w + x0;
          pixels[at] = colour;
          if (block > 1 && x0 + 1 < w) pixels[at + 1] = colour;
        }
        drawn += 1;
      }
    }

    // putImageData ignores the transform, so it goes on at device scale.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(this._image, 0, 0);
    ctx.restore();
    return drawn;
  },

  setOpacity(value) {
    if (this._canvas) this._canvas.style.opacity = String(value);
    return this;
  },

  _schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._render();
    });
  },

  _render() {
    const leafletMap = this._map;
    const canvas = this._canvas;
    if (!leafletMap || !canvas) return;

    const size = leafletMap.getSize();
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    if (canvas.width !== Math.round(size.x * dpr) || canvas.height !== Math.round(size.y * dpr)) {
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(canvas, leafletMap.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const bounds = leafletMap.getBounds().pad(0.15);
    const colourByAge = lightning.colorByAge;
    const end = this._windowEnd;
    const lifespan = this._lifespanMs;
    const arm = runtime.lowEnd ? 3.5 : 4.5;

    ctx.lineWidth = runtime.lowEnd ? 1.4 : 1.8;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.92;

    // Batching by colour means at most five path/stroke pairs for the whole
    // field instead of one stroke per strike.
    const batches = new Map();

    for (let i = 0; i < this._strikes.length; i += 1) {
      const s = this._strikes[i];
      if (s.lat < bounds.getSouth() || s.lat > bounds.getNorth()) continue;
      if (s.lon < bounds.getWest() || s.lon > bounds.getEast()) continue;

      const colour = colourByAge ? colourForAge((end - s.ms) / lifespan) : STATIC_COLOUR;
      let batch = batches.get(colour);
      if (!batch) {
        batch = [];
        batches.set(colour, batch);
      }
      const point = leafletMap.latLngToContainerPoint([s.lat, s.lon]);
      batch.push(point.x, point.y);
    }

    let drawn = 0;
    for (const [colour, points] of batches) {
      drawn += points.length / 2;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      for (let i = 0; i < points.length; i += 2) {
        const x = points[i];
        const y = points[i + 1];
        ctx.moveTo(x - arm, y - arm);
        ctx.lineTo(x + arm, y + arm);
        ctx.moveTo(x + arm, y - arm);
        ctx.lineTo(x - arm, y + arm);
      }
      ctx.stroke();
    }

    this._drawn = drawn + this._renderBuffers(ctx, size, dpr);
    this._renderFlashes(ctx, leafletMap);
  },

  /** How many strikes the last frame actually put on screen. */
  drawnCount() {
    return this._drawn || 0;
  },

  /** Expanding rings for strikes that arrived in the last poll. */
  _renderFlashes(ctx, leafletMap) {
    if (!this._flashes.length) return;
    const now = performance.now();
    const DURATION = 900;
    const alive = [];

    for (const flash of this._flashes) {
      const t = (now - flash.start) / DURATION;
      if (t >= 1) continue;
      alive.push(flash);
      const point = leafletMap.latLngToContainerPoint([flash.lat, flash.lon]);
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = '#fff8c4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4 + t * 22, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    this._flashes = alive;
    if (alive.length) this._schedule();
  },

  /** Finds the nearest strike to a click and shows its time. */
  _onClick(event) {
    if (!this._strikes.length) return;
    const clickPoint = this._map.latLngToContainerPoint(event.latlng);
    let best = null;
    let bestDistance = 12 * 12; // squared pixels

    for (const s of this._strikes) {
      const point = this._map.latLngToContainerPoint([s.lat, s.lon]);
      const dx = point.x - clickPoint.x;
      const dy = point.y - clickPoint.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = s;
      }
    }
    if (!best) return;

    L.popup({ className: 'wx-popup-shell', closeButton: true })
      .setLatLng([best.lat, best.lon])
      .setContent(
        `<div class="wx-popup"><header class="wx-popup__head" style="--accent:#ffd700">
           <strong>Lightning strike</strong></header>
         <dl class="wx-popup__rows">
           <dt>Time</dt><dd>${new Date(best.ms).toISOString().replace('T', ' ').slice(0, 19)} UTC</dd>
           <dt>Position</dt><dd>${best.lat.toFixed(3)}, ${best.lon.toFixed(3)}</dd>
         </dl></div>`,
      )
      .openOn(this._map);
  },
});

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

let layer = null;
let previousKeys = new Set();

export function ensureStrikeLayer() {
  if (!layer) layer = new StrikeCanvasLayer({ pane: 'lightningPane' });
  if (!map.hasLayer(layer)) layer.addTo(map);
  return layer;
}

export function removeStrikeLayer() {
  if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

/**
 * Draws a filtered set. Strikes are decimated above the render ceiling so a
 * multi-day archive selection cannot stall the frame.
 */
export function drawStrikes(filtered, { end, lifespanHours }) {
  if (!lightning.showLayer) {
    removeStrikeLayer();
    return { drawn: 0, fresh: 0 };
  }

  const ceiling = runtime.lowEnd ? 4000 : TUNING.maxRenderedStrikes;
  let visible = filtered;
  if (filtered.length > ceiling) {
    const stride = Math.ceil(filtered.length / ceiling);
    visible = [];
    for (let i = 0; i < filtered.length; i += stride) visible.push(filtered[i]);
  }

  const keys = new Set(visible.map((s) => s.ms));
  const fresh = new Set();
  for (const key of keys) if (!previousKeys.has(key)) fresh.add(key);
  previousKeys = keys;

  ensureStrikeLayer().setStrikes(visible, { end, lifespanHours, newKeys: fresh });
  return { drawn: visible.length, fresh: fresh.size, decimated: visible.length < filtered.length };
}

/** Forces a redraw after a colour-mode change, without refiltering. */
export function refreshColours() {
  layer?._schedule();
}

export const getStrikeLayer = () => layer;
