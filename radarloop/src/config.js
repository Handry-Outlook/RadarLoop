/**
 * Application-wide configuration: provider credentials, tuning constants and the
 * device capability profile.
 *
 * Everything that used to be scattered as loose `const` declarations halfway down
 * the old monolith lives here so a deployment can be re-keyed in one place.
 */

/* ------------------------------------------------------------------ *
 * Provider credentials
 * ------------------------------------------------------------------ */

export const CREDENTIALS = {
  mapbox: 'pk.eyJ1IjoibWV0ZW9ncm91cC1tYXBib3giLCJhIjoiY2pudWJyMWVhMDQ0bjNxdXFsNWJ5M2ZtbSJ9.ANOKYyv5s0VFVbnesnGGUQ',
  maptiler: 'd6FiSbcpDtzJ4g4e0oD4',
  xweatherId: 'wgE96YE3scTQLKjnqiMsv',
  xweatherSecret: '1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq',
  accuweather: '34d63eadb3384b4b86e1f5a5741f9820',
  synoptic: '62836fb21d9b422b878d830b31bdf0df',
};

/** Convenience: the `id_secret` pair Aeris/Xweather tile URLs embed in their path. */
export const XWEATHER_KEY = `${CREDENTIALS.xweatherId}_${CREDENTIALS.xweatherSecret}`;

/** Auto-HOCO runs (`hoco_requests`) and Storage-hosted outlook assets. */
export const FIREBASE_MAIN = {
  apiKey: 'AIzaSyA8IYTApDl8vhZENPJXIw48rR_SUhfFPVQ',
  authDomain: 'hoco-3b23e.firebaseapp.com',
  projectId: 'hoco-3b23e',
  storageBucket: 'hoco-3b23e.firebasestorage.app',
  messagingSenderId: '409513272369',
  appId: '1:409513272369:web:a857d9b039d53710f8a110',
};

/** Secondary app holding the manually published Handry Outlook forecasts. */
export const FIREBASE_OUTLOOK = {
  apiKey: 'AIzaSyD2lgPAtAYksA4guBCITLq_4RkBpavcXjs',
  authDomain: 'genweather-f9a45.firebaseapp.com',
  projectId: 'genweather-f9a45',
  storageBucket: 'genweather-f9a45.firebasestorage.app',
  messagingSenderId: '682497500954',
  appId: '1:682497500954:web:54c400f45cd9b8b6cf2ea3',
};

export const FIREBASE_OUTLOOK_APP_NAME = 'published-handry-outlook';

/** Published-outlook risk ladder (distinct palette from the KML drawing risks). */
export const PUBLISHED_RISKS = {
  1: { name: 'Low', color: '#67c6ac' },
  2: { name: 'Slight', color: '#ffea00' },
  3: { name: 'Enhanced', color: '#ff7a21' },
  4: { name: 'Moderate', color: '#f91522' },
  5: { name: 'High', color: '#b23cc7' },
  6: { name: 'Severe', color: '#111111' },
};

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

export const ENDPOINTS = {
  metOfficeLightning: 'https://data.consumer-digital.api.metoffice.gov.uk/v1/lightning',
  metOfficeWarnings:
    'https://services.arcgis.com/Lq3V5RFuTBC9I7kv/arcgis/rest/services/Met_Office_National_Severe_Weather_Warning_Service_Live/FeatureServer/0',
  lightningArchives: [
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new/refs/heads/main/lightning_data.json',
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new/refs/heads/main/lightning_data_2025_autumn.json',
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new_2026/refs/heads/main/lightning_data_2026_summer_part1.json',
    'https://raw.githubusercontent.com/HandryOutlook/lightning_data_new_2026/refs/heads/main/lightning_data_2026_summer.json',
  ],
  windyLightningLive: 'https://node.windy.com/blitz/v3/hot',
  windyLightningFrame: 'https://ims.windy.com/blitz/v3/5mins',
  hocoDetail: 'https://handry-outlook.github.io/HOCO-V2.0/index.html',
  strikesChart: 'https://handry-outlook.github.io/Convective-Outlook/lightning_strikes_chart.html',
};

/* ------------------------------------------------------------------ *
 * Brand assets
 * ------------------------------------------------------------------ */

export const ASSETS = {
  /** RadarLoop wordmark, shown in the top bar. */
  radarloopLogo:
    'https://raw.githubusercontent.com/Handry-Outlook/Lightning-Strike-Visualiser-/refs/heads/main/RadarLoop%20Logo.png',
  /** Handry Outlook icon, used as the favicon and on the outlook panels. */
  handryIcon:
    'https://raw.githubusercontent.com/Handry-Outlook/Convective-Outlook/main/Handry_outlook_icon_pride_small.png',
  /** Strike cue, as used by the original build. */
  thunderSound:
    'https://handry-outlook.github.io/Lightning-Strike-Visualiser-/mouse-click-117076-%5BAudioTrimmer.com%5D.mp3',
};

/* ------------------------------------------------------------------ *
 * Rendering / performance tuning
 * ------------------------------------------------------------------ */

export const TUNING = {
  /** Provider ingest lag. When the scrubber is parked at "now" we request this far back. */
  processingDelayMs: 5 * 60 * 1000,
  /** How long a resolved tile URL stays trusted before it is re-probed. */
  tileUrlCacheTtlMs: 90 * 1000,
  /** Negative probe results expire faster so a just-published frame appears quickly. */
  tileUrlNegativeTtlMs: 20 * 1000,
  /** Minimum wall-clock gap between weather re-renders while animating. */
  minAnimationGapMs: 90,
  /** Scrubber input debounce. */
  scrubDebounceMs: 60,
  /** Frames of history to prefetch either side of the current one. */
  prefetchRadius: 2,
  /** Default UK lightning poll interval. */
  refreshIntervalMinutes: 1,
  /** Ceiling on how many strike markers are drawn before decimation kicks in. */
  maxRenderedStrikes: 12000,
};

export const MAP_DEFAULTS = {
  center: [53.5, -4.5],
  zoom: 5,
  minZoom: 2,
  maxZoom: 18,
  basemap: 'mapbox-traffic-night',
};

/** Named bounding boxes used by PNG auto-placement and the region picker. */
export const REGION_BOUNDS = {
  'Zoom-in England': [[49.35, -6.4], [54.35, 4.4]],
  England: [[47.7, -20.4], [57.075, 10.55]],
  Wales: [[51.4, -5.3], [53.4, -2.8]],
  Scotland: [[54.6, -7.5], [60.8, -0.7]],
  'Northern Ireland': [[49.98, -20.2], [56.25, 1.175]],
  'Ireland and Northern Ireland': [[49.98, -21.65], [56.25, 1.075]],
  UK: [[47.8, -31.2], [61.3, 16.6]],
};

/** Convective outlook risk categories, in ascending severity. */
export const RISK_LEVELS = [
  { id: 'Low risk', color: '#5aac91', rank: 1 },
  { id: 'Slight risk', color: '#ffff00', rank: 2 },
  { id: 'Enhanced risk', color: '#ffa500', rank: 3 },
  { id: 'Moderate risk', color: '#ff0000', rank: 4 },
  { id: 'High risk', color: '#800080', rank: 5 },
  { id: 'Severe risk', color: '#000000', rank: 6 },
];

export const RISK_COLORS = Object.fromEntries(RISK_LEVELS.map((r) => [r.id, r.color]));

/* ------------------------------------------------------------------ *
 * Map panes — one authoritative z-order for the whole application
 * ------------------------------------------------------------------ */

/**
 * The old code created panes in four different places and reasoned about the
 * ordering in comments. Declaring the stack once makes the ordering reviewable.
 */
/**
 * Every weather pane is a **child of `overlayPane`**. This matters: Leaflet's own
 * `tilePane` (the base map) is z-index 200, so a top-level pane numbered below
 * that renders *underneath the base map* and is invisible. Nesting inside
 * `overlayPane` (z-index 400) puts the whole weather stack above the base map,
 * and the numbers below then order the layers among themselves.
 *
 * Panes that must sit above the weather stack — labels, strikes, outlook
 * outlines — stay top-level with a z-index above 400.
 */
export const PANES = [
  // --- inside overlayPane: the weather stack, bottom to top ---
  { name: 'satellitePane', z: 140, parent: 'overlayPane' },
  // Outlook fills interleave here so radar echoes stay readable through them:
  // satellite (140) < fill (145) < radar (150).
  { name: 'nowcastFillPane', z: 144, parent: 'overlayPane', clickThrough: true },
  { name: 'nowcastOutlinePane', z: 145, parent: 'overlayPane' },
  // Automated outlook above satellite, below radar; the manual one above it.
  // Both are ordinary orderable layers now, so their outlines live with their
  // fills rather than being pinned to the top of the whole map.
  { name: 'hocoFillPane', z: 146, parent: 'overlayPane', clickThrough: true },
  { name: 'hocoOutlinePane', z: 147, parent: 'overlayPane', clickThrough: true },
  { name: 'publishedOutlookFillPane', z: 148, parent: 'overlayPane', clickThrough: true },
  { name: 'publishedOutlookOutlinePane', z: 149, parent: 'overlayPane', clickThrough: true },
  { name: 'radarPane', z: 150, parent: 'overlayPane' },
  { name: 'operaRadarPane', z: 155, parent: 'overlayPane' },
  { name: 'observationPane', z: 160, parent: 'overlayPane' },
  { name: 'roadWeatherPane', z: 165, parent: 'overlayPane' },
  { name: 'isobarPane', z: 170, parent: 'overlayPane' },
  { name: 'frontPane', z: 180, parent: 'overlayPane' },
  { name: 'warningFillPane', z: 190, parent: 'overlayPane', clickThrough: true },
  // Five groups had no pane of their own and fell through to `overlayPane`.
  // That is Leaflet's own container for every child pane, so they all drew into
  // one another and, worse, restacking any of them set a z-index on the
  // container — moving the entire weather stack rather than the one layer. Each
  // gets its own now, which is what makes the layer list able to order them.
  { name: 'windPane', z: 182, parent: 'overlayPane' },
  { name: 'nowcastLayerPane', z: 184, parent: 'overlayPane' },
  { name: 'tropicalPane', z: 186, parent: 'overlayPane' },
  { name: 'rotationPane', z: 188, parent: 'overlayPane' },

  // Hand-drawn shapes start above the weather; like the outlooks they can be
  // restacked from the layer list.
  { name: 'drawPane', z: 192, parent: 'overlayPane' },
  // Strikes from a catalog product, as opposed to the in-house feed above the
  // whole stack in `lightningPane`.
  { name: 'strikePane', z: 194, parent: 'overlayPane' },
  // Station models are read, not looked at, so they start at the top of the
  // stack. Inside overlayPane rather than beside it: the layer list orders by
  // z-index, and a z-index only orders against its own siblings. As a top-level
  // pane it was handed a value from the weather stack range — 200, against an
  // overlayPane sitting at 400 — which put it underneath every weather layer it
  // was supposedly above.
  { name: 'synopticPane', z: 196, parent: 'overlayPane', clickThrough: true },

  // --- top-level: above the whole weather stack ---
  { name: 'warningPane', z: 550 },
  { name: 'labelsPane', z: 600, clickThrough: true },
  { name: 'lightningPane', z: 1000 },
];

/** Per-layer-group default z-index within the overlay stack. */
export const LAYER_Z = {
  satellite: 140,
  radar: 150,
  observation: 200,
  isobar: 400,
  surfaceFront: 420,
  wind: 430,
  nowcast: 500,
  tropicalStorms: 505,
  rotation: 510,
  lightning: 520,
  warning: 550,
  roadWeather: 165,
};

/* ------------------------------------------------------------------ *
 * Device capability profile
 * ------------------------------------------------------------------ */

function detectProfile() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mobile =
    coarse ||
    /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ||
    Math.min(window.innerWidth, window.innerHeight) <= 820;
  const cores = Number(navigator.hardwareConcurrency || 4);
  const memory = Number(navigator.deviceMemory || 4);
  const lowMemory = memory <= 4 || cores <= 4;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return Object.freeze({ mobile, coarse, cores, memory, lowMemory, reducedMotion });
}

export const DEVICE = detectProfile();

/**
 * Concurrency for parallel tile/frame work. Deliberately conservative on mobile:
 * saturating the connection pool there makes the *visible* frame arrive later,
 * which is exactly the "slow plotting" symptom.
 */
export function fetchConcurrency({ animating = false, lowEndMode = false } = {}) {
  if (DEVICE.mobile) return 2;
  if (lowEndMode) return 2;
  // Fewer parallel fetches while animating, not more. Raising this to 6 was
  // tried once playback became frame-paced, on the theory that a single frame in
  // flight could have the whole pool; it did not draw more frames. Run-to-run
  // variance against the provider is wide enough that the two settings could not
  // be separated, so the conservative one stays: saturating the connection can
  // only delay the frame that is actually on screen.
  return animating ? 4 : 6;
}
