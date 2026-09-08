/**
 * Estimated radar rainfall accumulation.
 *
 * Integrates the Global High Resolution radar composite over a time window to
 * produce a total-rainfall raster for the current viewport, then overlays it and
 * lets the user click for the accumulated total at a point.
 *
 * The heavy work happens in accumulation.worker.js. This module owns geometry
 * (which tiles cover the view, which output pixel maps to which tile pixel),
 * scheduling and presentation.
 */

import { map, safeRemove } from '../core/map.js';
import { emit, EVENTS } from '../core/bus.js';
import { DEVICE } from '../config.js';
import { encodedToMmh } from '../layers/radarScale.js';
import { isArchiveOnly, toArchiveUrl } from '../layers/windy.js';
import { floorUtcMinutes } from '../layers/urlTemplate.js';
import { spawnWorker } from '../core/worker.js';

/** Accumulated-depth colour ladder, in millimetres. */
export const MM_STOPS = [
  [0.05, [0, 0, 0, 0]], [0.5, [170, 210, 255, 150]], [1, [90, 170, 255, 165]],
  [2, [40, 120, 255, 175]], [5, [0, 190, 120, 185]], [10, [120, 220, 0, 195]],
  [20, [255, 230, 0, 205]], [30, [255, 165, 0, 215]], [50, [255, 80, 35, 225]],
  [75, [220, 0, 0, 235]], [100, [175, 0, 160, 240]], [150, [105, 0, 210, 245]],
  [200, [255, 255, 255, 250]], [999999, [255, 0, 255, 255]],
];

export function colourForMm(mm) {
  for (const [limit, rgba] of MM_STOPS) if (mm < limit) return rgba;
  return MM_STOPS[MM_STOPS.length - 1][1];
}

const FRAME_INTERVAL_MS = 5 * 60 * 1000;
const NATIVE_ZOOM = 7;

const state = {
  layer: null,
  totals: null,
  width: 0,
  height: 0,
  bounds: null,
  window: null,
  running: false,
  jobId: 0,
};

let worker = null;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

function lonLatToTilePixel(lon, lat, z) {
  const scale = 2 ** z;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

/**
 * Builds the output grid and, for each tile that covers it, the list of output
 * pixels it feeds. Grouping by tile means each tile is decoded once.
 */
function buildGroups(bounds, width, height, z) {
  const north = bounds.getNorth();
  const south = bounds.getSouth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  const groups = new Map();

  for (let row = 0; row < height; row += 1) {
    const lat = north - ((row + 0.5) / height) * (north - south);
    for (let col = 0; col < width; col += 1) {
      const lon = west + ((col + 0.5) / width) * (east - west);
      const { x, y } = lonLatToTilePixel(lon, lat, z);
      const xTile = Math.floor(x);
      const yTile = Math.floor(y);
      const key = `${xTile}_${yTile}`;

      let group = groups.get(key);
      if (!group) {
        group = { key, xTile, yTile, idx: [], px: [], py: [] };
        groups.set(key, group);
      }
      group.idx.push(row * width + col);
      group.px.push(Math.min(255, Math.floor((x - xTile) * 256)));
      group.py.push(Math.min(255, Math.floor((y - yTile) * 256)));
    }
  }

  return [...groups.values()].map((g) => ({
    key: g.key,
    xTile: g.xTile,
    yTile: g.yTile,
    idx: new Uint32Array(g.idx),
    px: new Uint16Array(g.px),
    py: new Uint16Array(g.py),
  }));
}

const pad = (n) => String(n).padStart(2, '0');

/** Windy composite tile URL for a specific frame and tile coordinate. */
function tileUrl(date, z, x, y) {
  const f = floorUtcMinutes(date, 5);
  const yyyy = f.getUTCFullYear();
  const mm = pad(f.getUTCMonth() + 1);
  const dd = pad(f.getUTCDate());
  const hhmm = pad(f.getUTCHours()) + pad(f.getUTCMinutes());
  const maxtDate = new Date(f.getTime() + (4 * 60 + 51) * 1000);
  const maxt = `${maxtDate.getUTCFullYear()}${pad(maxtDate.getUTCMonth() + 1)}${pad(maxtDate.getUTCDate())}${pad(maxtDate.getUTCHours())}${pad(maxtDate.getUTCMinutes())}${pad(maxtDate.getUTCSeconds())}`;
  return `https://rdr.windy.com/radar2/composite/${yyyy}/${mm}/${dd}/${hhmm}/${z}/${x}/${y}/reflectivity.webp?multichannel=true&maxt=${maxt}`;
}

function buildFrames(start, end) {
  const frames = [];
  const first = floorUtcMinutes(start, 5).getTime();
  const last = floorUtcMinutes(end, 5).getTime();
  for (let t = first; t <= last; t += FRAME_INTERVAL_MS) {
    frames.push({ time: new Date(t), durationHours: FRAME_INTERVAL_MS / 3600000 });
  }
  return frames;
}

/* ------------------------------------------------------------------ *
 * Worker
 * ------------------------------------------------------------------ */

function getWorker() {
  if (worker) return worker;
  worker = spawnWorker('accumulation.worker.js', new URL('./accumulation.worker.js', import.meta.url));
  return worker;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export const isRunning = () => state.running;
export const isPlotted = () => !!state.layer && map.hasLayer(state.layer);

/**
 * Calculates and plots an accumulation map for the current view.
 * @param {Date} start
 * @param {Date} end
 * @param {(percent:number, text:string)=>void} onProgress
 */
export async function calculate(start, end, onProgress = () => {}) {
  if (state.running) return { ok: false, reason: 'Already calculating' };
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) {
    return { ok: false, reason: 'End time must be after start time' };
  }

  const frames = buildFrames(start, end);
  if (!frames.length) return { ok: false, reason: 'That window contains no radar frames' };
  if (frames.length > 576) return { ok: false, reason: 'Window too long — 48 hours maximum' };

  state.running = true;
  const jobId = ++state.jobId;

  try {
    const bounds = map.getBounds();
    const container = map.getSize();
    // Cap the output grid: beyond this the extra detail is invisible but the
    // work grows quadratically.
    const maxPixels = DEVICE.mobile ? 240000 : 640000;
    const aspect = container.x / container.y;
    let height = Math.round(Math.sqrt(maxPixels / aspect));
    let width = Math.round(height * aspect);
    width = Math.max(64, Math.min(width, container.x));
    height = Math.max(64, Math.min(height, container.y));

    onProgress(2, 'Preparing accumulation grid');
    const groups = buildGroups(bounds, width, height, NATIVE_ZOOM);

    const workerFrames = frames.map((frame) => {
      const urls = {};
      for (const group of groups) {
        let url = tileUrl(frame.time, NATIVE_ZOOM, group.xTile, group.yTile);
        if (isArchiveOnly(url)) url = toArchiveUrl(url);
        urls[group.key] = url;
      }
      return { timeMs: frame.time.getTime(), durationHours: frame.durationHours, urls };
    });

    const result = await runWorker(jobId, width, height, workerFrames, groups, onProgress);
    if (jobId !== state.jobId) return { ok: false, reason: 'Superseded' };

    plot(result, bounds, width, height, { start, end });
    onProgress(100, `Accumulation complete · ${result.validFrames} frames`);

    return {
      ok: true,
      validFrames: result.validFrames,
      missingFrames: result.missingFrames,
      frames: frames.length,
    };
  } catch (error) {
    console.error('[accumulation] failed:', error);
    return { ok: false, reason: error?.message || 'Accumulation failed' };
  } finally {
    state.running = false;
  }
}

function runWorker(jobId, width, height, frames, groups, onProgress) {
  const w = getWorker();
  // Clone the typed arrays before transferring so a worker failure leaves the
  // originals usable.
  const cloned = groups.map((g) => ({
    key: g.key,
    xTile: g.xTile,
    yTile: g.yTile,
    idx: new Uint32Array(g.idx),
    px: new Uint16Array(g.px),
    py: new Uint16Array(g.py),
  }));
  const transfer = cloned.flatMap((g) => [g.idx.buffer, g.px.buffer, g.py.buffer]);

  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.jobId !== jobId) return;
      if (data.type === 'progress') {
        onProgress(data.percent, data.text);
      } else if (data.type === 'done') {
        cleanup();
        resolve({
          totals: new Float32Array(data.totalsBuffer),
          rgba: new Uint8ClampedArray(data.rgbaBuffer),
          validFrames: data.validFrames,
          missingFrames: data.missingFrames,
        });
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.message));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('Accumulation worker failed'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage(
      {
        type: 'calculate',
        jobId,
        width,
        height,
        frames,
        groups: cloned,
        colourStops: MM_STOPS,
        constants: { dbzPerEncodedUnit: 56 / 94, mmhNerf: 0.3 },
        concurrency: DEVICE.mobile ? 3 : 6,
      },
      transfer,
    );
  });
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

function plot(result, bounds, width, height, window) {
  unplot();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(result.rgba, width, height), 0, 0);

  state.layer = L.imageOverlay(canvas.toDataURL('image/png'), bounds, {
    opacity: 0.85,
    interactive: false,
    className: 'accumulation-overlay',
    pane: 'radarPane',
  }).addTo(map);

  state.totals = result.totals;
  state.width = width;
  state.height = height;
  state.bounds = bounds;
  state.window = window;

  map.on('click', onMapClick);
  emit(EVENTS.LEGEND_INVALIDATED);
}

export function unplot() {
  if (!state.layer) return;
  map.off('click', onMapClick);
  safeRemove(state.layer);
  state.layer = null;
  state.totals = null;
  state.bounds = null;
  emit(EVENTS.LEGEND_INVALIDATED);
}

/** Reads the accumulated total under a point. */
export function sampleAt(latlng) {
  if (!state.totals || !state.bounds || !state.bounds.contains(latlng)) return null;
  const north = state.bounds.getNorth();
  const south = state.bounds.getSouth();
  const west = state.bounds.getWest();
  const east = state.bounds.getEast();

  const col = Math.floor(((latlng.lng - west) / (east - west)) * state.width);
  const row = Math.floor(((north - latlng.lat) / (north - south)) * state.height);
  if (col < 0 || col >= state.width || row < 0 || row >= state.height) return null;
  return state.totals[row * state.width + col];
}

function onMapClick(event) {
  const mm = sampleAt(event.latlng);
  if (mm === null) return;
  const w = state.window;
  L.popup({ className: 'wx-popup-shell' })
    .setLatLng(event.latlng)
    .setContent(`
      <div class="wx-popup">
        <header class="wx-popup__head" style="--accent:#38bdf8"><strong>Accumulated rainfall</strong></header>
        <dl class="wx-popup__rows">
          <dt>Total</dt><dd>${mm.toFixed(mm < 10 ? 2 : 1)} mm</dd>
          <dt>Window</dt><dd>${w.start.toLocaleString('en-GB')} – ${w.end.toLocaleString('en-GB')}</dd>
        </dl>
      </div>`)
    .openOn(map);
}

/** Legend entries for the accumulation scale. */
export function legendStops() {
  return MM_STOPS.slice(1, -1).map(([limit, rgba]) => ({
    label: `${limit} mm`,
    colour: `rgba(${rgba.join(',')})`,
  }));
}

export { encodedToMmh };
