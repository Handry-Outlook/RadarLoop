/**
 * Drawing polygons on the 3D map.
 *
 * leaflet-draw only knows about the Leaflet map, and in 3D that map is hidden
 * behind the GL canvas — so pressing "Start drawing" there did nothing you could
 * see or click. Rather than trying to drive leaflet-draw through a hidden map,
 * this collects vertices from the GL canvas directly and hands the finished ring
 * to the same store the 2D tool writes into, so a shape drawn in 3D is the same
 * object as one drawn in 2D: it appears in both views, in the layer list, and in
 * the KML export.
 *
 * The interaction is the conventional one: click to place a vertex, click the
 * first vertex again or press Enter to close, Backspace to undo the last one,
 * Escape to abandon. A rubber band follows the pointer so the shape is visible
 * before it is finished, which matters more in 3D than in 2D — on a pitched
 * camera it is otherwise hard to tell where a click landed.
 */

import { getGl, is3D } from '../core/map3d.js';
import { emit, EVENTS } from '../core/bus.js';

const SRC = 'wx-draw-progress';
const FILL = 'wx-draw-progress-fill';
const LINE = 'wx-draw-progress-line';
const DOTS = 'wx-draw-progress-dots';

/** Screen distance, in pixels, within which a click counts as "on the first vertex". */
const CLOSE_RADIUS = 14;

let active = false;
let points = [];
let hover = null;
let onFinish = null;
let accent = '#38bdf8';

const gl = () => getGl();

/* ------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------ */

function previewData() {
  const ring = hover ? [...points, hover] : [...points];
  const features = [];

  if (ring.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: ring },
      properties: {},
    });
  }
  if (ring.length >= 3) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
      properties: {},
    });
  }
  for (const p of points) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} });
  }
  return { type: 'FeatureCollection', features };
}

function paint() {
  const map = gl();
  if (!map) return;
  const data = previewData();
  const source = map.getSource(SRC);
  if (source) {
    source.setData(data);
    return;
  }

  try {
    map.addSource(SRC, { type: 'geojson', data });
    map.addLayer({
      id: FILL,
      type: 'fill',
      source: SRC,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': accent, 'fill-opacity': 0.25 },
    });
    map.addLayer({
      id: LINE,
      type: 'line',
      source: SRC,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': accent, 'line-width': 2 },
    });
    map.addLayer({
      id: DOTS,
      type: 'circle',
      source: SRC,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#fff',
        'circle-stroke-color': accent,
        'circle-stroke-width': 2,
      },
    });
  } catch (error) {
    console.warn('[draw3d] preview unavailable:', error);
  }
}

function clearPreview() {
  const map = gl();
  if (!map) return;
  for (const id of [DOTS, LINE, FILL]) {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch { /* style gone */ }
  }
  try { if (map.getSource(SRC)) map.removeSource(SRC); } catch { /* style gone */ }
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

/** True when the click landed on the first vertex, which closes the ring. */
function closesRing(event) {
  const map = gl();
  if (!map || points.length < 3) return false;
  const first = map.project(points[0]);
  return Math.hypot(first.x - event.point.x, first.y - event.point.y) <= CLOSE_RADIUS;
}

function onClick(event) {
  if (closesRing(event)) {
    finish();
    return;
  }
  points.push([event.lngLat.lng, event.lngLat.lat]);
  paint();
}

function onMove(event) {
  if (!points.length) return;
  hover = [event.lngLat.lng, event.lngLat.lat];
  paint();
}

function onKey(event) {
  if (event.key === 'Escape') {
    cancel();
  } else if (event.key === 'Enter') {
    finish();
  } else if (event.key === 'Backspace' && points.length) {
    event.preventDefault();
    points.pop();
    paint();
  }
}

function finish() {
  // Three distinct vertices is the minimum that encloses anything.
  if (points.length < 3) {
    cancel();
    return;
  }
  const ring = points.map(([lng, lat]) => [lat, lng]);
  const done = onFinish;
  stop();
  done?.(ring);
}

function cancel() {
  stop();
  emit(EVENTS.LEGEND_INVALIDATED);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Whether a 3D drawing session is in progress. */
export const isDrawing3D = () => active;

/**
 * Starts collecting a polygon from the GL map.
 *
 * @param {(latLngs: Array<[number, number]>) => void} handler
 *   receives the finished ring as Leaflet-order [lat, lng] pairs
 * @param {string} colour preview colour, normally the current risk's
 * @returns {boolean} whether a session started
 */
export function start(handler, colour) {
  const map = gl();
  if (!is3D() || !map) return false;
  stop();

  active = true;
  points = [];
  hover = null;
  onFinish = handler;
  accent = colour || accent;

  map.on('click', onClick);
  map.on('mousemove', onMove);
  window.addEventListener('keydown', onKey);
  map.getCanvas().style.cursor = 'crosshair';
  paint();
  return true;
}

export function stop() {
  const map = gl();
  if (map) {
    map.off('click', onClick);
    map.off('mousemove', onMove);
    try { map.getCanvas().style.cursor = ''; } catch { /* canvas gone */ }
  }
  window.removeEventListener('keydown', onKey);
  clearPreview();
  active = false;
  points = [];
  hover = null;
  onFinish = null;
}

/** Number of vertices placed so far, for the tools panel's hint. */
export const vertexCount = () => points.length;
