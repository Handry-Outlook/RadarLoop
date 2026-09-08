/**
 * Secondary strike visualisations: the density heatmap, the grid-cell counter
 * overlay and the thunder cue.
 *
 * Both overlays are rebuilt only while switched on. The legacy build recomputed
 * the heatmap on every filter change regardless of whether it was visible, which
 * meant rasterising tens of thousands of points for nothing — the common case.
 */

import { map, safeRemove } from '../core/map.js';
import { lightning } from '../core/state.js';
import { playStrikeSound } from './audio.js';

/* ------------------------------------------------------------------ *
 * Heatmap
 * ------------------------------------------------------------------ */

let heatLayer = null;

const HEAT_GRADIENT = {
  0.0: '#001219', 0.1: '#001219', 0.2: '#0a9396', 0.3: '#94d2bd', 0.4: '#e9d8a6',
  0.5: '#c89578', 0.6: '#ee9b00', 0.7: '#ca6702', 0.8: '#bb3e03', 0.9: '#ae2012', 1.0: '#9b2226',
};

export function updateHeatmap(filtered) {
  if (!lightning.heatmap) {
    if (heatLayer) {
      safeRemove(heatLayer);
      heatLayer = null;
    }
    return;
  }
  if (typeof L.heatLayer !== 'function') return;

  const points = filtered.map((s) => [s.lat, s.lon, 1]);
  if (heatLayer) safeRemove(heatLayer);

  heatLayer = L.heatLayer(points, {
    radius: lightning.heatmapBlur,
    blur: 15,
    maxZoom: 10,
    minZoom: 10,
    gradient: HEAT_GRADIENT,
  });
  heatLayer.addTo(map);
  if (heatLayer._canvas) heatLayer._canvas.style.zIndex = '70';
}

export function toggleHeatmap(enabled, filtered) {
  lightning.heatmap = enabled;
  updateHeatmap(filtered);
}

export const hasHeatmap = () => !!heatLayer;

/* ------------------------------------------------------------------ *
 * Counter grid
 * ------------------------------------------------------------------ */

let counterLayer = null;

/**
 * Bins strikes into a lat/lon grid and labels each populated cell with its count.
 * Grid resolution follows the density slider.
 */
export function updateCounter(filtered) {
  if (counterLayer) {
    safeRemove(counterLayer);
    counterLayer = null;
  }
  if (!lightning.counter || !filtered.length) return;

  // Larger slider value -> finer grid.
  const cells = Math.max(4, Math.round(lightning.counterDensity / 4));
  const bounds = map.getBounds();
  const latStep = (bounds.getNorth() - bounds.getSouth()) / cells;
  const lonStep = (bounds.getEast() - bounds.getWest()) / cells;
  if (!(latStep > 0) || !(lonStep > 0)) return;

  const buckets = new Map();
  for (const s of filtered) {
    if (!bounds.contains([s.lat, s.lon])) continue;
    const row = Math.floor((s.lat - bounds.getSouth()) / latStep);
    const col = Math.floor((s.lon - bounds.getWest()) / lonStep);
    const key = `${row}|${col}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  if (!buckets.size) return;

  const markers = [];
  for (const [key, count] of buckets) {
    const [row, col] = key.split('|').map(Number);
    const lat = bounds.getSouth() + (row + 0.5) * latStep;
    const lon = bounds.getWest() + (col + 0.5) * lonStep;
    markers.push(
      L.marker([lat, lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: 'strike-count',
          html: `<span>${count}</span>`,
          iconSize: [34, 18],
        }),
      }),
    );
  }
  counterLayer = L.layerGroup(markers).addTo(map);
}

export function toggleCounter(enabled, filtered) {
  lightning.counter = enabled;
  updateCounter(filtered);
}

/* ------------------------------------------------------------------ *
 * Thunder
 * ------------------------------------------------------------------ */

/** Plays the strike cue, if the user has it enabled. See lightning/audio.js. */
export function playThunder() {
  if (!lightning.sound) return false;
  return playStrikeSound();
}

export function clearOverlays() {
  if (heatLayer) { safeRemove(heatLayer); heatLayer = null; }
  if (counterLayer) { safeRemove(counterLayer); counterLayer = null; }
}
