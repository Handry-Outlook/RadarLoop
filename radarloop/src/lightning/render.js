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
/**
 * Age ramp, newest to oldest, as fractions of the lifespan.
 *
 * Six even bands: white, then red deepening to maroon, then blue. It is the
 * scale operational displays use, and it works because the two ends are
 * opposite in both hue and temperature — there is no reading a white mark as an
 * old one. The previous ramp ran gold to violet through two pinks, which are
 * neighbours at a glance, so the middle of an hour was hard to place.
 *
 * Even bands rather than the absolute ten-minute steps of a sixty-minute
 * display: the lifespan here is the user's to set, so the bands follow it.
 */
const AGE_STOPS = [
  [1 / 6, '#ffffff'],
  [2 / 6, '#ff4d4d'],
  [3 / 6, '#e00000'],
  [4 / 6, '#8f0000'],
  [5 / 6, '#3a6de0'],
  [Infinity, '#1b2f7a'],
];

/**
 * Strikes that arrived since the last refresh, drawn apart from the ramp.
 *
 * A blue bolt, larger than the squares. It is a different question from age —
 * "this just came in" rather than "this is the youngest of what is shown" — so
 * it gets a band of its own rather than a place on the scale.
 */
const FRESH_BAND = -2;
const FRESH_COLOUR = '#38bdf8';

/**
 * Drawn under every mark, so a white one is visible on a light basemap.
 *
 * The ramp's newest band is white because that is what the operational scale
 * does, and that scale is read on a dark grey map. Here the base map might be
 * anything, and an unhaloed white square on light terrain is not there at all.
 */
const MARK_HALO = 'rgba(2,6,23,0.55)';

export function colourForAge(fraction) {
  for (const [limit, colour] of AGE_STOPS) if (fraction < limit) return colour;
  return AGE_STOPS[AGE_STOPS.length - 1][1];
}

const TWO_PI = Math.PI * 2;

/**
 * A lightning bolt, as offsets from the mark's centre in units of its half-size.
 *
 * Hand-placed rather than generated: at five pixels tall a bolt is a handful of
 * vertices and the difference between one that reads and one that looks like a
 * smudge is where they sit, not how many there are.
 */
const BOLT = [
  [0.18, -1], [-0.62, 0.1], [-0.1, 0.1], [-0.28, 1], [0.62, -0.2], [0.1, -0.2],
];

/** Adds a closed polygon to the current path, scaled and centred. */
function tracePath(ctx, points, x, y, size) {
  ctx.moveTo(x + points[0][0] * size, y + points[0][1] * size);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(x + points[i][0] * size, y + points[i][1] * size);
  }
  ctx.closePath();
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

/**
 * Above this many held strikes, the visible count is taken from the last frame
 * rather than recounted. A quarter of a million is a couple of milliseconds to
 * count and far more than any view that could still be drawing shapes.
 */
const COUNT_EXACTLY_BELOW = 250000;

/** Age ramp as packed pixels, for the dense path. */
const AGE_PIXELS = AGE_STOPS.map(([, colour]) => packColour(colour));
const STATIC_PIXEL = packColour(STATIC_COLOUR);
const FRESH_PIXEL = packColour(FRESH_COLOUR);

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
    this._freshSince = 0;
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
  setStrikeBuffers(buffers, { end, lifespanHours, freshSince } = {}) {
    this._buffers = buffers || [];
    if (freshSince !== undefined) this._freshSince = freshSince;
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
    // How many are on screen decides which path draws them, and the honest way
    // to know is to count. That is two multiplies and two comparisons a strike,
    // so it is only worth avoiding when there are a great many; below that the
    // previous frame's figure is a worse answer than the real one. Using it
    // unconditionally left the first frame after a zoom drawing the old
    // decision — pixels where there was now room for shapes.
    let total = 0;
    for (const buffer of this._buffers) total += buffer.count;
    const dense = total > COUNT_EXACTLY_BELOW
      ? (this._lastVisible || 0) > DENSE_THRESHOLD
      : this._countVisible(scale, origin.x, origin.y, size) > DENSE_THRESHOLD;
    const view = {
      scale, originX: origin.x, originY: origin.y, pad: 8, w: size.x, h: size.y, dpr,
    };

    const runs = this._ageRuns();
    this._lastMode = dense ? 'splat' : 'stroke';
    const drawn = dense ? this._splatRuns(ctx, view, runs) : this._strokeRuns(ctx, view, runs);
    this._lastVisible = drawn;
    return drawn;
  },

  /** How many buffered strikes fall inside the view. */
  _countVisible(scale, originX, originY, size) {
    const pad = 8;
    let visible = 0;
    for (const buffer of this._buffers) {
      const { mx, my, count } = buffer;
      for (let i = 0; i < count; i += 1) {
        const x = mx[i] * scale - originX;
        if (x < -pad || x > size.x + pad) continue;
        const y = my[i] * scale - originY;
        if (y < -pad || y > size.y + pad) continue;
        visible += 1;
      }
    }
    return visible;
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
    const fresh = this._freshSince;
    const runs = [];

    for (const buffer of this._buffers) {
      if (!buffer.count) continue;

      // Arrivals sit at the end of a time-ordered buffer, so they cut off with
      // one search and the bands are worked out over what is left.
      let top = buffer.count;
      if (fresh) {
        const from = firstAtOrAfter(buffer, fresh);
        if (from < top) {
          runs.push([buffer, from, top, FRESH_BAND]);
          top = from;
        }
      }
      if (!top) continue;

      if (!lightning.colorByAge) {
        runs.push([buffer, 0, top, -1]);
        continue;
      }
      // Age rises with time-before-`end`, so the youngest band is the newest
      // strikes: walk the stops from the newest boundary backwards.
      let to = top;
      for (let band = 0; band < AGE_STOPS.length && to > 0; band += 1) {
        const limit = AGE_STOPS[band][0];
        const from = limit === Infinity
          ? 0
          : Math.min(top, firstAtOrAfter(buffer, end - limit * lifespan));
        if (from < to) runs.push([buffer, from, to, band]);
        to = from;
      }
    }
    return runs;
  },

  /**
   * The sparse mode.
   *
   * Three mark styles, chosen per layer because the sources differ in what they
   * need to say.
   *
   * `age` is the in-house feed: a bolt for strikes in the newest age band and a
   * small open square for everything older. Shape carries the same information
   * as colour, which is the point — a field of identical crosses tinted five
   * ways makes you read the legend to find out what just happened, whereas a
   * bolt among squares is legible at a glance and survives being printed,
   * screenshotted or looked at by someone who cannot separate the hues.
   *
   * `dot` is the global feed, an order of magnitude denser, where anything with
   * structure turns to texture.
   *
   * `cross` is the plain fallback.
   */
  _strokeRuns(ctx, view, runs) {
    const { scale, originX, originY, pad, w, h } = view;
    const style = this.options.mark || 'cross';
    const small = runtime.lowEnd;
    const arm = small ? 3.5 : 4.5;
    const dot = small ? 1.6 : 2.1;
    const box = small ? 1.8 : 2.2;
    const bolt = small ? 4.2 : 5.2;
    let drawn = 0;

    // Newest last, so a fresh strike is never buried under an older one. The
    // arrivals band sorts below every age band, which puts it on top.
    const ordered = style === 'age' ? [...runs].sort((a, b) => b[3] - a[3]) : runs;

    for (const [buffer, from, to, band] of ordered) {
      const { mx, my } = buffer;
      const arrival = band === FRESH_BAND;
      const colour = arrival ? FRESH_COLOUR : (band < 0 ? STATIC_COLOUR : AGE_STOPS[band][1]);
      const filled = style === 'dot' || arrival;
      const width = style === 'age' ? (small ? 1 : 1.2) : (small ? 1.4 : 1.8);

      ctx.beginPath();
      let any = false;
      for (let i = from; i < to; i += 1) {
        const x = mx[i] * scale - originX;
        if (x < -pad || x > w + pad) continue;
        const y = my[i] * scale - originY;
        if (y < -pad || y > h + pad) continue;

        if (style === 'dot') {
          // moveTo before arc, or each dot is joined to the last by a chord.
          ctx.moveTo(x + dot, y);
          ctx.arc(x, y, dot, 0, TWO_PI);
        } else if (arrival) {
          tracePath(ctx, BOLT, x, y, bolt);
        } else if (style === 'age') {
          // `rect` opens its own subpath, so these batch without a moveTo.
          ctx.rect(x - box, y - box, box * 2, box * 2);
        } else {
          ctx.moveTo(x - arm, y - arm);
          ctx.lineTo(x + arm, y + arm);
          ctx.moveTo(x + arm, y - arm);
          ctx.lineTo(x - arm, y + arm);
        }
        any = true;
        drawn += 1;
      }
      if (!any) continue;

      // The path is built once and drawn twice: a dark outline underneath, then
      // the mark itself. Without it the newest band, which is white, disappears
      // on a light base map.
      if (style === 'age') {
        ctx.strokeStyle = MARK_HALO;
        ctx.lineWidth = width + 1.1;
        ctx.stroke();
      }
      ctx.lineWidth = width;
      if (filled) {
        ctx.fillStyle = colour;
        ctx.fill();
      } else {
        ctx.strokeStyle = colour;
        ctx.stroke();
      }
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
      const colour = band === FRESH_BAND ? FRESH_PIXEL : (band < 0 ? STATIC_PIXEL : AGE_PIXELS[band]);
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

  /** Rings on the strikes that arrived since the last draw. */
  flashArrivals(strikes, newKeys) {
    const now = performance.now();
    let budget = DEVICE.mobile ? 6 : 14;
    for (const strike of strikes) {
      if (budget <= 0) break;
      if (!newKeys.has(strike.ms)) continue;
      this._flashes.push({ lat: strike.lat, lon: strike.lon, start: now });
      budget -= 1;
    }
    this._schedule();
    return this;
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

    // The buffers hold the same thing in projected form, so the search is the
    // same two multiplies the drawing uses rather than a Leaflet call per strike.
    if (this._buffers.length) {
      const scale = this._map.getPixelWorldBounds().getSize().x;
      const origin = this._map.getPixelBounds().min;
      for (const buffer of this._buffers) {
        const { mx, my, t, base, count } = buffer;
        for (let i = 0; i < count; i += 1) {
          const dx = (mx[i] * scale - origin.x) - clickPoint.x;
          if (dx > 12 || dx < -12) continue;
          const dy = (my[i] * scale - origin.y) - clickPoint.y;
          if (dy > 12 || dy < -12) continue;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { ms: base + t[i], lat: latFromMercatorY(my[i]), lon: mx[i] * 360 - 180 };
          }
        }
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
/** Newest strike time at the last draw, so arrivals can be told apart. */
let previousNewest = 0;

export function ensureStrikeLayer() {
  if (!layer) layer = new StrikeCanvasLayer({ pane: 'lightningPane', mark: 'age' });
  if (!map.hasLayer(layer)) layer.addTo(map);
  return layer;
}

export function removeStrikeLayer() {
  if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

/**
 * Draws a filtered set.
 *
 * The strikes are packed into a typed buffer and handed to the same path the
 * global feed uses. That does two things at once: the shaped marks live there,
 * and so does the drawing of every strike. This used to decimate above a render
 * ceiling — on a busy day you were looking at a sample of the field, thinned by
 * a stride, with no indication that anything was missing.
 */
export function drawStrikes(filtered, { end, lifespanHours }) {
  if (!lightning.showLayer) {
    removeStrikeLayer();
    return { drawn: 0, fresh: 0 };
  }

  const keys = new Set();
  const fresh = new Set();
  for (const s of filtered) {
    keys.add(s.ms);
    if (!previousKeys.has(s.ms)) fresh.add(s.ms);
  }
  previousKeys = keys;

  // Everything after the newest strike we had last time is an arrival. A
  // timestamp rather than the key set, because the renderer works in buffers
  // where a run is a pair of indices and a set would be a lookup per strike.
  const freshSince = previousNewest && fresh.size ? previousNewest + 1 : 0;
  previousNewest = filtered.length ? filtered[filtered.length - 1].ms : previousNewest;

  const layerRef = ensureStrikeLayer();
  layerRef.setStrikeBuffers(filtered.length ? [packStrikes(filtered)] : [], {
    end, lifespanHours, freshSince,
  });

  // The arrival flash still works from the objects: it is a handful of rings,
  // and it needs positions rather than a scan of the whole field.
  if (fresh.size) layerRef.flashArrivals(filtered, fresh);

  return { drawn: filtered.length, fresh: fresh.size, decimated: false };
}

/**
 * Packs strikes into the typed form the renderer draws from.
 *
 * Positions are projected here, once, rather than per frame — Web Mercator costs
 * a logarithm and a tangent each, and a frame should not be paying for those.
 */
export function packStrikes(strikes) {
  const sorted = strikes[0] && strikes[strikes.length - 1].ms >= strikes[0].ms
    ? strikes
    : [...strikes].sort((a, b) => a.ms - b.ms);
  const base = sorted[0].ms;
  const count = sorted.length;
  const mx = new Float32Array(count);
  const my = new Float32Array(count);
  const t = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    mx[i] = mercatorX(sorted[i].lon);
    my[i] = mercatorY(sorted[i].lat);
    t[i] = Math.max(0, sorted[i].ms - base);
  }
  return { mx, my, t, base, count };
}

/** Forces a redraw after a colour-mode change, without refiltering. */
export function refreshColours() {
  layer?._schedule();
}

export const getStrikeLayer = () => layer;
