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

import { MAP_DEFAULTS } from './config.js';
import { emit, on, EVENTS } from './core/bus.js';
import { initMap, invalidateSizeIfChanged, map, setBasemap } from './core/map.js';
import { lightning as lightningState, runtime, setTheme, slots, time, restoreSelection, serialiseSelection } from './core/state.js';
import { byId, debounce, loadSetting, saveSetting } from './core/util.js';
import { flushPending, renderAll } from './layers/renderer.js';
import { getLayerDef, LAYER_CATALOG, LAYER_ORDER } from './data/layers.js';
import * as timeCtl from './time/controller.js';
import { initLightning, refresh as refreshLightning } from './lightning/index.js';
import { isUnlocked, playStrikeSound, poolState } from './lightning/audio.js';
import { applyPerformanceMode, buildRail, closePanel, currentGroup, lastOpenedGroup, openGroup, syncCards } from './ui/panels.js';
import { bindShortcuts, buildTimeline } from './ui/timeline.js';
import { buildLegend, toggleLegendVisible } from './ui/legend.js';
import { buildSearch } from './ui/search.js';
import { showHelp } from './ui/help.js';
import { toast } from './ui/components.js';
import { initOutlookFocus, focusOutlook } from './hoco/focus.js';
import { exit3D, getGl, mirrorKind, mirroredGroups, refresh3DTheme, toggle3D } from './core/map3d.js';
import { tileScheme, usesFlippedY } from './core/mirror3d.js';
import { applyOrder, bindMap as bindLayerControl, selectProduct, setLayerEnabled } from './layers/control.js';
import { initLayerManager } from './ui/layerManager.js';
import { trackDockedChrome } from './ui/layout.js';
import { refreshOverlayMirror, remirrorAll, stats as mirrorStats } from './layers/mirrorBridge.js';
import { poolStats } from './layers/windyPool.js';

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

function bindTopbar() {
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
  btn3d?.addEventListener('click', () => {
    if (typeof mapboxgl === 'undefined') {
      toast('3D needs Mapbox GL, which did not load', { tone: 'error' });
      return;
    }
    const on = toggle3D();
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
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        map.flyTo([latitude, longitude], Math.max(map.getZoom(), 8), { duration: 0.8 });
        L.circleMarker([latitude, longitude], {
          radius: 7,
          color: '#38bdf8',
          weight: 2,
          fillColor: '#38bdf8',
          fillOpacity: 0.35,
        }).addTo(map).bindPopup('Your location').openPopup();
      },
      () => toast('Could not determine your location', { tone: 'error' }),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
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
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(mode === '3d'));
    btn.classList.toggle('btn--active', mode === '3d');
  });

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
  syncCards();
  // The docked rail and timeline are measured so the panel sheet can sit above
  // them on a phone instead of underneath.
  trackDockedChrome();

  // 4. Start at the live edge and draw the first weather frame.
  timeCtl.goLive();
  timeCtl.startAutoFollow();

  // 5. Lightning loads in parallel; it must not gate the weather render.
  initLightning().catch((error) => {
    console.error('[boot] lightning init failed:', error);
    toast('Lightning data is unavailable', { tone: 'error' });
  });

  // Open the radar panel on a first visit so the controls are discoverable.
  if (!loadSetting('layers', null)) openGroup('precip');

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
  map: () => map,
  lightningAll: () => lightningState.all,
  lightningFiltered: () => lightningState.filtered,
  lightningLifespan: () => lightningState.lifespanHours,
  gl: () => getGl(),
  mirrorStats: () => ({ ...mirrorStats }),
  mirrorKind,
  phases: () => ({ ...(runtime.phases || {}) }),
  tileWorkers: () => ({ ...poolStats }),
  refreshOverlayMirror,
  playSound: () => playStrikeSound(),
  soundUnlocked: () => isUnlocked(),
  soundPool: () => poolState(),
  selectProduct: (g, t) => selectProduct(g, t),
  setLayerEnabled,
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
