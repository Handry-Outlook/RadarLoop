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
 * The layer
 * ------------------------------------------------------------------ */

export const StrikeCanvasLayer = L.Layer.extend({
  initialize(options = {}) {
    L.setOptions(this, options);
    this._strikes = [];
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

    for (const [colour, points] of batches) {
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

    this._renderFlashes(ctx, leafletMap);
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
