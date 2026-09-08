/**
 * Worker pool that turns Windy radar tiles into ready-to-draw bitmaps.
 *
 * Everything expensive about the product — fetching, decoding, cropping the
 * parent tile above native zoom, and recolouring every pixel through the
 * rainfall scale — happens off the main thread here. The main thread only blits
 * the returned ImageBitmap.
 *
 * That is what lets 3D keep the same tile resolution as 2D. The earlier attempt
 * at making 3D scrubbing bearable dropped the device pixel ratio to 1 there and
 * downsampled the mirrored composite, which cost real detail; with the pixel
 * work parallelised across cores, neither compromise is needed.
 *
 * Everything degrades gracefully: if workers, OffscreenCanvas or
 * `createImageBitmap` are missing, `available()` is false and the caller keeps
 * its main-thread path.
 */

import { colourForMmh, encodedToMmh, getLevels, getSignature } from './radarScale.js';
import { spawnWorker } from '../core/worker.js';

/** Diagnostics surfaced through window.RadarLoop for the perf tests. */
export const poolStats = { workers: 0, decoded: 0, failed: 0, inFlight: 0 };

const supported = typeof Worker === 'function'
  && typeof OffscreenCanvas === 'function'
  && typeof createImageBitmap === 'function'
  && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function';

/** True when tiles can be decoded off the main thread. */
export const available = () => supported;

/* ------------------------------------------------------------------ *
 * Colour table
 * ------------------------------------------------------------------ */

let lutId = '';

/**
 * Builds the table the worker indexes by `r + g`.
 *
 * Windy's encoded value is `(r + g) / 2`, so a 511-entry table keyed on the sum
 * reproduces the main-thread maths exactly — a 256-entry table would quantise
 * the half-steps away.
 */
function buildLut() {
  const levels = getLevels();
  const lut = new Uint8ClampedArray(511 * 4);
  for (let sum = 2; sum <= 510; sum += 1) {
    const colour = colourForMmh(encodedToMmh(sum / 2), levels);
    if (!colour) continue;
    const i = sum * 4;
    lut[i] = colour[0];
    lut[i + 1] = colour[1];
    lut[i + 2] = colour[2];
    lut[i + 3] = colour[3];
  }
  return lut;
}

/* ------------------------------------------------------------------ *
 * Pool
 * ------------------------------------------------------------------ */

const workers = [];
const pending = new Map();
let nextId = 0;
let cursor = 0;

/**
 * Leaves a core for the main thread and for GL. Four workers already cover a
 * viewport's ~40 tiles in two passes; more mostly adds contention.
 */
function poolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores - 1));
}

function handleMessage(event) {
  const { id, ok, bitmap, usedIndex, error } = event.data;
  const entry = pending.get(id);
  if (!entry) {
    bitmap?.close?.();
    return;
  }
  pending.delete(id);
  poolStats.inFlight = pending.size;
  if (ok) {
    poolStats.decoded += 1;
    entry.resolve({ bitmap, usedIndex });
  } else {
    poolStats.failed += 1;
    entry.reject(new Error(error || 'tile decode failed'));
  }
}

function ensurePool() {
  if (workers.length) return true;
  try {
    for (let i = 0; i < poolSize(); i += 1) {
      const worker = spawnWorker('windyTile.worker.js', new URL('./windyTile.worker.js', import.meta.url));
      worker.onmessage = handleMessage;
      // A worker that dies takes its queued tiles with it; those reject and the
      // caller falls back to the main-thread path for them.
      worker.onerror = () => { worker.__dead = true; };
      workers.push(worker);
    }
  } catch (error) {
    console.warn('[windy] tile workers unavailable, decoding inline:', error);
    workers.length = 0;
    return false;
  }
  poolStats.workers = workers.length;
  syncLut();
  return true;
}

/** Pushes the current scale to every worker when it changes. */
function syncLut() {
  const signature = getSignature();
  if (signature === lutId) return;
  lutId = signature;
  const lut = buildLut();
  // Each worker keeps its own copy; the table is 2 KB, so cloning beats the
  // bookkeeping of a shared buffer.
  for (const worker of workers) worker.postMessage({ type: 'lut', lutId, lut });
}

/**
 * Decodes and recolours one tile.
 *
 * @param {object} job
 * @param {string[]} job.urls  candidate URLs, tried in order (live then archive)
 * @param {number} job.dw      destination width in device pixels
 * @param {number} job.dh      destination height in device pixels
 * @param {{fx:number,fy:number,scale:number}|null} job.crop
 *        which fraction of the parent tile to take, above native zoom
 * @returns {Promise<{bitmap: ImageBitmap, usedIndex: number}>}
 */
export function decodeTile({ urls, dw, dh, crop = null }) {
  if (!supported || !ensurePool()) return Promise.reject(new Error('no tile workers'));
  syncLut();

  const id = nextId;
  nextId += 1;

  // Round-robin rather than least-loaded: tiles cost about the same, and the
  // queue drains in arrival order either way.
  const worker = workers[cursor % workers.length];
  cursor += 1;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    poolStats.inFlight = pending.size;
    try {
      worker.postMessage({ id, urls, dw, dh, crop, lutId });
    } catch (error) {
      pending.delete(id);
      poolStats.inFlight = pending.size;
      reject(error);
    }
  });
}
