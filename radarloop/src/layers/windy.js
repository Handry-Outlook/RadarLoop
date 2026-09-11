/**
 * Global High Resolution radar composite (Windy radar2).
 *
 * Three things make this product awkward and all are handled here:
 *
 *  1. **The tiles are data, not pictures.** R and G encode reflectivity; the tile
 *     must be recoloured client-side through the shared rainfall scale. A pure
 *     blue pixel is the provider's no-data mask.
 *  2. **Live and archive endpoints diverge.** Frames older than about two hours
 *     stop being served from `/composite/` and move to `/archive/composite/`. The
 *     cutoff is not published, so it is learned from the first live 404 and
 *     remembered, which avoids a failed request per tile on later sessions.
 *  3. **Recolouring is expensive.** A viewport is roughly forty tiles, and at a
 *     2x device pixel ratio that is ten million pixels per frame. Fetch, decode,
 *     crop and recolour therefore run in a worker pool (see windyPool.js) and the
 *     main thread only blits the finished bitmap. The inline path below is kept
 *     as a fallback for browsers without OffscreenCanvas.
 *
 * Native tiles stop at zoom 7, so deeper zooms crop and nearest-neighbour scale
 * the z7 tile rather than letting the browser blur it.
 */

import { colourForMmh, encodedToMmh, getLevels, MIN_VISIBLE_MMH } from './radarScale.js';
import { loadSetting, saveSetting } from '../core/util.js';
import { available as workersAvailable, decodeTile } from './windyPool.js';
import { isSmoothing } from './radarScale.js';

export const MAX_NATIVE_ZOOM = 7;

const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const ARCHIVE_CUTOFF_KEY = 'windyArchiveCutoffMs';

export const isWindyRadar = (type) => type === 'windy-radar';

/* ------------------------------------------------------------------ *
 * Endpoint selection
 * ------------------------------------------------------------------ */

export const toLiveUrl = (url) => String(url).replace('/radar2/archive/composite/', '/radar2/composite/');
export const toArchiveUrl = (url) => String(url).replace('/radar2/composite/', '/radar2/archive/composite/');

/** Recovers the frame time encoded in a composite URL path. */
export function frameTimeFromUrl(url) {
  const m = String(url).match(/\/radar2\/(?:archive\/)?composite\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\//);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4].slice(0, 2), +m[4].slice(2, 4), 0, 0);
}

const getCutoff = () => {
  const value = Number(loadSetting(ARCHIVE_CUTOFF_KEY, 0));
  return Number.isFinite(value) && value > 0 ? value : null;
};

function rememberCutoff(frameMs) {
  if (!Number.isFinite(frameMs)) return;
  saveSetting(ARCHIVE_CUTOFF_KEY, Math.max(getCutoff() || 0, frameMs));
}

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

/** Live tiles are cache-busted; archive tiles are immutable and must not be. */
function withCacheBuster(url, token) {
  const value = String(url || '');
  if (!value || value.includes('/radar2/archive/composite/')) return value;
  return `${value}${value.includes('?') ? '&' : '?'}_rlcb=${encodeURIComponent(String(token))}`;
}

/* ------------------------------------------------------------------ *
 * Pixel decoding
 * ------------------------------------------------------------------ */

/**
 * Recovers the encoded reflectivity byte from a multichannel data pixel.
 * Returns null for the no-data mask and for values below the noise floor.
 */
export function encodedFromPixel(r, g, b) {
  // A near-pure blue pixel is the provider's no-data mask, not weak echo.
  if (b > 200 && r < 8 && g < 8) return null;
  const encoded = (Math.max(0, r) + Math.max(0, g)) / 2;
  return encoded > 0.5 ? encoded : null;
}

export function mmhFromPixel(r, g, b) {
  const encoded = encodedFromPixel(r, g, b);
  if (encoded === null) return null;
  const mmh = encodedToMmh(encoded);
  return mmh >= MIN_VISIBLE_MMH ? mmh : null;
}

/**
 * Recolours a tile in place through the active rainfall scale.
 *
 * The per-tile memo matters: a radar tile has at most a few hundred distinct
 * source colours but 65k+ pixels, so the rate conversion runs a few hundred times
 * instead of once per pixel.
 */
export function recolourTile(imageData) {
  const levels = getLevels();
  const data = imageData.data;
  const memo = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 2) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let target = memo.get(key);
    if (target === undefined) {
      const mmh = mmhFromPixel(data[i], data[i + 1], data[i + 2]);
      target = mmh === null ? false : colourForMmh(mmh, levels);
      memo.set(key, target);
    }
    if (!target) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = target[0];
    data[i + 1] = target[1];
    data[i + 2] = target[2];
    data[i + 3] = target[3];
  }
  return imageData;
}

/* ------------------------------------------------------------------ *
 * The tile layer
 * ------------------------------------------------------------------ */

/**
 * Device pixel ratio rounded up to a whole step, 1 to 3.
 *
 * Fractional ratios (1.25 / 1.5 on Windows laptops) make a canvas look soft, so
 * the backing store is rounded up. The epsilon matters: a browser can report
 * 1.0000000149 for a plain 1x display, and rounding that up would double every
 * tile's pixel count for nothing.
 */
export function devicePixelRatioStep() {
  const raw = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  return Math.max(1, Math.min(Math.ceil(raw - 1e-3), 3));
}

const COMPOSITE_RE = /\/radar2\/(?:archive\/)?composite\//;

const WindyRadarTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();

    // This is deliberately identical in 3D and 2D. An earlier version halved it
    // in 3D to buy back scrubbing speed, which showed as a visibly softer radar
    // once the composite was mirrored. The per-pixel work now runs in workers
    // instead, so resolution no longer has to pay for speed.
    const dpr = this.options.pixelRatio ?? devicePixelRatioStep();
    tile.width = Math.round(size.x * dpr);
    tile.height = Math.round(size.y * dpr);
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;
    tile.className = 'windy-radar-tile';

    // Above native zoom, crop the parent z7 tile instead of requesting a tile
    // that does not exist.
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
    const frameMs = frameTimeFromUrl(liveUrl);
    const archiveFirst = preferArchive(liveUrl);
    const isComposite = COMPOSITE_RE.test(String(this._url || ''));
    const token = this.options.refreshToken || Date.now();

    /* ---- off-thread path: fetch, decode, crop and recolour in a worker ---- */
    if (isComposite && workersAvailable()) {
      // Live URLs are cache-busted; archive URLs are immutable and must not be.
      const urls = archiveFirst ? [archiveUrl] : [withCacheBuster(liveUrl, token), archiveUrl];
      decodeTile({ urls, dw: tile.width, dh: tile.height, crop, smooth: isSmoothing() })
        .then(({ bitmap, usedIndex }) => {
          // Falling through to the archive means the live endpoint has aged out
          // for this frame; remember the boundary so later frames skip the miss.
          if (!archiveFirst && usedIndex > 0) rememberCutoff(frameMs);
          const ctx = tile.getContext('2d', { alpha: true });
          ctx.imageSmoothingEnabled = false;
          ctx.clearRect(0, 0, tile.width, tile.height);
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          done(null, tile);
        })
        // A dead worker or a transient fetch failure should not blank the tile:
        // retry it on the main thread.
        .catch(() => drawInline());
      return tile;
    }

    drawInline();
    return tile;

    /* ---- main-thread fallback ---- */
    function drawInline() {
      const ctx = tile.getContext('2d', { willReadFrequently: true, alpha: true });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Smoothing the data, not the picture — see windyTile.worker.js.
      const smooth = isSmoothing();
      ctx.imageSmoothingEnabled = smooth;
      ctx.imageSmoothingQuality = smooth ? 'high' : 'low';

      const draw = (img) => {
        ctx.clearRect(0, 0, size.x, size.y);
        ctx.imageSmoothingEnabled = smooth;

        if (crop) {
          const sw = img.naturalWidth || img.width || size.x;
          const sh = img.naturalHeight || img.height || size.y;
          ctx.drawImage(
            img,
            Math.round(crop.ix * (sw / scale)), Math.round(crop.iy * (sh / scale)),
            Math.max(1, Math.round(sw / scale)), Math.max(1, Math.round(sh / scale)),
            0, 0, size.x, size.y,
          );
        } else {
          ctx.drawImage(img, 0, 0, size.x, size.y);
        }

        if (isComposite) {
          ctx.putImageData(recolourTile(ctx.getImageData(0, 0, tile.width, tile.height)), 0, 0);
        }
        done(null, tile);
      };

      const attempt = (url, isArchive) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => draw(img);
        img.onerror = () => {
          if (isArchive) {
            done(new Error('Windy radar archive tile failed'), tile);
            return;
          }
          rememberCutoff(frameMs);
          attempt(archiveUrl, true);
        };
        img.src = isArchive ? url : withCacheBuster(url, token);
      };

      attempt(archiveFirst ? archiveUrl : liveUrl, archiveFirst);
    }
  },
});

export function createWindyRadarLayer(url, options = {}) {
  return new WindyRadarTileLayer(url, {
    ...options,
    crossOrigin: true,
    refreshToken: options.refreshToken || Date.now(),
    /**
     * Cap the tile zoom at Windy's native maximum, but do **not** raise it.
     *
     * The original build set `minNativeZoom` to the maximum as well, forcing z7
     * tiles at every zoom "for detail". Leaflet honours that by rendering the
     * whole viewport at z7, so at map zoom 5 it requests sixteen times as many
     * tiles — measured at ~392 per frame instead of ~35. Each of those is also
     * decoded and recoloured per pixel, which is what made scrubbing heavy in
     * both 2D and 3D. Windy serves every zoom from 3 upwards with real data, so
     * the extra requests bought nothing that is visible at that scale.
     *
     * Above z7 there are no native tiles, so `createTile` crops and
     * nearest-neighbour scales the z7 parent instead.
     */
    maxNativeZoom: MAX_NATIVE_ZOOM,
    className: 'wx-tile windy-radar-tile',
  });
}
