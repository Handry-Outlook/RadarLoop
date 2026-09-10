/**
 * The weather layer renderer.
 *
 * ## What replaced what
 *
 * The legacy renderer was `plotLayerIfNecessary` + `plotMainLayer`: ~700 lines
 * driven by two eleven-branch `switch (layerKey)` statements that read and wrote
 * a separate family of globals per layer group. A later patch script bolted a
 * proper front/back buffer onto *radar and satellite only*, overriding the main
 * path via `window.fastRadarSatelliteSliderUpdate`.
 *
 * Here the buffer is the primary mechanism and it applies to all eleven groups.
 * Each group owns a slot (see core/state.js) holding a front layer (visible) and
 * a back layer (loading). A frame is only promoted once its tiles have actually
 * loaded, so the map never flashes through to the base map mid-scrub, and a
 * superseded frame is discarded rather than drawn.
 */

import { DEVICE, LAYER_Z, TUNING, fetchConcurrency } from '../config.js';
import { emit, EVENTS } from '../core/bus.js';
import { map, safeRemove, setLayerOpacity } from '../core/map.js';
import { beginGeneration, isCurrentGeneration, runtime, slots, time, LAYER_GROUPS } from '../core/state.js';
import { pool } from '../core/util.js';
import { getLayerDef } from '../data/layers.js';
import { prefetchNeighbours, resolveFrame } from './resolver.js';
import { createOperaLayer } from './opera.js';
import { getSignature } from './radarScale.js';
import { createWindyRadarLayer, isWindyRadar } from './windy.js';
import { createWindyLightningLayer } from './windyLightning.js';
import { channelFor, createWindySatLayer, isWindySat } from './windySat.js';
import { renderMapsGLLayer, clearMapsGLLayer } from './mapsgl.js';
import { renderXweatherLayer, clearXweatherLayer } from './xweather.js';
import { renderGeoJsonLayer } from './geojson.js';
import { createWmsLayer } from './wms.js';
import { is3D } from '../core/map3d.js';
import { mirrorMapsGLSoon, mirrorTo3D, usesGlTileSource } from './mirrorBridge.js';
import { clearMirror, usesFlippedY } from '../core/mirror3d.js';
import { DEPS } from '../core/deps.js';

/* ------------------------------------------------------------------ *
 * Layer construction
 * ------------------------------------------------------------------ */

/** Tile options shared by every raster/vector product. */
function baseTileOptions(slot, def) {
  return {
    opacity: 0,
    zIndex: slot.zIndex,
    pane: paneFor(slot.group),
    tileSize: 256,
    crossOrigin: true,
    className: 'wx-tile',
    updateWhenIdle: DEVICE.mobile,
    updateWhenZooming: !DEVICE.mobile,
    keepBuffer: DEVICE.mobile ? 1 : 2,
    // The back buffer is invisible while loading, so there is nothing to fade.
    fadeAnimation: false,
    maxNativeZoom: 12,
    maxZoom: 18,
  };
}

function paneFor(group) {
  switch (group) {
    case 'satellite': return 'satellitePane';
    case 'radar': return 'radarPane';
    case 'observation': return 'observationPane';
    case 'isobar': return 'isobarPane';
    case 'surfaceFront': return 'frontPane';
    case 'warning': return 'warningPane';
    default: return 'overlayPane';
  }
}

/** Styles a DTN protobuf tile using the provider's own `fill-color` property. */
function dtnVectorStyle(opacity) {
  return (properties) => {
    const fill = typeof properties?.['fill-color'] === 'string' ? properties['fill-color'].trim() : '';
    if (!fill) {
      return { stroke: false, fill: false, weight: 0, opacity: 0, fillOpacity: 0, interactive: false };
    }
    return { stroke: false, fill: true, weight: 0, opacity: 0, fillColor: fill, fillOpacity: opacity };
  };
}

/**
 * Builds the Leaflet layer for one resolved frame. Returns null when the product
 * kind is handled by a dedicated subsystem (MapsGL, Xweather markers, …).
 */
async function buildLayer(slot, def, url, timestamp) {
  const options = baseTileOptions(slot, def);

  switch (def.kind) {
    case 'opera':
      return createOperaLayer(url, def, { pane: 'operaRadarPane', opacity: 0 });

    case 'image':
      return L.imageOverlay(url, def.bounds, {
        opacity: 0,
        pane: paneFor(slot.group),
        zIndex: slot.zIndex,
        className: 'wx-image',
      });

    case 'pbf':
      try {
        await DEPS.vectorGrid();
        return L.vectorGrid.protobuf(url, {
          ...options,
          vectorTileLayerStyles: { geojsonLayer: dtnVectorStyle(slot.opacity) },
          interactive: false,
          tms: false,
        });
      } catch {
        return L.tileLayer(url, { ...options, tms: false });
      }

    case 'geojson':
      return renderGeoJsonLayer(url, def, slot);

    case 'esri-feature':
      await DEPS.esri();
      return L.esri.featureLayer({
        url: def.url,
        pane: paneFor(slot.group),
        opacity: 0,
      });

    case 'wms':
      // Needs the {bbox} template expanded per tile — a plain tileLayer would
      // request the placeholder literally.
      return createWmsLayer(url, options);

    case 'raster':
    default:
      if (isWindyRadar(slot.type)) {
        // Same tile resolution in both modes; the recolour runs in workers, so
        // 3D no longer has to buy speed by rendering the composite softer.
        return createWindyRadarLayer(url, { ...options, timestamp });
      }
      if (isWindySat(slot.type)) {
        // The frame time is not decoration here: the visible/infrared blend is
        // decided by where the sun was when the image was taken, not now.
        return createWindySatLayer(url, { ...options, timestamp, channel: channelFor(slot.type) });
      }
      return L.tileLayer(url, { ...options, tms: usesFlippedY(slot.group, url) });
  }
}

/* ------------------------------------------------------------------ *
 * Load gating
 * ------------------------------------------------------------------ */

/**
 * Resolves once a layer has finished loading its visible tiles, or the deadline
 * passes. Committing on the *first* tile (as an earlier version did) exposes holes
 * where the rest of the viewport has not arrived, so we wait for Leaflet's `load`.
 */
function whenLoaded(layer, { timeoutMs, tolerateTileErrors = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      layer.off?.('load', onLoad);
      layer.off?.('error', onError);
      resolve(value);
    };
    const onLoad = () => finish(true);
    // Wide-area imagery routinely has a few tiles that 404 while a frame is
    // still publishing. Discarding the whole frame for one bad tile would blank
    // the background, so those layers wait for `load` or the deadline instead.
    const onError = () => {
      if (!tolerateTileErrors) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);

    if (typeof layer.on !== 'function' || !(layer instanceof L.GridLayer)) {
      if (layer instanceof L.ImageOverlay) {
        layer.once('load', onLoad);
        layer.once('error', onError);
      } else if (layer._isOperaLayer) {
        // The OPERA layer reprojects on the next animation frame and fires
        // `load` when the canvas actually has content. Promoting before that
        // would swap in an empty canvas.
        layer.once('load', onLoad);
      } else {
        // Vector groups and feature layers have their data already.
        finish(true);
      }
      return;
    }
    layer.on('load', onLoad);
    layer.on('error', onError);
  });
}

function loadDeadline(group, kind) {
  if (kind === 'opera') return 4000;
  if (group === 'satellite') return 8000;
  return time.playing ? 900 : 2500;
}

/* ------------------------------------------------------------------ *
 * Slot rendering
 * ------------------------------------------------------------------ */

/** Identity of a frame; equal keys mean there is nothing to redraw. */
function frameKey(slot, def, timestamp) {
  const interval = def.interval || 5 * 60 * 1000;
  const bucket = Math.floor(timestamp / interval);
  // The scale belongs in the key so that changing the rainfall colours counts as
  // a different frame for the products we colour ourselves.
  return `${slot.group}|${slot.type}|${bucket}|${recolourSignature(slot, def)}`;
}

/**
 * The colour scale a slot renders with, or empty for products the provider
 * colours server-side.
 *
 * Only the Windy composite and the OPERA grid are recoloured on the client, so
 * only those need rebuilding when the scale changes.
 */
function recolourSignature(slot, def = getLayerDef(slot.group, slot.type)) {
  return def && (def.kind === 'opera' || isWindyRadar(slot.type)) ? getSignature() : '';
}

/** Swaps the freshly loaded back buffer in and retires the old front buffer. */
function promote(slot, layer, timestamp, url) {
  const previous = slot.front;
  slot.front = layer;
  slot.back = null;
  slot.lastTimestamp = timestamp;
  slot.lastUrl = url;
  slot.scaleSignature = recolourSignature(slot);
  setLayerOpacity(layer, slot.enabled ? slot.opacity : 0);
  if (previous && previous !== layer) safeRemove(previous);
  runtime.stats.rendered += 1;
  emit(EVENTS.LAYER_RENDERED, { group: slot.group, type: slot.type, timestamp, url });
}

/** Drops whatever a slot currently shows. */
/**
 * Restores the 2D layers that were skipped while 3D was showing.
 *
 * A GL-direct slot never had its Leaflet layer added to the map, so leaving 3D
 * would otherwise reveal an empty one. Forgetting the frame key is what makes
 * the next render actually rebuild rather than recognise it as already drawn.
 */
export function exitGlDirect() {
  let restored = 0;
  for (const slot of slots.values()) {
    if (!slot.glDirect) continue;
    slot.glDirect = false;
    slot.frameKey = null;
    safeRemove(slot.front);
    slot.front = null;
    restored += 1;
  }
  return restored;
}

export function clearSlot(group) {
  const slot = slots.get(group);
  if (!slot) return;
  slot.token += 1;
  safeRemove(slot.front);
  safeRemove(slot.back);
  slot.front = null;
  slot.back = null;
  slot.frameKey = null;
  slot.lastTimestamp = null;
  slot.lastUrl = null;
  slot.scaleSignature = null;
  clearMapsGLLayer(group);
  clearXweatherLayer(group);
  clearMirror(group);
}

/**
 * Renders one layer group at `timestamp`.
 *
 * Returns quietly when the frame is already on screen — the single most valuable
 * optimisation, because scrubbing within one publishing interval is a no-op.
 */
async function renderSlot(group, timestamp, generation, activeLayers) {
  const slot = slots.get(group);
  if (!slot || !slot.enabled || !slot.type) return;

  let def = getLayerDef(group, slot.type);
  if (!def) return;

  // Radar in the future switches to the nowcast product, keeping the user's
  // selection intact so stepping back in time restores the observed layer.
  let extraTokens = {};
  if (group === 'radar' && timestamp > Date.now() + 2 * 60 * 1000) {
    const nowcast = getLayerDef('radar', 'radar-nowcast-forecast');
    if (nowcast) {
      def = nowcast;
      const issue = new Date(Math.floor(Date.now() / 300000) * 300000);
      extraTokens = {
        iso_now: issue.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        iso_future: new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
    }
  }

  // Products drawn by a dedicated engine bypass the tile pipeline entirely.
  if (def.kind === 'mapsgl') {
    const pending = renderMapsGLLayer(group, slot.type, slot, def);
    // MapsGL bypasses the tile pipeline, so nothing else would ever offer it to
    // 3D — which is why its products (Lightning All, the hail fields) were
    // missing there entirely.
    if (is3D()) mirrorMapsGLSoon(group, slot.opacity);
    return pending;
  }
  if (def.kind === 'xweather') {
    return renderXweatherLayer(group, slot.type, slot, timestamp);
  }

  // Live strikes. The layer polls and accumulates on its own, so there is no
  // frame to resolve, nothing to double-buffer and no URL to key on — which is
  // why it cannot go through the tile path below. It used to be handed to the
  // Xweather renderer, which has no case for it, so the product had never drawn
  // anything since the rewrite.
  if (def.kind === 'windy-lightning') {
    let layer = slot.front;
    if (!layer) {
      layer = createWindyLightningLayer({
        pane: paneFor(group),
        opacity: slot.opacity,
        // Polling repaints between renders, and a mirrored still would go stale
        // for as long as the view sat there. Re-capturing on paint is what keeps
        // 3D showing the strikes that 2D is showing.
        onPainted: () => {
          if (is3D()) mirrorTo3D(group, def, layer, LIVE_STRIKE_KEY, slot.opacity);
        },
      });
      layer.addTo(map);
    }
    promote(slot, layer, timestamp, LIVE_STRIKE_KEY);
    if (is3D()) mirrorTo3D(group, def, layer, LIVE_STRIKE_KEY, slot.opacity);
    return;
  }

  const key = frameKey(slot, def, timestamp);
  if (slot.frameKey === key && slot.front) {
    runtime.stats.skippedFrames += 1;
    return;
  }

  // A WMS renders on demand, and nothing has cached the frame being asked for —
  // EUMETSAT answers a warm tile in 0.3 s and a cold one in seconds. That is
  // survivable when you stop on a frame and ruinous when you do not:
  //
  //   * dragging across a hundred positions asked GeoServer for a hundred
  //     frames, each superseded before it arrived, with the one the user stopped
  //     on queued behind all of them;
  //   * during playback the pacer waits for every layer to settle, so one slow
  //     product set the frame rate for all of them — 3 radar frames in 14 s with
  //     EUMETSAT enabled against 39 without it, an eight-second gap against a
  //     third of a second.
  //
  // So a slow product holds its current frame while the timeline is moving and
  // catches up when it stops. The frame on screen stays correct for where the
  // scrubber was; it simply does not try to follow every step.
  if ((runtime.scrubbing || time.playing) && SLOW_TO_RENDER.has(def.kind)) {
    // Recorded separately from `pending`, which means 'a render is queued' and is
    // what the playback pacer waits on. Setting that here made every frame wait
    // for a layer that had deliberately opted out of the frame, and playback
    // stopped entirely: 0 frames in 14 s.
    deferred.add(group);
    return;
  }

  const token = ++slot.token;
  const resolved = await resolveFrame(slot.type, def, timestamp, {
    animating: time.playing,
    activeLayers,
    extraTokens,
  });

  if (token !== slot.token || !isCurrentGeneration(generation)) return;
  if (!resolved) {
    runtime.stats.failed += 1;
    emit(EVENTS.LAYER_FAILED, { group, type: slot.type, timestamp });
    return;
  }

  // Same URL as what is already displayed: nothing to build — unless this is a
  // product we colour ourselves and the scale has changed underneath it. The
  // frame URL cannot express that, so without this the rainfall colour picker
  // moved the legend and left the radar alone.
  if (slot.lastUrl === resolved.url && slot.front
      && slot.scaleSignature === recolourSignature(slot)) {
    slot.frameKey = key;
    return;
  }

  const _tResolve = performance.now();
  let layer;
  try {
    layer = await buildLayer(slot, def, resolved.url, resolved.timestamp);
  } catch (error) {
    console.warn(`[renderer] ${group}/${slot.type} failed to build:`, error);
    runtime.stats.failed += 1;
    return;
  }
  if (!layer) return;

  if (token !== slot.token || !isCurrentGeneration(generation)) {
    safeRemove(layer);
    return;
  }

  // Retire any previous back buffer; only one candidate per slot may be loading.
  if (slot.back) safeRemove(slot.back);
  slot.back = layer;

  // In 3D, a product GL fetches for itself does not need the Leaflet copy.
  //
  // Leaflet only requests tiles once its layer is on a map, and the gate below
  // waits for all of them. So the old path downloaded every tile into a map
  // nobody can see, waited for it, and only then handed GL a source — which
  // downloaded the same tiles again. Radar took 2.4 s to appear in 2D and 6.5 s
  // in 3D for that reason, and the EUMETSAT WMS was worse still, because its GL
  // template is rewritten to a different projection so not one of those second
  // requests could even be served from cache.
  //
  // Handing GL the source straight away skips both the duplicate download and
  // the wait for it. `exitGlDirect` puts the 2D layers back when 3D is left.
  if (is3D() && usesGlTileSource(def, layer)) {
    const _tBuild = performance.now();
    slot.frameKey = key;
    slot.glDirect = true;
    promote(slot, layer, resolved.timestamp, resolved.url);
    mirrorTo3D(group, def, layer, resolved.url, slot.opacity);
    runtime.phases = runtime.phases || {};
    runtime.phases[group] = {
      build: Math.round(_tBuild - _tResolve),
      load: 0,
      mirror: Math.round(performance.now() - _tBuild),
    };
    return;
  }

  setLayerOpacity(layer, 0);
  layer.addTo(map);

  const _tBuilt = performance.now();
  const ok = await whenLoaded(layer, {
    timeoutMs: loadDeadline(group, def.kind),
    tolerateTileErrors: group === 'satellite' || def.kind === 'wms',
  });

  // The slot moved on while this frame was loading — throw it away unseen.
  if (token !== slot.token || !isCurrentGeneration(generation)) {
    safeRemove(layer);
    if (slot.back === layer) slot.back = null;
    return;
  }
  if (!ok) {
    safeRemove(layer);
    slot.back = null;
    runtime.stats.failed += 1;
    return;
  }

  const _tLoaded = performance.now();
  slot.frameKey = key;
  promote(slot, layer, resolved.timestamp, resolved.url);

  // Mirror into the 3D view, which shares the selection but not the Leaflet
  // layers. Tile products go straight across; canvas-rendered ones (the
  // recoloured Windy composite, OPERA) hand over their finished raster instead.
  if (is3D()) mirrorTo3D(group, def, layer, resolved.url, slot.opacity);

  // Phase timings for the diagnostics panel and the perf probes.
  runtime.phases = runtime.phases || {};
  runtime.phases[group] = {
    build: Math.round(_tBuilt - _tResolve),
    load: Math.round(_tLoaded - _tBuilt),
    mirror: Math.round(performance.now() - _tLoaded),
  };

  if (!time.playing) prefetchNeighbours(slot.type, def, timestamp, { activeLayers });
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Kinds whose frames are generated per request rather than served from a tile
 * cache, so asking for one that will be thrown away has a real cost.
 */
const SLOW_TO_RENDER = new Set(['wms']);

/** Stands in for a frame URL on the live feed, which has none. */
const LIVE_STRIKE_KEY = 'live-strikes';

/** Groups holding their frame while the timeline moves, to be caught up after. */
const deferred = new Set();

let pending = null;
let rendering = false;
let lastRenderAt = 0;

/**
 * Renders every enabled layer for `timestamp`.
 *
 * Satellite is deliberately scheduled first: it is the visually dominant
 * background, so starting its download before the overlays makes the frame feel
 * like it arrives sooner even though total bytes are unchanged.
 */
export async function renderAll(timestamp) {
  if (runtime.interacting) {
    pending = timestamp;
    return;
  }
  const now = Date.now();
  if (time.playing && now - lastRenderAt < TUNING.minAnimationGapMs) {
    pending = timestamp;
    return;
  }
  if (rendering) {
    pending = timestamp;
    return;
  }

  rendering = true;
  lastRenderAt = now;
  const generation = beginGeneration();

  try {
    const active = LAYER_GROUPS.filter((group) => {
      const slot = slots.get(group);
      return slot?.enabled && slot.type;
    });

    if (active.length === 0) {
      for (const group of LAYER_GROUPS) clearSlot(group);
      emit(EVENTS.LEGEND_INVALIDATED);
      return;
    }

    const ordered = [
      ...active.filter((g) => g === 'satellite'),
      ...active.filter((g) => g !== 'satellite'),
    ];

    const jobs = ordered.map((group) => () => renderSlot(group, timestamp, generation, ordered.length));
    await pool(
      jobs,
      fetchConcurrency({ animating: time.playing, lowEndMode: runtime.lowEnd }),
      () => !isCurrentGeneration(generation) || runtime.interacting || pending !== null,
    );

    emit(EVENTS.LEGEND_INVALIDATED);
  } finally {
    rendering = false;
    if (pending !== null) {
      const next = pending;
      pending = null;
      // Let the browser paint the frame we just committed before starting the next.
      requestAnimationFrame(() => renderAll(next));
    }
  }
}

/** Applies a slot's opacity to its visible layer without re-fetching anything. */
export function applyOpacity(group) {
  const slot = slots.get(group);
  if (!slot?.front) return;
  setLayerOpacity(slot.front, slot.enabled ? slot.opacity : 0);
}

/** Re-runs the pending render once the map settles. */
export function flushPending() {
  // Anything that sat out the drag or the playback wants rebuilding, and its
  // frame key still says the old frame is current.
  for (const group of deferred) {
    const slot = slots.get(group);
    if (slot) slot.frameKey = null;
  }
  deferred.clear();

  if (pending === null) return;
  const next = pending;
  pending = null;
  renderAll(next);
}

export const hasPending = () => pending !== null;

/**
 * Resolves once nothing is being rendered and nothing is queued.
 *
 * Playback uses this to pace itself. Without it the loop scheduled the next
 * step on a bare timer, so at 4x it asked for a frame every 250 ms while frames
 * were taking around 700 ms: `renderAll` dropped two out of three requests but
 * the clock had already moved on, so tiles were fetched for frames that were
 * immediately superseded — 455 tile requests to draw 16 frames. Waiting for the
 * frame to land makes playback as fast as the data allows and no faster.
 */
export function whenRenderSettled(timeoutMs = 6000) {
  if (!rendering && pending === null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (!rendering && pending === null) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        // A stalled provider must not freeze playback.
        clearInterval(poll);
        resolve(false);
      }
    }, 30);
  });
}
