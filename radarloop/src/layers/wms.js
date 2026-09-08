/**
 * WMS products addressed as XYZ tiles (currently EUMETSAT MTG GeoColour).
 *
 * The catalog stores a GetMap template with a `{bbox}` placeholder; each tile
 * converts its slippy-map coordinate into the EPSG:4326 bounding box the service
 * expects. The `TIME` parameter is already substituted by the resolver.
 *
 * The retry behaviour is essential rather than defensive: EUMETSAT briefly
 * returns 404 for tiles of a frame that is still being published. Letting
 * Leaflet mark those permanently failed leaves visible holes in the disc, so a
 * tile is kept pending and the same URL retried on a backoff.
 */

const RETRY_DELAYS = [350, 800, 1500, 2600, 4200, 6500];

/** Trims float noise without turning 0 into "-0". */
const fmt = (v) => (v === 0 || Object.is(v, -0) ? '0' : parseFloat(v.toFixed(7)));

/** Slippy tile coordinate to an EPSG:4326 `lat1,lon1,lat2,lon2` bbox. */
export function tileToBbox({ x, y, z }) {
  const total = 2 ** z;
  const lon1 = (x / total) * 360 - 180;
  const lon2 = ((x + 1) / total) * 360 - 180;
  const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / total))) * 180) / Math.PI;
  const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / total))) * 180) / Math.PI;
  return `${fmt(lat2)}%2C${fmt(lon1)}%2C${fmt(lat1)}%2C${fmt(lon2)}`;
}

const WmsTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    return this._url.replace('{bbox}', tileToBbox(coords));
  },

  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');

    // crossOrigin is deliberately omitted: the service serves no CORS headers,
    // so requesting it would make the image fail to load entirely. The tile is
    // only ever displayed, never read back into a canvas.
    const url = this.getTileUrl(coords);

    let attempt = 0;
    let finished = false;
    let timer = null;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      tile.onload = null;
      tile.onerror = null;
      done(error || null, tile);
    };

    const request = () => {
      if (finished) return;
      tile.onload = () => finish(null);
      tile.onerror = () => {
        if (attempt >= RETRY_DELAYS.length) {
          finish(new Error('WMS tile unavailable after publication-delay retries'));
          return;
        }
        const delay = RETRY_DELAYS[attempt];
        attempt += 1;
        // A fresh query string defeats the browser's negative cache.
        timer = setTimeout(() => {
          if (finished) return;
          tile.src = `${url}&_retry=${attempt}`;
        }, delay);
      };
      tile.src = url;
    };

    request();
    return tile;
  },
});

export function createWmsLayer(url, options = {}) {
  return new WmsTileLayer(url, {
    ...options,
    tileSize: 256,
    // A full-disc product has no meaningful detail beyond this.
    maxNativeZoom: options.maxNativeZoom ?? 7,
  });
}

export const isWmsTemplate = (url) => typeof url === 'string' && url.includes('{bbox}');
