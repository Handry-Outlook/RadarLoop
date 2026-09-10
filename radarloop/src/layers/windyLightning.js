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
import { latFromMercatorY, mercatorY, StrikeCanvasLayer } from '../lightning/render.js';

/** The grid the provider quantises positions onto: 18 bits per axis. */
const GRID = 1 << 18;

/** The only frame version this parser understands. */
const FRAME_VERSION = 2;

/** Archive frames fetched at once. A full day's window is 288 of them. */
const FRAME_CONCURRENCY = 6;

/** Shared empty arrays, so an empty frame allocates nothing. */
const EMPTY_F = new Float32Array(0);
const EMPTY_U = new Uint32Array(0);

/** Minimum gap between repaints while frames are still arriving. */
const PAINT_THROTTLE_MS = 400;

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
 * Archive frames
 * ------------------------------------------------------------------ */

/**
 * A five-minute archive frame, binary.
 *
 * The format did not yield to analysis of the bytes: fixed bit-fields at every
 * offset and width, both byte orders, all four latitude conventions and
 * cumulative deltas all scored at chance, and no byte's histogram correlated
 * with the real distribution of lightning. That last result was the telling one
 * — the high byte of a packed coordinate has to correlate — and it pointed at a
 * layout no single guess would find, so the answer came from the provider's own
 * client instead.
 *
 * A record is six bytes, occasionally eight:
 *
 *   0..1  x, big-endian, low 16 bits
 *   2..3  y, big-endian, low 16 bits
 *   4     bits 7-6 are x's high bits, 5-4 are y's, and 3-0 the intensity
 *   5     time since the previous strike, in centiseconds
 *
 * The two high bits of each coordinate living in a shared fifth byte is what
 * defeated every contiguous-field search. A time byte of 255 is an escape: the
 * elapsed time is then absolute, read as a big-endian pair from bytes 6..7, and
 * the record is eight bytes long. Frames without an escape divide evenly by six,
 * which is what made fixed six-byte records look certain.
 *
 * Coordinates are the same 18-bit grid the live feed uses, with the same linear
 * latitude — so the projection worked out from where the strikes fell was right
 * all along.
 *
 * Verified against the live feed over the same five minutes: 1960 of its 2212
 * strikes appear in the archive frame at identical coordinates, and 92.6% of the
 * frame lands in cells the live feed also has.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} frameMs  the frame's own timestamp, which times are relative to
 */
export function parseFrame(buffer, frameMs) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const empty = { mx: EMPTY_F, my: EMPTY_F, t: EMPTY_U, base: frameMs, count: 0 };
  if (bytes.length < 3) return empty;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== FRAME_VERSION) return empty;

  const count = view.getUint16(1);
  const mx = new Float32Array(count);
  const my = new Float32Array(count);
  const t = new Uint32Array(count);
  let at = 3;
  let elapsed = 0;
  let n = 0;

  for (let i = 0; i < count && at + 6 <= bytes.length; i += 1) {
    const high = view.getUint8(at + 4);
    const x = view.getUint16(at) + ((high & 0xc0) << 10);
    const y = view.getUint16(at + 2) + ((high & 0x30) << 12);
    const step = view.getUint8(at + 5);

    let size = 6;
    if (step < 255) {
      elapsed += step * 100;
    } else {
      // The escape restarts the clock rather than extending it.
      if (at + 8 > bytes.length) break;
      elapsed = view.getUint16(at + 6) * 100;
      size = 8;
    }

    // Projected here, once, rather than two million times per frame.
    mx[n] = x / GRID;
    my[n] = mercatorY((y / GRID) * 180 - 90);
    t[n] = elapsed;
    n += 1;
    at += size;
  }

  return n === count
    ? { mx, my, t, base: frameMs, count }
    : { mx: mx.subarray(0, n), my: my.subarray(0, n), t: t.subarray(0, n), base: frameMs, count: n };
}

/** One strike out of a buffer, as a position. For hit tests and checks. */
export function strikeAt(buffer, i) {
  return {
    ms: buffer.base + buffer.t[i],
    lat: latFromMercatorY(buffer.my[i]),
    lon: buffer.mx[i] * 360 - 180,
  };
}

/** A whole buffer as positions. Only for small ones — checks, mostly. */
export function bufferStrikes(buffer) {
  const out = new Array(buffer.count);
  for (let i = 0; i < buffer.count; i += 1) out[i] = strikeAt(buffer, i);
  return out;
}

/**
 * The slice of a frame that falls inside a window.
 *
 * Times ascend within a frame, so this is a binary search and a `subarray`:
 * no copying, and an edge frame costs the same as an interior one.
 */
export function sliceBuffer(buffer, startMs, endMs) {
  const { base, t, count } = buffer;
  const lo = lowerBound(t, count, Math.max(0, startMs - base));
  const hi = lowerBound(t, count, Math.max(0, endMs - base + 1));
  if (lo === 0 && hi === count) return buffer;
  if (hi <= lo) return null;
  return {
    mx: buffer.mx.subarray(lo, hi),
    my: buffer.my.subarray(lo, hi),
    t: t.subarray(lo, hi),
    base,
    count: hi - lo,
  };
}

/** First index whose value is at or above `target`. */
function lowerBound(values, count, target) {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Frames are published on five-minute boundaries. */
export const FRAME_MS = 5 * 60 * 1000;

/** How far back frames are kept. Measured: served at 24 h, empty by 26 h. */
export const ARCHIVE_HOURS = 24;

export const frameStart = (ms) => Math.floor(ms / FRAME_MS) * FRAME_MS;

/**
 * Every frame timestamp covering a window, oldest first.
 *
 * Clamped to the archive horizon: asking for older frames returns 204 for each
 * one, which is a request per five minutes of nothing.
 */
export function framesCovering(startMs, endMs, now = Date.now()) {
  const horizon = frameStart(now - ARCHIVE_HOURS * 3600 * 1000);
  const from = Math.max(frameStart(startMs), horizon);
  const to = frameStart(endMs);
  const out = [];
  for (let at = from; at <= to; at += FRAME_MS) out.push(at);
  return out;
}

/* ------------------------------------------------------------------ *
 * The layer
 * ------------------------------------------------------------------ */

/** Diagnostics, surfaced through window.RadarLoop for the checks. */
export const feedStats = {
  polls: 0, failed: 0, received: 0, held: 0, drawn: 0, lastAt: 0,
  framesWanted: 0, framesLoaded: 0, framesHeld: 0, available: 0,
};

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
    /** The live tail, keyed so overlapping responses do not duplicate. */
    this._held = new Map();
    /** Archive frames by their own timestamp; immutable once published. */
    this._frames = new Map();
    this._loading = new Set();
    this._timer = null;
    this._stop = null;
  },

  onAdd(leafletMap) {
    StrikeCanvasLayer.prototype.onAdd.call(this, leafletMap);
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);
    // The scrubber decides which of the accumulated strikes are in view, the
    // same as it does for the archive.
    this._stop = on(EVENTS.TIME_COMMITTED, () => {
      this._paint();
      this._ensureFrames();
    });
    this._ensureFrames();
    return this;
  },

  onRemove(leafletMap) {
    clearInterval(this._timer);
    this._timer = null;
    this._stop?.();
    this._stop = null;
    this._held.clear();
    this._frames.clear();
    this._loading.clear();
    feedStats.held = 0;
    feedStats.framesHeld = 0;
    return StrikeCanvasLayer.prototype.onRemove.call(this, leafletMap);
  },


  /**
   * Loads whatever archive frames the visible window needs.
   *
   * Frames are immutable once published, so a loaded one is kept until it falls
   * out of the window. A few are fetched at a time: a full day is 288 of them,
   * and firing that many at once starves everything else on the page.
   */
  async _ensureFrames() {
    const { start, end } = this._window();
    const wanted = framesCovering(start, end);
    const missing = wanted.filter((at) => !this._frames.has(at) && !this._loading.has(at));
    feedStats.framesWanted = wanted.length;

    // Drop what the window has left behind, so a day of scrubbing does not
    // accumulate a day of frames.
    const keep = new Set(wanted);
    for (const at of this._frames.keys()) if (!keep.has(at)) this._frames.delete(at);
    feedStats.framesHeld = this._frames.size;

    for (let i = 0; i < missing.length; i += FRAME_CONCURRENCY) {
      const batch = missing.slice(i, i + FRAME_CONCURRENCY);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(batch.map((at) => this._loadFrame(at)));
      if (!this._map) return;
      this._paintSoon();
    }
    if (missing.length) this._paint();
  },

  async _loadFrame(at) {
    this._loading.add(at);
    try {
      const response = await fetch(`${ENDPOINTS.windyLightningFrame}/${at}?version=3`, {
        credentials: 'omit',
      });
      // 204 is the provider's "nothing for this slot", not a failure.
      if (response.status === 204) {
        this._frames.set(at, { mx: EMPTY_F, my: EMPTY_F, t: EMPTY_U, base: at, count: 0 });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const frame = parseFrame(await response.arrayBuffer(), at);
      this._frames.set(at, frame);
      feedStats.framesLoaded += 1;
      feedStats.received += frame.count;
    } catch (error) {
      feedStats.failed += 1;
      console.warn('[lightning] archive frame:', error?.message || error);
    } finally {
      this._loading.delete(at);
      feedStats.framesHeld = this._frames.size;
    }
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

  /** Drops live-tail strikes the window has left behind, and caps what is kept. */
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

  /** The stretch of time the scrubber is asking for. */
  _window() {
    const end = time.current;
    const lifespanHours = Math.max(0.01, lightning.lifespanHours);
    return { start: end - lifespanHours * 3600 * 1000, end, lifespanHours };
  },

  /**
   * Hands the renderer every strike inside the scrubber's window.
   *
   * Nothing is sampled away. Frames are already typed arrays sorted by time, so
   * the ones wholly inside the window are passed straight through and the two at
   * the edges are sliced with a binary search — no copying, no per-strike work
   * here at all. What used to be an assembly pass over two million objects is now
   * a few hundred subarray views.
   */
  _paint() {
    const { start, end, lifespanHours } = this._window();
    const buffers = [];
    let total = 0;

    for (const [at, frame] of this._frames) {
      if (at + FRAME_MS < start || at > end) continue;
      const slice = at >= start && at + FRAME_MS <= end ? frame : sliceBuffer(frame, start, end);
      if (!slice || !slice.count) continue;
      buffers.push(slice);
      total += slice.count;
    }

    const tail = this._tailBuffer(start, end);
    if (tail) {
      buffers.push(tail);
      total += tail.count;
    }

    feedStats.available = total;
    this.setStrikeBuffers(buffers, { end, lifespanHours });
    feedStats.drawn = total;
    this.options.onPainted?.();
  },

  /**
   * The live tail as a buffer.
   *
   * Small — a few thousand at most — so it is rebuilt each paint rather than
   * maintained incrementally, which keeps the deduplicating map as the only
   * copy of the truth.
   */
  _tailBuffer(start, end) {
    const held = [...this._held.values()].filter((s) => s.ms >= start && s.ms <= end);
    if (!held.length) return null;
    held.sort((a, b) => a.ms - b.ms);
    const base = held[0].ms;
    const mx = new Float32Array(held.length);
    const my = new Float32Array(held.length);
    const t = new Uint32Array(held.length);
    for (let i = 0; i < held.length; i += 1) {
      mx[i] = (held[i].lon + 180) / 360;
      my[i] = mercatorY(held[i].lat);
      t[i] = held[i].ms - base;
    }
    return { mx, my, t, base, count: held.length };
  },

  /** Repaints at most this often while a run of frames is arriving. */
  _paintSoon() {
    const now = Date.now();
    if (now - (this._paintedAt || 0) < PAINT_THROTTLE_MS) return;
    this._paintedAt = now;
    this._paint();
  },
});

export const isWindyLightning = (kind) => kind === 'windy-lightning';

export function createWindyLightningLayer(options = {}) {
  return new WindyLightningLayer({ pane: 'lightningPane', ...options });
}
