/**
 * Global High Resolution satellite (visible + infrared).
 *
 * The provider serves one 256x512 PNG per 256x256 map tile, which no slippy-map
 * client expects, and the pixels look like structured noise until two things are
 * undone:
 *
 *  1. **Alternate 16px blocks are inverted.** In a checkerboard pattern, every
 *     other block carries `255 - v`. The giveaway was a tile whose western half
 *     was empty: the void rendered as pure black squares against pure white ones,
 *     which are the two ways one value can appear if half the blocks are negated.
 *     Undoing it turns the noise into cloud.
 *  2. **The two halves are two channels, not two rows.** Comparing the lower half
 *     of a tile against the upper half of its southern neighbour gave a mean
 *     difference of 42.8 where an identical region scores 0 and an unrelated one
 *     scores 84.9 — so the halves are the visible and infrared views of the same
 *     ground, as the product name says. Visible is on top (mean neighbour
 *     difference 10.5, the sharper picture), infrared below (3.2).
 *
 * The visible channel is a photograph and therefore blank on the night side, so
 * the default product blends the two by solar elevation: visible where the sun is
 * up, infrared where it is not, faded across the terminator. That calculation is
 * done here, per tile, as a coarse grid the worker interpolates — solar elevation
 * varies smoothly enough over 256px that sampling it 17 times across is exact to
 * far better than a pixel.
 *
 * Everything else follows layers/windy.js: native tiles stop at zoom 7 and deeper
 * zooms crop the z7 parent, and the per-pixel work runs in the shared tile worker
 * pool so 3D can hold the same resolution as 2D.
 */

import { loadSetting, saveSetting } from '../core/util.js';
import { daylightWeight, sinSolarElevation, sunPosition } from './solar.js';
import { available as workersAvailable, decodeTile } from './windyPool.js';

export const MAX_NATIVE_ZOOM = 7;

/** Side of the inverted-block checkerboard, in source pixels. */
export const BLOCK = 16;

/** Resolution of the per-tile daylight grid, in cells across. */
const GRID = 16;

/**
 * Which channel each product shows.
 *
 * The single-channel products exist alongside the composite because the two are
 * genuinely different instruments: infrared works at night and reads cloud-top
 * temperature, visible resolves texture and the low cloud infrared cannot
 * separate from the ground.
 */
const CHANNELS = {
  'windy-visir': 'composite',
  'windy-visible': 'vis',
  'windy-infrared': 'ir',
};

export const isWindySat = (type) => Object.prototype.hasOwnProperty.call(CHANNELS, type);
export const channelFor = (type) => CHANNELS[type] || 'composite';

/* ------------------------------------------------------------------ *
 * Live and archive endpoints
 * ------------------------------------------------------------------ */

/**
 * How far back the live endpoint reaches, as a starting guess.
 *
 * Measured at 200 for a frame 14 hours old and 404 for one 15.5 hours old, with
 * the boundary sitting close enough to midnight UTC that a rolling window and a
 * since-midnight rule cannot be told apart from one afternoon's samples. It does
 * not need to be told apart: the live endpoint is simply tried first and the real
 * boundary is learned from the first miss, exactly as the radar composite does.
 * The guess only saves a wasted request.
 */
const LIVE_WINDOW_MS = 16 * 60 * 60 * 1000;
const ARCHIVE_CUTOFF_KEY = 'windySatArchiveCutoffMs';

/** `/satellite/[archive/]composite/YYYY-MM-DD-HHMMSS/z/x/y/visir.png` */
const PATH_RE = /\/composite\/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\//;

const pad = (n) => String(n).padStart(2, '0');
const parts = (ms) => {
  const d = new Date(ms);
  return [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()),
    pad(d.getUTCHours()), pad(d.getUTCMinutes()), pad(d.getUTCSeconds())];
};

/** The frame time encoded in a tile URL's path. */
export function frameTimeFromUrl(url) {
  const m = String(url).match(PATH_RE);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export const toLiveUrl = (url) =>
  String(url).replace('/satellite/archive/composite/', '/satellite/composite/');

/**
 * The archive form of a tile URL.
 *
 * Two changes, not one. The path gains its `archive` segment, and the frame is
 * snapped down to the hour — the archive keeps hourly frames only, so five
 * requests in six would otherwise be for a frame that was never written. That is
 * what made an early reading of this endpoint look like it held nothing older
 * than a day: the probe was asking for :50.
 */
export function toArchiveUrl(url) {
  const frameMs = frameTimeFromUrl(url);
  if (frameMs === null) return String(url);
  const hourMs = Math.floor(frameMs / 3600000) * 3600000;
  const [y, mo, d, hh] = parts(hourMs);
  const [my, mmo, md, mhh, mmm] = parts(hourMs + 4 * 60000);

  return String(url)
    .replace('/satellite/composite/', '/satellite/archive/composite/')
    .replace(PATH_RE, `/composite/${y}-${mo}-${d}-${hh}0000/`)
    .replace(/maxt=\d{14}/, `maxt=${my}${mmo}${md}${mhh}${mmm}00`);
}

/** The frame the archive would actually serve for a given moment. */
export const archiveFrameTime = (frameMs) => Math.floor(frameMs / 3600000) * 3600000;

const getCutoff = () => {
  const value = Number(loadSetting(ARCHIVE_CUTOFF_KEY, 0));
  return Number.isFinite(value) && value > 0 ? value : null;
};

function rememberCutoff(frameMs) {
  if (!Number.isFinite(frameMs)) return;
  saveSetting(ARCHIVE_CUTOFF_KEY, Math.max(getCutoff() || 0, frameMs));
}

/** True when a frame is old enough that the live endpoint will not have it. */
export function isArchiveOnly(url, now = Date.now()) {
  const frameMs = frameTimeFromUrl(url);
  return Number.isFinite(frameMs) && now - frameMs >= LIVE_WINDOW_MS;
}

function preferArchive(url) {
  if (isArchiveOnly(url)) return true;
  const frameMs = frameTimeFromUrl(url);
  const cutoff = getCutoff();
  return Number.isFinite(frameMs) && Number.isFinite(cutoff) && frameMs <= cutoff;
}

/* ------------------------------------------------------------------ *
 * Pixel decoding
 * ------------------------------------------------------------------ */

/**
 * Undoes the checkerboard inversion the provider applies to alternate blocks.
 *
 * The two halves do not share a parity: the visible channel carries `255 - v` in
 * the blocks where the infrared channel carries `v`. Both candidate decodes are
 * exact negatives of one another, so nothing in the pixels distinguishes them —
 * the seams are equally smooth either way. What settles it is the ground: over
 * the Atlantic coast of the western Sahara the desert is the brightest thing a
 * visible channel sees and the open ocean nearly the darkest, while in the
 * infrared the baking sand is darkest and the cold cloud tops brightest. Only
 * one assignment puts both the right way up, and it is this one.
 */
export function deinvertBlocks(imageData) {
  const { data, width, height } = imageData;
  const half = height / 2;
  for (let y = 0; y < height; y += 1) {
    // The channel index enters the parity, which is what makes the halves differ.
    const rowParity = (((y / BLOCK) | 0) + (y >= half ? 1 : 0)) % 2;
    for (let x = 0; x < width; x += 1) {
      if ((((x / BLOCK) | 0) + rowParity) % 2 !== 0) continue;
      const i = (y * width + x) * 4;
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
  }
  return imageData;
}

/**
 * How opaque a given brightness is drawn.
 *
 * Clear sky in the infrared channel is a warm, dark surface and cloud is bright,
 * so fading the dark end out lets the base map show through where there is
 * nothing to see. The ramp is wide and starts low on purpose: the aim is to stop
 * the layer reading as an opaque grey sheet, not to threshold the imagery into
 * cloud and not-cloud, which would throw away thin cirrus and fog.
 */
export const ALPHA_LO = 40;
export const ALPHA_HI = 120;

/**
 * Builds the finished 256x256 tile from a de-inverted 256x512 source.
 *
 * @param {ImageData} source   de-inverted, full height (both channels)
 * @param {ImageData} out      half height, the destination
 * @param {string} channel     'composite' | 'vis' | 'ir'
 * @param {Float32Array|null} weights (GRID+1)^2 daylight weights, row-major
 */
export function composeChannels(source, out, channel, weights) {
  const w = source.width;
  const half = source.height / 2;
  const src = source.data;
  const dst = out.data;
  const span = ALPHA_HI - ALPHA_LO;

  for (let y = 0; y < half; y += 1) {
    // Bilinear row terms, resolved once per row rather than per pixel.
    const gy = (y / half) * GRID;
    const y0 = Math.min(GRID - 1, gy | 0);
    const fy = gy - y0;

    for (let x = 0; x < w; x += 1) {
      const vis = src[(y * w + x) * 4];
      const ir = src[((y + half) * w + x) * 4];

      let v;
      if (channel === 'ir') {
        v = ir;
      } else if (channel === 'vis') {
        v = vis;
      } else if (vis <= 1) {
        // The visible channel's own empty value, which covers the unlit
        // hemisphere and everything else the sun is not reaching.
        v = ir;
      } else if (!weights) {
        v = vis;
      } else {
        const gx = (x / w) * GRID;
        const x0 = Math.min(GRID - 1, gx | 0);
        const fx = gx - x0;
        const r0 = y0 * (GRID + 1) + x0;
        const r1 = r0 + GRID + 1;
        const day = (weights[r0] * (1 - fx) + weights[r0 + 1] * fx) * (1 - fy)
          + (weights[r1] * (1 - fx) + weights[r1 + 1] * fx) * fy;
        v = ir + (vis - ir) * day;
      }

      const o = (y * w + x) * 4;
      dst[o] = v;
      dst[o + 1] = v;
      dst[o + 2] = v;
      dst[o + 3] = v <= ALPHA_LO ? 0 : (v >= ALPHA_HI ? 255 : ((v - ALPHA_LO) / span) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Daylight grid
 * ------------------------------------------------------------------ */

/** Web Mercator tile fraction to latitude, in degrees. */
const latAt = (worldY) => Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * (180 / Math.PI);

/**
 * Samples the daylight weight over one tile's extent.
 *
 * Returns null when the tile is unambiguously all day or all night, which is the
 * common case: the caller then skips the blend entirely rather than interpolating
 * a constant.
 *
 * @param {{x: number, y: number, z: number}} coords display tile coordinates
 * @param {number} atMs frame time
 * @returns {{grid: Float32Array|null, allNight: boolean}}
 */
export function daylightGrid(coords, atMs) {
  const sun = sunPosition(atMs);
  const scale = 2 ** coords.z;
  const grid = new Float32Array((GRID + 1) * (GRID + 1));

  let allDay = true;
  let allNight = true;
  for (let gy = 0; gy <= GRID; gy += 1) {
    const lat = latAt((coords.y + gy / GRID) / scale);
    for (let gx = 0; gx <= GRID; gx += 1) {
      const lon = ((coords.x + gx / GRID) / scale) * 360 - 180;
      const weight = daylightWeight(sinSolarElevation(sun, lat, lon));
      grid[gy * (GRID + 1) + gx] = weight;
      if (weight < 1) allDay = false;
      if (weight > 0) allNight = false;
    }
  }
  return { grid: allDay || allNight ? null : grid, allNight };
}

/* ------------------------------------------------------------------ *
 * The tile layer
 * ------------------------------------------------------------------ */

/** Device pixel ratio rounded up to a whole step, as the radar composite does. */
function devicePixelRatioStep() {
  const raw = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  return Math.max(1, Math.min(Math.ceil(raw - 1e-3), 3));
}

const WindySatTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    const dpr = this.options.pixelRatio ?? devicePixelRatioStep();
    tile.width = Math.round(size.x * dpr);
    tile.height = Math.round(size.y * dpr);
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;

    // Above native zoom, crop the parent z7 tile instead of requesting one that
    // does not exist — the provider answers 400, not 404, past zoom 7.
    const nativeZoom = Math.min(coords.z, MAX_NATIVE_ZOOM);
    const scale = 2 ** (coords.z - nativeZoom);
    const nativeCoords = {
      x: Math.floor(coords.x / scale),
      y: Math.floor(coords.y / scale),
      z: nativeZoom,
    };
    const crop = nativeZoom < coords.z
      ? { ix: coords.x - nativeCoords.x * scale, iy: coords.y - nativeCoords.y * scale, scale }
      : null;

    const liveUrl = toLiveUrl(this.getTileUrl(nativeCoords));
    const archiveUrl = toArchiveUrl(liveUrl);
    const requested = frameTimeFromUrl(liveUrl);
    const archiveFirst = preferArchive(liveUrl);
    const urls = archiveFirst ? [archiveUrl] : [liveUrl, archiveUrl];

    // The sun is placed by the frame's own time, not by now — and when the
    // archive is being asked, by the hour it will actually serve. Snapping moves
    // the sun by up to half an hour, which is under four degrees of rotation and
    // well inside the ten-degree band the composite fades across.
    const atMs = (archiveFirst && requested !== null ? archiveFrameTime(requested) : requested)
      ?? this.options.timestamp ?? Date.now();

    let channel = this.options.channel || 'composite';
    let weights = null;
    if (channel === 'composite') {
      const daylight = daylightGrid(coords, atMs);
      // A composite over the unlit hemisphere is infrared everywhere; saying so
      // lets the inner loop drop the blend and the lookup.
      if (daylight.allNight) channel = 'ir';
      else weights = daylight.grid;
    }

    if (workersAvailable()) {
      decodeTile({ mode: 'visir', urls, dw: tile.width, dh: tile.height, crop, channel, weights, grid: GRID })
        .then(({ bitmap, usedIndex }) => {
          // Falling through to the archive means the live endpoint has aged out
          // for this frame; remember the boundary so later frames skip the miss.
          if (!archiveFirst && usedIndex > 0) rememberCutoff(requested);
          const ctx = tile.getContext('2d', { alpha: true });
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, tile.width, tile.height);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          done(null, tile);
        })
        // A dead worker or a transient fetch failure should not blank the tile.
        .catch(() => drawInline());
      return tile;
    }

    drawInline();
    return tile;

    /* ---- main-thread fallback, for browsers without OffscreenCanvas ---- */
    function drawInline() {
      const attempt = (index) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onerror = () => {
          if (index + 1 >= urls.length) {
            done(new Error('satellite tile failed'), tile);
            return;
          }
          if (!archiveFirst) rememberCutoff(requested);
          attempt(index + 1);
        };
        img.onload = () => {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          const scratch = document.createElement('canvas');
          scratch.width = w;
          scratch.height = h;
          const sctx = scratch.getContext('2d', { willReadFrequently: true });
          sctx.drawImage(img, 0, 0);
          const source = deinvertBlocks(sctx.getImageData(0, 0, w, h));

          const plane = document.createElement('canvas');
          plane.width = w;
          plane.height = h / 2;
          const pctx = plane.getContext('2d');
          pctx.putImageData(composeChannels(source, pctx.createImageData(w, h / 2), channel, weights), 0, 0);

          const ctx = tile.getContext('2d', { alpha: true });
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, tile.width, tile.height);
          if (crop) {
            const sw = plane.width / crop.scale;
            const sh = plane.height / crop.scale;
            ctx.drawImage(plane, Math.round(crop.ix * sw), Math.round(crop.iy * sh),
              Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)), 0, 0, tile.width, tile.height);
          } else {
            ctx.drawImage(plane, 0, 0, tile.width, tile.height);
          }
          done(null, tile);
        };
        img.src = urls[index];
      };
      attempt(0);
    }
  },
});

export function createWindySatLayer(url, options = {}) {
  return new WindySatTileLayer(url, {
    ...options,
    crossOrigin: true,
    maxNativeZoom: MAX_NATIVE_ZOOM,
    className: 'wx-tile windy-sat-tile',
  });
}
