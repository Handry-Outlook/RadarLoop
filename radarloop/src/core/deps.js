/**
 * Third-party libraries, fetched when something actually needs them.
 *
 * Every one of these used to be a blocking `<script>` in the shell: 4.7 MB of
 * JavaScript parsed before the first tile was requested, on every load, whether
 * or not the session ever touched the feature it belongs to. Mapbox GL and the
 * MapTiler SDK alone are 2.4 MB and are only reachable through the 3D button and
 * four of the eighteen base maps.
 *
 * Only Leaflet stays in the shell, because the map is the first thing drawn.
 * Everything else is requested at the point of use and cached here, so the cost
 * is paid once, by whoever needs it, and never by someone who does not.
 *
 * Each entry resolves when its global is usable. A failed load rejects, and the
 * caller is expected to degrade rather than throw — a missing optional library
 * should cost one feature, not the application.
 */

const pending = new Map();

/** Adds a stylesheet once, resolving when it has applied. */
function loadStyle(href) {
  if (pending.has(href)) return pending.get(href);
  const promise = new Promise((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    // A missing stylesheet is cosmetic; never block the feature on it.
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });
  pending.set(href, promise);
  return promise;
}

/** Adds a script once, resolving when it has run. */
function loadScript(src) {
  if (pending.has(src)) return pending.get(src);
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = false; // Order matters where one library extends another.
    script.dataset.loaded = 'false';
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });
  pending.set(src, promise);
  return promise;
}

/**
 * Declares a dependency: what to fetch, and how to tell it is already there.
 *
 * The `ready` check matters for the bundled build and for anyone who pins a
 * library back into the shell — if the global exists, nothing is fetched.
 */
function dependency(ready, ...assets) {
  let promise = null;
  return () => {
    if (ready()) return Promise.resolve();
    if (!promise) {
      promise = (async () => {
        for (const asset of assets) {
          // Sequential on purpose: leaflet-maptilersdk needs the SDK it extends.
          // eslint-disable-next-line no-await-in-loop
          await (asset.endsWith('.css') ? loadStyle(asset) : loadScript(asset));
        }
      })().catch((error) => {
        // Allow a later attempt rather than caching the failure forever.
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}

const has = (name) => typeof globalThis[name] !== 'undefined';

export const DEPS = {
  /** OPERA grid reprojection. */
  proj4: dependency(
    () => has('proj4'),
    'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js',
  ),

  /** Polygon drawing. */
  draw: dependency(
    () => !!globalThis.L?.Control?.Draw,
    'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css',
    'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js',
  ),

  /** Geometry for the nowcast hulls and the area tools. */
  turf: dependency(
    () => has('turf'),
    'https://unpkg.com/@turf/turf@6/turf.min.js',
  ),

  /** Mapbox vector tiles (the `pbf` product kind). */
  vectorGrid: dependency(
    () => !!globalThis.L?.vectorGrid,
    'https://unpkg.com/leaflet.vectorgrid@1.3.0/dist/Leaflet.VectorGrid.min.js',
  ),

  /** Esri FeatureServer layers. */
  esri: dependency(
    () => !!globalThis.L?.esri,
    'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js',
  ),

  /** Strike density heatmap. */
  heat: dependency(
    () => typeof globalThis.L?.heatLayer === 'function',
    'https://cdn.jsdelivr.net/npm/leaflet.heat/dist/leaflet-heat.js',
  ),

  /** KML import. */
  togeojson: dependency(
    () => has('toGeoJSON'),
    'https://unpkg.com/togeojson@0.16.0',
  ),

  /** MapTiler base maps. */
  maptiler: dependency(
    () => !!globalThis.L?.maptiler?.maptilerLayer,
    'https://cdn.maptiler.com/maptiler-sdk-js/v3.0.1/maptiler-sdk.umd.min.js',
    'https://cdn.maptiler.com/leaflet-maptilersdk/v4.0.2/leaflet-maptilersdk.umd.min.js',
  ),

  /** The 3D view. */
  mapbox: dependency(
    () => has('mapboxgl'),
    'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.css',
    'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.js',
  ),

  /** The MapsGL weather catalogue. */
  mapsgl: dependency(
    () => !!globalThis.aerisweather?.mapsgl,
    'https://cdn.aerisapi.com/sdk/js/mapsgl/latest/aerisweather.mapsgl.css',
    'https://cdn.aerisapi.com/sdk/js/mapsgl/latest/aerisweather.mapsgl.js',
  ),

  /** Outlook storage. */
  firebase: dependency(
    () => !!globalThis.firebase?.firestore,
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage-compat.js',
  ),
};

/**
 * Warms the libraries a session is most likely to reach for, once the map is up.
 *
 * Deferring everything makes the first paint fast but moves the wait to the
 * first click. The storage SDK is the one worth pre-paying — outlooks are the
 * point of the application — and the idle callback keeps it off the critical
 * path, so it costs nothing anyone waits for.
 */
export function prefetchIdle() {
  const warm = () => { DEPS.firebase().catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);
}

/** True once a dependency has been fetched, for diagnostics. */
export const depsLoaded = () => [...pending.keys()].map((u) => u.split('/').pop());
