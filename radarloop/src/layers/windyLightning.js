/**
 * Live global strikes.
 *
 * The catalog has carried this product since the rewrite, but nothing ever
 * rendered it: `kind: 'windy-lightning'` fell through the renderer's switch to
 * the raster branch, which built a tile layer from an undefined URL and drew
 * nothing at all. The two endpoints for it sat in `config.js` unread by any
 * module.
 *
 * **The feed.** One endpoint still answers; the 5-minute frame endpoint is 404.
 * It returns a rolling window of roughly the last seven minutes of strikes
 * worldwide, refreshed continuously, so this layer polls and accumulates rather
 * than fetching a frame per timestamp. That is also why it cannot honour the
 * "past 24 hours" half of the name it used to carry: history builds up from the
 * moment it is switched on and no further back.
 *
 * **The coordinates.** Each strike arrives as four integers, `[t, x, y, flag]`,
 * with no projection stated. `t` is centiseconds. `x` and `y` are an 18-bit grid
 * — the maxima observed sit just under 2^18 — and the question is what that grid
 * spans. Four readings are possible, being linear or Mercator latitude, each
 * with either sign convention, and they are told apart by where they put the
 * lightning:
 *
 *   Web Mercator      33% of strikes poleward of 55 degrees, which does not happen
 *   linear, north-up  the Southern Ocean and the empty South Pacific
 *   linear, south-up  the Mediterranean, Sumatra, the Gulf coast and Texas
 *
 * The last is a textbook global distribution for the hour it was sampled — 0.4%
 * poleward of 55, afternoon convection over the Americas, the maritime continent
 * overnight — so `x` spans 360 degrees of longitude from the antimeridian and
 * `y` spans 180 degrees of latitude from the south pole, both linear.
 *
 * The fourth integer is not age: its values do not correlate with strike time at
 * all, every class averaging about five minutes old. It is left alone.
 */

import { ENDPOINTS } from '../config.js';
import { EVENTS, on } from '../core/bus.js';
import { lightning, time } from '../core/state.js';
import { StrikeCanvasLayer } from '../lightning/render.js';

/** The grid the provider quantises positions onto. */
const GRID = 262144;

/** How often to ask. The feed's own window is about seven minutes. */
const POLL_MS = 30000;

/**
 * Ceiling on retained strikes.
 *
 * A busy hour worldwide is a few hundred thousand, and the renderer decimates
 * above its own ceiling anyway, so this only bounds memory.
 */
const MAX_HELD = 300000;

/** Decodes one packed record into a strike. */
export function decodeStrike(record) {
  const [t, x, y] = record;
  return {
    ms: t * 100,
    lon: (x / GRID) * 360 - 180,
    lat: (y / GRID) * 180 - 90,
  };
}

/** Every strike in a feed response, oldest first. */
export function decodeFeed(payload) {
  const values = payload?.hotQueue?.values;
  if (!Array.isArray(values)) return [];
  const out = values.map(decodeStrike).filter((s) =>
    Number.isFinite(s.ms) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180);
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

/** Diagnostics, surfaced through window.RadarLoop for the checks. */
export const feedStats = { polls: 0, failed: 0, received: 0, held: 0, drawn: 0, lastAt: 0 };

/**
 * Draws the live feed through the same canvas the archive strikes use.
 *
 * Reusing `StrikeCanvasLayer` rather than writing a second renderer is what
 * makes these strikes look like strikes: the same age colouring, the same
 * lifespan, the same decimation ceiling, and the same flash on arrival.
 */
const WindyLightningLayer = StrikeCanvasLayer.extend({
  initialize(options = {}) {
    StrikeCanvasLayer.prototype.initialize.call(this, options);
    /** Keyed on the packed integers, which are exact and cheap to compare. */
    this._held = new Map();
    this._timer = null;
    this._stop = null;
  },

  onAdd(leafletMap) {
    StrikeCanvasLayer.prototype.onAdd.call(this, leafletMap);
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);
    // The scrubber decides which of the accumulated strikes are in view, the
    // same as it does for the archive.
    this._stop = on(EVENTS.TIME_COMMITTED, () => this._paint());
    return this;
  },

  onRemove(leafletMap) {
    clearInterval(this._timer);
    this._timer = null;
    this._stop?.();
    this._stop = null;
    this._held.clear();
    feedStats.held = 0;
    return StrikeCanvasLayer.prototype.onRemove.call(this, leafletMap);
  },

  async _poll() {
    feedStats.polls += 1;
    try {
      const response = await fetch(`${ENDPOINTS.windyLightningLive}?_=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const strikes = decodeFeed(await response.json());
      feedStats.received += strikes.length;
      feedStats.lastAt = Date.now();

      // Successive responses overlap by most of their window, so the store is
      // keyed rather than appended.
      for (const strike of strikes) this._held.set(`${strike.ms}|${strike.lat}|${strike.lon}`, strike);
      this._prune();
      this._paint();
    } catch (error) {
      feedStats.failed += 1;
      console.warn('[lightning] live feed:', error?.message || error);
    }
  },

  /** Drops anything older than the lifespan, and caps what is kept. */
  _prune() {
    const horizon = Date.now() - Math.max(1, lightning.lifespanHours) * 3600 * 1000;
    for (const [key, strike] of this._held) if (strike.ms < horizon) this._held.delete(key);
    if (this._held.size > MAX_HELD) {
      const excess = this._held.size - MAX_HELD;
      let dropped = 0;
      for (const key of this._held.keys()) {
        this._held.delete(key);
        dropped += 1;
        if (dropped >= excess) break;
      }
    }
    feedStats.held = this._held.size;
  },

  /** Hands the renderer whatever falls inside the scrubber's window. */
  _paint() {
    const end = time.current;
    const lifespanHours = Math.max(0.01, lightning.lifespanHours);
    const start = end - lifespanHours * 3600 * 1000;
    const visible = [];
    for (const strike of this._held.values()) {
      if (strike.ms >= start && strike.ms <= end) visible.push(strike);
    }
    visible.sort((a, b) => a.ms - b.ms);
    feedStats.drawn = visible.length;
    this.setStrikes(visible, { end, lifespanHours, newKeys: new Set() });
    this.options.onPainted?.();
  },
});

export const isWindyLightning = (kind) => kind === 'windy-lightning';

export function createWindyLightningLayer(options = {}) {
  return new WindyLightningLayer({ pane: 'lightningPane', ...options });
}
