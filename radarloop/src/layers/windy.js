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
 * Native tiles stop at zoom 7, so deeper zooms crop the z7 tile and scale it
 * here, where the reflectivity can be interpolated before it is coloured,
 * rather than letting the browser scale the finished picture.
 */

import { colourForMmh, encodedToMmh, getLevels, MIN_VISIBLE_MMH } from './radarScale.js';
import { loadSetting, saveSetting } from '../core/util.js';
import { available as workersAvailable, decodeTile } from './windyPool.js';
import { isSmoothing } from './radarScale.js';

export const MAX_NATIVE_ZOOM = 7;

/**
 * How deep the tile grid is built, as opposed to how deep the provider's data
 * goes.
 *
 * These are two different limits and conflating them is what made the composite
 * look like a mosaic when zoomed in. Leaflet reads `maxNativeZoom` as "stop
 * making tiles here", so with it set to 7 the map at zoom 10 laid down zoom-7
 * tiles and stretched each one across eight times its width in CSS — a nearest
 * neighbour blow-up of a finished picture, which no amount of care inside the
 * tile can undo. Building the grid deeper hands each tile to `createTile`,
 * which cuts its own piece out of the zoom-7 parent and resamples the
 * reflectivity it carries before the colours go on.
 *
 * Ten rather than deeper because the cost is a tile grid: a viewport holds
 * roughly the same number of tiles at any zoom it is built for, so this is the
 * work the app already does at zoom 7 and no more. Past ten the picture is
 * smooth enough that stretching it costs nothing visible.
 */
export const MAX_TILE_ZOOM = 10;

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
  /**
   * Leaflet's own version takes x and y from the coordinates but the zoom from
   * the layer, which would ask for tiles past zoom 7 now that the grid is built
   * that deep. Here the coordinates decide all three, so `createTile` can ask
   * for the parent it means to crop.
   */
  getTileUrl(coords) {
    return L.Util.template(this._url, {
      ...this.options,
      r: L.Browser.retina ? '@2x' : '',
      s: this._getSubdomain(coords),
      x: coords.x,
      y: coords.y,
      z: coords.z,
    });
  },

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
    // The stylesheet asks for nearest-neighbour scaling, which keeps the classes
    // crisp when the picture is stretched but is exactly what smoothing is meant
    // to get rid of. Past the depth of the grid there is still some stretching
    // left, so let it interpolate then.
    tile.style.imageRendering = isSmoothing() ? 'auto' : 'pixelated';

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
      const address = (c) => {
        const live = toLiveUrl(this.getTileUrl(c));
        return archiveFirst ? [toArchiveUrl(live)] : [withCacheBuster(live, token), toArchiveUrl(live)];
      };
      const urls = address(nativeCoords);

      /*
       * The eight tiles around this one's parent.
       *
       * Smoothing averages a neighbourhood, and a tile cut from the edge of its
       * parent has no data on that side to average — so it leans inward, its
       * neighbour leans the other way, and the join between them shows. These
       * give the worker somewhere to read from. They are nearly always already
       * in the browser's cache, since the map is drawing them too.
       */
      const neighbours = {};
      if (isSmoothing()) {
        const span = 2 ** nativeZoom;
        for (let gy = -1; gy <= 1; gy += 1) {
          for (let gx = -1; gx <= 1; gx += 1) {
            if (!gx && !gy) continue;
            const y = nativeCoords.y + gy;
            // Past the poles there is no tile; around the date line there is.
            if (y < 0 || y >= span) continue;
            const x = ((nativeCoords.x + gx) % span + span) % span;
            neighbours[`${gx},${gy}`] = address({ x, y, z: nativeZoom });
          }
        }
      }

      decodeTile({ urls, dw: tile.width, dh: tile.height, crop, neighbours, smooth: isSmoothing() })
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
     * Where the tile grid stops — not where the data does.
     *
     * `minNativeZoom` must stay unset. The original build pinned it to the
     * maximum, forcing z7 tiles at every zoom "for detail", and Leaflet honours
     * that by rendering the whole viewport at z7: at map zoom 5 it asked for
     * sixteen times as many tiles, measured at ~392 per frame instead of ~35,
     * each decoded and recoloured per pixel. That is what made scrubbing heavy
     * in both 2D and 3D, and it bought nothing — Windy serves every zoom from 3
     * upwards with real data.
     *
     * Raising the maximum is the opposite case and costs nothing below zoom 7,
     * where it does not apply. Above it there are no native tiles, so
     * `createTile` crops the z7 parent — see MAX_TILE_ZOOM.
     */
    maxNativeZoom: MAX_TILE_ZOOM,
    className: 'wx-tile windy-radar-tile',
  });
}
