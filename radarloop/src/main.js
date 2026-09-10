/**
 * Application entry point.
 *
 * Boot order matters and is deliberate:
 *   1. theme and map, so there is something on screen immediately;
 *   2. UI shell, so controls are usable before any data arrives;
 *   3. the first weather render and the lightning fetch, in parallel.
 *
 * The legacy build did the reverse — it created eighteen base layers, two WebGL
 * contexts and every option object before the map appeared, then blocked the
 * first paint on the lightning archives.
 */

import { MAP_DEFAULTS, DEVICE } from './config.js';
import { emit, on, EVENTS } from './core/bus.js';
import { initMap, invalidateSizeIfChanged, map, safeRemove, setBasemap } from './core/map.js';
import { lightning as lightningState, runtime, setTheme, slots, time, restoreSelection, serialiseSelection } from './core/state.js';
import { byId, debounce, loadSetting, saveSetting } from './core/util.js';
import { exitGlDirect, flushPending, renderAll, whenRenderSettled } from './layers/renderer.js';
import { getLayerDef, LAYER_CATALOG, LAYER_ORDER } from './data/layers.js';
import * as timeCtl from './time/controller.js';
import { initLightning, refresh as refreshLightning, strikeCueState } from './lightning/index.js';
import { isUnlocked, playStrikeSound, poolState } from './lightning/audio.js';
import { applyPerformanceMode, buildRail, closePanel, currentGroup, lastOpenedGroup, openGroup, syncCards } from './ui/panels.js';
import { bindShortcuts, buildTimeline } from './ui/timeline.js';
import { buildLegend, toggleLegendVisible } from './ui/legend.js';
import { buildSearch } from './ui/search.js';
import { showHelp } from './ui/help.js';
import { toast } from './ui/components.js';
import * as draw from './tools/draw.js';
import { applyIcon } from './ui/icons.js';
import { initOutlookFocus, focusOutlook } from './hoco/focus.js';
import { exit3D, getGl, is3D, mirrorKind, mirroredGroups, mirrorMagnification, refresh3DTheme, toggle3D } from './core/map3d.js';
import { tileScheme, usesFlippedY } from './core/mirror3d.js';
import { activeInOrder, applyOrder, bindMap as bindLayerControl, selectProduct, setLayerEnabled, setLayerOpacity, moveLayer } from './layers/control.js';
import { initLayerManager } from './ui/layerManager.js';
import { registerOverlayLayers } from './layers/registerOverlays.js';
import { trackDockedChrome } from './ui/layout.js';
import { refreshOverlayMirror, remirrorAll, stats as mirrorStats } from './layers/mirrorBridge.js';
import { poolStats } from './layers/windyPool.js';
import { decodeFeed, decodeStrike, feedStats } from './layers/windyLightning.js';
import {
  archiveFrameTime, composeChannels, daylightGrid, deinvertBlocks,
  frameTimeFromUrl, isArchiveOnly, toArchiveUrl, toLiveUrl,
} from './layers/windySat.js';
import { prefetchIdle } from './core/deps.js';
import * as synoptic from './layers/synoptic.js';
import { buildStationCard } from './ui/stationPopup.js';

/* ------------------------------------------------------------------ *
 * Session restore
 * ------------------------------------------------------------------ */

function restoreSession() {
  const saved = loadSetting('layers', null);
  if (saved) {
    restoreSelection(saved);
  } else {
    // First run: a sensible default view rather than a blank map.
    const radar = slots.get('radar');
    radar.enabled = true;
    radar.type = 'windy-radar';
    radar.opacity = 0.9;

    const satellite = slots.get('satellite');
    satellite.enabled = true;
    satellite.type = 'eumetsat-geocolor';
    satellite.opacity = 1;
  }
}

const persistSession = debounce(() => saveSetting('layers', serialiseSelection()), 600);

/* ------------------------------------------------------------------ *
 * Top bar actions
 * ------------------------------------------------------------------ */

/** Text glyphs in the shell markup, replaced with the drawn icon set. */
const TOPBAR_ICONS = {
  'btn-panel': 'menu',
  'btn-3d': 'cube',
  'btn-locate': 'locate',
  'btn-legend': 'legend',
  'btn-theme': 'theme',
  'btn-help': 'help',
  'btn-fullscreen': 'fullscreen',
};

function bindTopbar() {
  for (const [id, name] of Object.entries(TOPBAR_ICONS)) applyIcon(byId(id), name);

  byId('btn-theme')?.addEventListener('click', () => {
    setTheme(runtime.theme === 'dark' ? 'light' : 'dark');
  });

  byId('btn-legend')?.addEventListener('click', toggleLegendVisible);
  byId('btn-help')?.addEventListener('click', showHelp);
  byId('panel-close')?.addEventListener('click', closePanel);

  // On narrow screens the rail collapses; this reopens the last panel group.
  byId('btn-panel')?.addEventListener('click', () => {
    if (currentGroup()) closePanel();
    else openGroup(lastOpenedGroup());
  });

  const btn3d = byId('btn-3d');
  btn3d?.addEventListener('click', async () => {
    // Mapbox GL is fetched on the first press, so a slow link shows progress
    // rather than an unresponsive button.
    btn3d.classList.add('btn--busy');
    const on = await toggle3D();
    btn3d.classList.remove('btn--busy');
    if (!on && typeof mapboxgl === 'undefined') {
      toast('3D needs Mapbox GL, which did not load', { tone: 'error' });
      return;
    }
    btn3d.setAttribute('aria-pressed', String(on));
    btn3d.classList.toggle('btn--active', on);
    if (!on) return;

    // Feed the GL view what the 2D view already holds. On first entry the
    // style is still loading, so MAP3D_READY repeats this once it is up.
    remirrorAll();
    refreshLightning({ force: true });

    toast('3D view — drag to orbit, right-drag to pitch');

    // Report what genuinely failed to mirror rather than predicting it: the
    // per-kind paths each have their own ways of coming up empty (a tainted
    // canvas, a source a style rejected), and only the result is trustworthy.
    setTimeout(() => {
      if (!runtime.is3D) return;
      const mirrored = new Set(mirroredGroups());
      const missing = [];
      for (const [group, slot] of slots) {
        if (!slot.enabled || !slot.type) continue;
        if (mirrored.has(group)) continue;
        missing.push(getLayerDef(group, slot.type)?.label || slot.type);
      }
      if (!missing.length) return;
      console.info(`[3d] not mirrored: ${missing.join(', ')}`);
      toast(`${missing.length} layer${missing.length > 1 ? 's' : ''} could not be shown in 3D`,
        { duration: 5000 });
    }, 6000);
  });

  // The logo is remote; fall back to the wordmark rather than a broken image.
  const logo = document.querySelector('.brand__logo');
  logo?.addEventListener('error', () => {
    logo.hidden = true;
    const fallback = document.querySelector('.brand__fallback');
    if (fallback) fallback.hidden = false;
  }, { once: true });

  byId('btn-fullscreen')?.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('Full screen was refused by the browser', { tone: 'error' });
    }
  });

  byId('btn-locate')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      toast('This browser has no location support', { tone: 'error' });
      return;
    }
    byId('btn-locate')?.classList.add('btn--busy');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        byId('btn-locate')?.classList.remove('btn--busy');
        showLocation(position);
      },
      () => {
        byId('btn-locate')?.classList.remove('btn--busy');
        toast('Could not determine your location', { tone: 'error' });
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Your location
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Station cards in 3D
 * ------------------------------------------------------------------ */

/**
 * Slides the camera until an open popup fits on screen.
 *
 * Leaflet pans for its own popups; Mapbox does not, and this card grows to
 * roughly four hundred pixels once the history arrives, which runs off the
 * bottom of the map from anywhere below the middle of it.
 */
function panPopupIntoView(glMap, popup, margin = 16) {
  const element = popup.getElement();
  const canvas = glMap.getCanvas();
  if (!element || !canvas) return;
  const card = element.getBoundingClientRect();
  const view = canvas.getBoundingClientRect();
  // Positive means the popup hangs off that edge by that many pixels.
  const dx = Math.max(0, view.left + margin - card.left) - Math.max(0, card.right - view.right + margin);
  const dy = Math.max(0, view.top + margin - card.top) - Math.max(0, card.bottom - view.bottom + margin);
  if (!dx && !dy) return;
  glMap.panBy([-dx, -dy], { duration: 220 });
}

/**
 * Opens the card for a station, in whichever view is showing.
 *
 * 2D and 3D need different popups — one is Leaflet's, one is Mapbox's — but the
 * card itself is the same DOM either way, and both have the same problem: it
 * opens one line tall and grows by several hundred pixels when the history
 * lands, so both are told to re-measure then.
 */
function openStationCard(station, glMap = null) {
  if (glMap) {
    const popup = new mapboxgl.Popup({
      className: 'wxcard-shell', maxWidth: '360px', closeButton: true, offset: 14,
    }).setLngLat([station.lon, station.lat]);
    popup.setDOMContent(buildStationCard(station, {
      // Mapbox recomputes the anchor on a position change, so setting the
      // position it already has is how it is asked to look again — and then the
      // camera is nudged, because unlike Leaflet's it will not do that itself
      // and the card is taller than the space below a mid-screen station.
      onReady: () => {
        if (!popup.isOpen()) return;
        popup.setLngLat(popup.getLngLat());
        panPopupIntoView(glMap, popup);
      },
    }));
    popup.addTo(glMap);
    return;
  }
  const popup = L.popup({ className: 'wxcard-shell', maxWidth: 360, autoPanPadding: [24, 24] })
    .setLatLng([station.lat, station.lon]);
  popup.setContent(buildStationCard(station, { onReady: () => popup.update() }));
  popup.openOn(map);
}

/**
 * Makes the station plots clickable on the GL map.
 *
 * The plots reach 3D as a picture — the 2D canvas, captured and draped over the
 * scene — so there is nothing there to hit-test and Leaflet never sees the
 * click. The stations' positions are known, though, and GL can project them, so
 * the nearest one to the pointer is found in screen space the same way the 2D
 * path finds it. Only the stations that survived thinning are considered: the
 * rest are not drawn, and a card for a plot nobody can see is a magic trick.
 *
 * `style.load` fires again on every restyle, so the handler is bound per map
 * instance rather than per event.
 */
let clickableGl = null;
function bindStationClicks3D(glMap) {
  if (!glMap || clickableGl === glMap) return;
  clickableGl = glMap;
  glMap.on('click', (event) => {
    if (!synoptic.options.enabled) return;
    let best = null;
    let bestDistance = 26;
    for (const station of synoptic.plottedStations()) {
      const at = glMap.project([station.lon, station.lat]);
      const distance = Math.hypot(at.x - event.point.x, at.y - event.point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = station;
      }
    }
    if (best) openStationCard(best, glMap);
  });
  glMap.on('mousemove', (event) => {
    if (!synoptic.options.enabled) return;
    const near = synoptic.plottedStations().some((station) => {
      const at = glMap.project([station.lon, station.lat]);
      return Math.hypot(at.x - event.point.x, at.y - event.point.y) < 26;
    });
    glMap.getCanvas().style.cursor = near ? 'pointer' : '';
  });
}

/**
 * Marks where the browser thinks the user is.
 *
 * The previous version dropped a bare Leaflet popup reading "Your location",
 * which carried none of the application's styling, and added a fresh marker on
 * every press so they piled up. This reuses one marker, shows the accuracy the
 * fix actually has — a 3 km fix and a 30 m fix mean very different things — and
 * uses the same popup shell as every other feature on the map.
 */
let locationMarker = null;
let locationHalo = null;

function formatAccuracy(metres) {
  if (!Number.isFinite(metres)) return 'accuracy unknown';
  return metres >= 1000
    ? `± ${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km`
    : `± ${Math.round(metres)} m`;
}

function showLocation(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const at = [latitude, longitude];

  map.flyTo(at, Math.max(map.getZoom(), 8), { duration: 0.8 });

  // The accuracy halo is a real circle in metres, so it shrinks and grows with
  // the zoom the way the uncertainty actually does.
  if (locationHalo) safeRemove(locationHalo);
  if (Number.isFinite(accuracy) && accuracy > 0) {
    locationHalo = L.circle(at, {
      radius: accuracy,
      pane: 'labelsPane',
      className: 'locate-halo',
      color: '#38bdf8',
      weight: 1,
      opacity: 0.5,
      fillColor: '#38bdf8',
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
  }

  if (locationMarker) safeRemove(locationMarker);
  locationMarker = L.circleMarker(at, {
    radius: 7,
    pane: 'labelsPane',
    color: '#fff',
    weight: 2,
    fillColor: '#38bdf8',
    fillOpacity: 1,
    className: 'locate-dot',
  }).addTo(map);

  locationMarker.bindPopup(`
    <div class="wx-popup">
      <header class="wx-popup__head" style="--accent:#38bdf8">
        <strong>Your location</strong>
      </header>
      <dl class="wx-popup__rows">
        <dt>Latitude</dt><dd>${latitude.toFixed(4)}°</dd>
        <dt>Longitude</dt><dd>${longitude.toFixed(4)}°</dd>
        <dt>Accuracy</dt><dd>${formatAccuracy(accuracy)}</dd>
      </dl>
    </div>`, { className: 'wx-popup-shell', closeButton: true }).openPopup();
}

/* ------------------------------------------------------------------ *
 * Cross-cutting wiring
 * ------------------------------------------------------------------ */

function bindEvents() {
  // The single place a time change turns into a weather re-render.
  on(EVENTS.TIME_COMMITTED, (timestamp) => renderAll(timestamp));

  // Resume any render that was deferred while the map was being manipulated.
  on(EVENTS.MAP_INTERACTION, ({ interacting }) => {
    if (!interacting) flushPending();
  });

  on(EVENTS.LAYER_TOGGLED, persistSession);
  on(EVENTS.LAYER_SELECTED, persistSession);

  // A dark base map wants the dark UI theme; keep them in step unless the user
  // has explicitly chosen otherwise.
  on(EVENTS.BASEMAP_CHANGED, ({ id }) => saveSetting('basemap', id));

  on(EVENTS.THEME_CHANGED, () => {
    // Leaflet caches container colours in a few places; a resize settles them.
    requestAnimationFrame(invalidateSizeIfChanged);
    refresh3DTheme();
  });

  // The GL style follows the base map choice, so changing it in 3D restyles.
  on(EVENTS.BASEMAP_CHANGED, () => refresh3DTheme());

  // The 3D mirror is captured at half resolution while playing; take it again at
  // full resolution once the frame being looked at stops changing.
  on(EVENTS.ANIMATION_STATE, ({ playing }) => {
    if (!playing) remirrorAll({ canvasOnly: true });
  });

  // A restyle drops every layer the GL map held, so re-feed it. The renderer
  // skips slots whose frame is already drawn, so the mirror is fed from the
  // layers the 2D map already holds rather than through a re-render.
  on(EVENTS.MAP3D_READY, () => {
    const failed = remirrorAll();
    refreshLightning({ force: true });
    if (failed.length) console.info('[3d] could not mirror:', failed.join(', '));
  });

  // Leaving 3D by any route must reset the toggle's pressed state.
  on(EVENTS.MODE_CHANGED, ({ mode }) => {
    const btn = byId('btn-3d');
    if (btn) {
      btn.setAttribute('aria-pressed', String(mode === '3d'));
      btn.classList.toggle('btn--active', mode === '3d');
    }
    // Products GL fetched for itself never had a Leaflet layer on the map;
    // rebuild them so 2D is not empty on the way back.
    if (mode === '2d' && exitGlDirect()) renderAll(time.current);
  });

  // Station models are fetched for the window on screen, so a pan to somewhere
  // the cached window does not cover needs a new request.
  map.on('moveend zoomend', debounce(() => synoptic.onViewChanged(), 400));

  // The station canvas is click-through, so the map delivers the click and the
  // nearest plot is looked up rather than hit-tested against painted pixels.
  map.on('click', (event) => {
    const station = synoptic.stationNear(event.containerPoint);
    if (station) openStationCard(station);
  });

  // The same, for the GL view, where Leaflet sees no clicks at all.
  on(EVENTS.MAP3D_READY, ({ gl }) => bindStationClicks3D(gl));

  // Station models follow the scrubber like every other layer.
  on(EVENTS.TIME_COMMITTED, debounce(() => synoptic.onTimeChanged(), 350));

  window.addEventListener('resize', debounce(invalidateSizeIfChanged, 150));

  // Re-render on view change so viewport-dependent products (OPERA, accumulation)
  // stay correct, but only once the map has settled.
  map.on('moveend zoomend', debounce(() => {
    if (!runtime.interacting) renderAll(time.current);
  }, 220));
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  // 1. Theme and performance profile before any rendering decision is made.
  document.documentElement.dataset.theme = runtime.theme;
  applyPerformanceMode();

  // Playback paces itself on the rendered frame; the controller cannot import
  // the renderer without dragging the map stack into a module that must load
  // without a DOM.
  timeCtl.setFramePacer(whenRenderSettled);
  // Products that hold their frame while the timeline moves catch up here.
  timeCtl.setPlaybackSettled(() => {
    flushPending();
    renderAll(time.current);
  });

  // 2. Map first, so the user sees something immediately.
  initMap();
  bindLayerControl(map);
  applyOrder();
  const savedBasemap = loadSetting('basemap', MAP_DEFAULTS.basemap);
  if (savedBasemap !== MAP_DEFAULTS.basemap) setBasemap(savedBasemap);

  // 3. Restore selections, then build the shell around them.
  restoreSession();
  buildRail();
  buildTimeline();
  buildLegend();
  buildSearch();
  bindTopbar();
  bindShortcuts();
  bindEvents();
  initOutlookFocus();
  initLayerManager();
  // Outlooks and drawings join the layer list as orderable overlays.
  registerOverlayLayers();
  syncCards();
  // The docked rail and timeline are measured so the panel sheet can sit above
  // them on a phone instead of underneath.
  trackDockedChrome();

  // 4. Start at the live edge and draw the first weather frame.
  timeCtl.goLive();
  timeCtl.startAutoFollow();

  // 5. With the map drawn, fetch what the session is most likely to want next.
  //    Outlooks are this application's reason for existing, so the storage SDK is
  //    pulled in while the browser is idle — off the critical path, but usually
  //    there before the panel is opened.
  prefetchIdle();

  // 6. Lightning loads in parallel; it must not gate the weather render.
  initLightning().catch((error) => {
    console.error('[boot] lightning init failed:', error);
    toast('Lightning data is unavailable', { tone: 'error' });
  });

  // Open the radar panel on a first visit so the controls are discoverable —
  // but not on a phone, where the panel is a bottom sheet that covers most of
  // the map. There the first thing to show is the map itself; the rail is
  // already visible and says what the panels are.
  if (!loadSetting('layers', null) && !DEVICE.mobile) openGroup('precip');

  emit(EVENTS.STATUS, { ready: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Exposed for console debugging and the test harness; nothing in the
// application itself reads these.
window.RadarLoop = {
  slots,
  time,
  runtime,
  renderAll,
  playback: timeCtl,
  map: () => map,
  lightningAll: () => lightningState.all,
  lightningFiltered: () => lightningState.filtered,
  lightningLifespan: () => lightningState.lifespanHours,
  lightning: lightningState,
  refreshLightning,
  strikeCueState,
  gl: () => getGl(),
  mirrorStats: () => ({ ...mirrorStats }),
  mirrorKind,
  phases: () => ({ ...(runtime.phases || {}) }),
  tileWorkers: () => ({ ...poolStats }),
  mapsglLayerIds: () => (window.__mapsglController?.weatherLayerIds || []).slice(),
  /** The stations a click can land on, for the 3D hit-test check. */
  plottedStations: () => synoptic.plottedStations(),
  observations: () => ({
    held: synoptic.stationCount(),
    plotted: synoptic.plottedCount(),
    at: synoptic.lastUpdated(),
    enabled: synoptic.options.enabled,
    scale: synoptic.plotScale(),
    forTime: synoptic.observationTime()?.toISOString() ?? null,
    sampleTemps: synoptic.sampleTemps(),
    magnification: mirrorMagnification(),
  }),
  refreshOverlayMirror,
  /** Opens the card for whichever station is plotted nearest the view centre. */
  openNearestStation: () => {
    const centre = map.getSize().divideBy(2);
    let found = null;
    for (let r = 20; r <= 260 && !found; r += 20) found = synoptic.stationNear(centre, r);
    if (!found) return null;
    openStationCard(found, is3D() ? getGl() : null);
    return found.id;
  },
  showLocation,
  startDrawing: () => draw.toggleDrawing(true),
  isDrawing: () => draw.isDrawing(),
  drawnCount: () => draw.drawnLayerCount(),
  addPolygon: (layer) => draw.addPolygon(layer),
  playSound: () => playStrikeSound(),
  soundUnlocked: () => isUnlocked(),
  soundPool: () => poolState(),
  selectProduct: (g, t) => selectProduct(g, t),
  setLayerEnabled,
  setLayerOpacity,
  moveLayer,
  layerOrder: () => activeInOrder(),
  setBasemap,
  openGroup,
  /** Drives the outlook-focus path directly, for the test harness. */
  focusWindow: (start, end) =>
    focusOutlook(start, end, { source: 'outlook:manual', label: 'Test window', userInitiated: true }),
};


// Debug/diagnostic surface for the catalog.
window.__layers = { LAYER_CATALOG, LAYER_ORDER };
// Tile addressing has to agree between the two views, so the rule is reachable
// from the harness that compares them.
window.__mirror3d = { tileScheme, usesFlippedY };
// The live strike feed's decoder and counters, for its own checks: the
// projection was settled by where the strikes land, so the test needs to look
// at decoded positions rather than at pixels alone.
window.__windyLightning = { decodeFeed, decodeStrike, feedStats };
// The catalog as the pickers see it — after the merge, the scrub and the
// ordering pass — so the list checks read the same thing the interface does.
window.__catalog = { LAYER_CATALOG, LAYER_ORDER };
// The satellite decode, reachable for its own checks: the two candidate
// polarities are exact negatives, so the test needs the rule and the pixels
// rather than a screenshot.
window.__windySat = {
  deinvertBlocks, daylightGrid, composeChannels,
  toLiveUrl, toArchiveUrl, frameTimeFromUrl, isArchiveOnly, archiveFrameTime,
};
