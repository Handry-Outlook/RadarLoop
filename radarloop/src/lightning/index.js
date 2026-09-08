/**
 * Lightning coordinator.
 *
 * Owns the "when the time or the data changes, redraw the right things" logic
 * that the legacy build spread across `updateHistory`, `applyFilter`,
 * `mergeAndRenderLightning`, `updateStrikeColors`, `updateHeatmap`,
 * `updateOverlay` and `updateNowcast`, each of which re-derived the filter window
 * from the DOM and could disagree with the others.
 */

import { emit, on, EVENTS } from '../core/bus.js';
import { lightning, time } from '../core/state.js';
import { throttle } from '../core/util.js';
import { activeWindow, domain } from '../time/controller.js';
import { ensureCoverage, fetchStrikes, filterWindow, noteVisible, oldestRetained, pruneBefore } from './source.js';
import { drawStrikes, refreshColours, removeStrikeLayer } from './render.js';
import { playThunder, updateCounter, updateHeatmap, clearOverlays } from './overlays.js';
import { installAudioUnlock } from './audio.js';
import { is3D, setStrikes as set3DStrikes } from '../core/map3d.js';
import { clearNowcast, drawNowcast } from './nowcastLayer.js';

let refreshTimer = null;
let lastDrawSignature = '';
let topUpInFlight = false;

/**
 * The oldest strike worth keeping: the earliest point the scrubber can reach,
 * less the lifespan window that would end there, plus a margin. Derived rather
 * than fixed so a long scrubber span or a focused forecast window keeps the data
 * it needs.
 */
export function retentionCutoff() {
  const reachable = domain().start;
  const lifespanMs = Math.max(1, lightning.lifespanHours) * 3600 * 1000;
  // Never discard the last two days regardless of how short the span is.
  const floor = Date.now() - 48 * 3600 * 1000;
  return Math.min(floor, reachable - lifespanMs - 3600 * 1000);
}

/**
 * Recomputes the visible strike set and redraws every dependent overlay.
 *
 * Throttled rather than debounced: dragging the scrubber keeps producing frames
 * at a steady rate instead of going blank until the drag stops.
 */
export const refresh = throttle((options = {}) => {
  const { start, end } = activeWindow(lightning.lifespanHours);
  const startMs = lightning.showAll ? -Infinity : start.getTime();
  const endMs = end.getTime();

  // Looking further back than the store currently holds: restore the archives
  // and redraw once they are merged. Cheap and idempotent when already covered.
  const oldest = oldestRetained();
  if (Number.isFinite(startMs) && oldest !== null && startMs < oldest && !topUpInFlight) {
    topUpInFlight = true;
    ensureCoverage(startMs)
      .then((added) => { if (added) refresh({ force: true }); })
      .catch((error) => console.warn('[lightning] archive top-up failed:', error))
      .finally(() => { topUpInFlight = false; });
  }

  const filtered = filterWindow(startMs, endMs);
  lightning.filtered = filtered;

  // Nothing to redo when neither the window nor the data moved.
  const signature = `${filtered.length}|${startMs}|${endMs}|${lightning.colorByAge}|${lightning.showLayer}|${lightning.lifespanHours}`;
  if (!options.force && signature === lastDrawSignature) return;
  lastDrawSignature = signature;

  const result = drawStrikes(filtered, { end, lifespanHours: lightning.lifespanHours });
  updateHeatmap(filtered);
  updateCounter(filtered);
  drawNowcast(filtered, end);

  // 3D shares the selection but not the Leaflet layers, so it is fed directly.
  if (is3D()) set3DStrikes(filtered, { end, lifespanHours: lightning.lifespanHours });

  // The cue marks genuinely new *data*. Gating on `fromData` matters: a redraw
  // caused by moving the scrubber also produces "fresh" strikes — they are only
  // newly in view — and without this the cue fired continuously while dragging.
  if (options.fromData && result.fresh > 0 && time.atLive && !time.playing) playThunder();

  emit(EVENTS.LIGHTNING_FILTERED, {
    total: lightning.all.length,
    shown: filtered.length,
    drawn: result.drawn,
    decimated: !!result.decimated,
    start,
    end,
  });
  emit(EVENTS.LEGEND_INVALIDATED);
}, 90);

/** Redraws colours only — no refiltering. Used by the age-colour toggle. */
export function recolour() {
  refreshColours();
  emit(EVENTS.LEGEND_INVALIDATED);
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

export function startPolling() {
  stopPolling();
  const minutes = time.refreshMinutes;
  if (!minutes || minutes <= 0) return;
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    await fetchStrikes();
    pruneBefore(retentionCutoff());
    refresh({ force: true, fromData: true });
  }, minutes * 60000);
}

export function stopPolling() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

export function setRefreshMinutes(minutes) {
  time.refreshMinutes = minutes;
  startPolling();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

export async function initLightning() {
  installAudioUnlock();

  on(EVENTS.TIME_COMMITTED, () => refresh());
  on(EVENTS.LIGHTNING_DATA, () => refresh({ force: true, fromData: true }));
  // A new domain changes both the filter window and what data must be retained.
  on(EVENTS.TIME_FOCUS, () => refresh({ force: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    noteVisible();
    fetchStrikes().then(() => refresh({ force: true, fromData: true }));
  });

  await fetchStrikes();
  // The first paint is not "new" data — it is the initial load.
  refresh({ force: true });
  startPolling();
}

export function teardownLightning() {
  stopPolling();
  removeStrikeLayer();
  clearOverlays();
  clearNowcast();
}

export { fetchStrikes, filterWindow };
