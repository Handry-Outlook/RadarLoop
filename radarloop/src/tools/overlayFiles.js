/**
 * User-supplied PNG overlays and the strike-area PNG export.
 *
 * PNG placement follows the legacy convention: if the filename mentions a known
 * region ("England", "Scotland", …) the overlay is georeferenced to that region's
 * bounds, otherwise it is placed over the current view for manual adjustment.
 */

import { REGION_BOUNDS } from '../config.js';
import { map, safeRemove } from '../core/map.js';
import { downloadBlob } from './draw.js';

let pngLayer = null;
let pngOpacity = 0.8;

/** Matches the longest region name present in the filename. */
export function boundsForFilename(name) {
  const lower = String(name || '').toLowerCase();
  const match = Object.keys(REGION_BOUNDS)
    .filter((region) => lower.includes(region.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return match ? REGION_BOUNDS[match] : null;
}

export function importPNG(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No PNG file selected'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = (event) => {
      const bounds = boundsForFilename(file.name) || map.getBounds();
      safeRemove(pngLayer);
      pngLayer = L.imageOverlay(event.target.result, bounds, {
        opacity: pngOpacity,
        interactive: false,
        className: 'user-png-overlay',
      });
      resolve({ layer: pngLayer, bounds, matchedRegion: !!boundsForFilename(file.name) });
    };
    reader.readAsDataURL(file);
  });
}

export function setPngVisible(visible) {
  if (!pngLayer) return;
  if (visible) pngLayer.addTo(map);
  else safeRemove(pngLayer);
}

export function setPngOpacity(value) {
  pngOpacity = value;
  pngLayer?.setOpacity?.(value);
}

export const hasPng = () => !!pngLayer;

/* ------------------------------------------------------------------ *
 * Strike export
 * ------------------------------------------------------------------ */

/**
 * Renders the strikes inside a bounding box to a PNG.
 *
 * Drawn independently of the map canvas because the map is composed of many
 * cross-origin tile layers, which taint a canvas and make `toBlob` throw.
 */
export function exportStrikesPng(strikes, bounds, { width = 1600, background = '#0b0f17' } = {}) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  const spanLat = north - south;
  const spanLon = east - west;
  if (!(spanLat > 0) || !(spanLon > 0)) return false;

  const height = Math.round(width * (spanLat / spanLon));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const inside = strikes.filter((s) => s.lat >= south && s.lat <= north && s.lon >= west && s.lon <= east);
  const newest = inside.length ? inside[inside.length - 1].ms : Date.now();
  const oldest = inside.length ? inside[0].ms : newest;
  const span = Math.max(1, newest - oldest);

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const s of inside) {
    const x = ((s.lon - west) / spanLon) * width;
    const y = ((north - s.lat) / spanLat) * height;
    const age = (newest - s.ms) / span;
    ctx.strokeStyle = `hsl(${50 - age * 40}, 100%, ${70 - age * 30}%)`;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4);
    ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '16px Inter, system-ui, sans-serif';
  ctx.fillText(`RadarLoop · ${inside.length} strikes`, 16, height - 18);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(false);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(blob, `radarloop-strikes-${stamp}.png`);
      resolve(true);
    }, 'image/png');
  });
}

/**
 * Lets the user drag a rectangle on the map and resolves with its bounds.
 * Resolves null if they press Escape.
 */
export function pickRectangle() {
  return new Promise((resolve) => {
    const container = map.getContainer();
    let origin = null;
    let box = null;

    const cleanup = () => {
      map.dragging.enable();
      container.style.cursor = '';
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown', onKey);
      if (box) safeRemove(box);
    };

    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      cleanup();
      resolve(null);
    };

    const toLatLng = (event) => {
      const rect = container.getBoundingClientRect();
      return map.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top]);
    };

    const onDown = (event) => {
      origin = toLatLng(event);
      box = L.rectangle([origin, origin], { color: '#38bdf8', weight: 2, dashArray: '6 4', fill: false }).addTo(map);
    };
    const onMove = (event) => {
      if (!origin || !box) return;
      box.setBounds(L.latLngBounds(origin, toLatLng(event)));
    };
    const onUp = (event) => {
      if (!origin) return;
      const bounds = L.latLngBounds(origin, toLatLng(event));
      cleanup();
      resolve(bounds.getNorth() === bounds.getSouth() ? null : bounds);
    };

    map.dragging.disable();
    container.style.cursor = 'crosshair';
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  });
}
