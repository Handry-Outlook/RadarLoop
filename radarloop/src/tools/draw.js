/**
 * Polygon drawing and KML interchange.
 *
 * Drawn shapes carry a convective risk category, which drives their colour and is
 * round-tripped through KML so an outlook can be drawn here and opened elsewhere.
 * Severe is rendered as an outline only — it marks a hatched overlay area rather
 * than a fill category.
 */

import { RISK_COLORS, RISK_LEVELS } from '../config.js';
import { map, safeRemove } from '../core/map.js';
import { escapeHtml, loadSetting, saveSetting } from '../core/util.js';
import { emit, EVENTS } from '../core/bus.js';
import { is3D } from '../core/map3d.js';
import { start as start3D, stop as stop3D, isDrawing3D } from './draw3d.js';
import { bringOverlayToFront } from '../layers/control.js';
import { DEPS } from '../core/deps.js';

let drawnItems = null;
let drawControl = null;
let drawing = false;

const style = {
  opacity: loadSetting('polygonOpacity', 0.3),
  weight: loadSetting('polygonWeight', 2),
};

export const currentRisk = { value: RISK_LEVELS[0].id };

const isSevere = (risk) => risk === 'Severe risk';

function styleForRisk(risk) {
  const colour = RISK_COLORS[risk] || '#5aac91';
  return {
    color: colour,
    fillColor: isSevere(risk) ? 'transparent' : colour,
    fillOpacity: isSevere(risk) ? 0 : style.opacity,
    weight: style.weight,
  };
}

/* ------------------------------------------------------------------ *
 * Layer group + controls
 * ------------------------------------------------------------------ */

export function ensureDrawnItems() {
  // Its own pane, so the shapes can be restacked from the layer list like any
  // other overlay rather than being stuck wherever Leaflet put them.
  if (!drawnItems) drawnItems = new L.FeatureGroup([], { pane: 'drawPane' });
  if (!map.hasLayer(drawnItems)) drawnItems.addTo(map);
  return drawnItems;
}

export async function toggleDrawing(enabled = !drawing) {
  const items = ensureDrawnItems();

  // In 3D the Leaflet map is behind the GL canvas, so leaflet-draw has nothing
  // to draw on and no clicks to receive. The GL collector takes over there and
  // writes into this same feature group.
  if (enabled && is3D()) {
    stop3D();
    drawing = start3D((ring) => {
      addPolygon(L.polygon(ring));
      drawing = false;
      emit(EVENTS.DRAW_MODE, { drawing: false });
    }, RISK_COLORS[currentRisk.value]);
    return drawing;
  }
  if (!enabled) {
    stop3D();
    if (drawControl) {
      map.removeControl(drawControl);
      drawControl = null;
    }
    drawing = false;
    return false;
  }

  try {
    await DEPS.draw();
  } catch (error) {
    console.warn('[draw] leaflet-draw failed to load:', error);
    return false;
  }
  if (typeof L.Control?.Draw !== 'function') {
    console.warn('[draw] leaflet-draw is unavailable');
    return false;
  }

  drawControl = new L.Control.Draw({
    // Bottom-right: the default top-left corner is where the rail and the top bar
    // are, and the toolbar sat on top of them.
    position: 'bottomright',
    edit: { featureGroup: items },
    draw: {
      polygon: { allowIntersection: false, showArea: true, shapeOptions: styleForRisk(currentRisk.value) },
      rectangle: { shapeOptions: styleForRisk(currentRisk.value) },
      polyline: false,
      circle: false,
      circlemarker: false,
      marker: false,
    },
  });
  map.addControl(drawControl);
  drawing = true;

  map.off(L.Draw.Event.CREATED, onCreated);
  map.on(L.Draw.Event.CREATED, onCreated);
  return true;
}

function onCreated(event) {
  addPolygon(event.layer);
}

/**
 * Styles a finished shape and files it, whichever view drew it.
 *
 * Shared so a polygon drawn in 3D is indistinguishable from one drawn in 2D —
 * same style, same popup, same feature group, same KML export.
 */
export function addPolygon(layer) {
  const risk = currentRisk.value;
  layer.options.pane = 'drawPane';
  layer.setStyle(styleForRisk(risk));
  layer.feature = { type: 'Feature', properties: { name: risk } };
  layer.bindPopup(`<div class="wx-popup"><header class="wx-popup__head" style="--accent:${RISK_COLORS[risk]}">
    <strong>${escapeHtml(risk)}</strong></header></div>`, { className: 'wx-popup-shell' });
  const first = drawnLayerCount() === 0;
  ensureDrawnItems().addLayer(layer);
  // The first shape makes the drawings layer visible; put it on top rather than
  // inheriting wherever an inactive entry had drifted to.
  if (first) bringOverlayToFront('drawings');
  emit(EVENTS.LEGEND_INVALIDATED);
  emit(EVENTS.LAYER_ORDER, { order: [] });
  return layer;
}

export const isDrawing = () => drawing || isDrawing3D();

export function setRisk(risk) {
  currentRisk.value = risk;
  if (drawing) {
    // Rebuild the control so the next shape picks up the new colour.
    toggleDrawing(false);
    toggleDrawing(true);
  }
}

/* ------------------------------------------------------------------ *
 * Styling of existing shapes
 * ------------------------------------------------------------------ */

export function setPolygonOpacity(value) {
  style.opacity = value;
  saveSetting('polygonOpacity', value);
  restyleAll();
}

export function setPolygonWeight(value) {
  style.weight = value;
  saveSetting('polygonWeight', value);
  restyleAll();
}

function restyleAll() {
  drawnItems?.eachLayer((layer) => {
    const risk = layer.feature?.properties?.name || currentRisk.value;
    layer.setStyle?.(styleForRisk(risk));
  });
}

export const polygonStyle = () => ({ ...style });

export function clearDrawn() {
  drawnItems?.clearLayers();
  emit(EVENTS.LEGEND_INVALIDATED);
}

export const hasDrawn = () => !!drawnItems && drawnItems.getLayers().length > 0;

/** How many shapes have been drawn. */
export const drawnLayerCount = () => (drawnItems ? drawnItems.getLayers().length : 0);

/** Whether the drawn shapes are currently on the map. */
export const drawnVisible = () => !!drawnItems && map.hasLayer(drawnItems);

/**
 * Shows or hides the drawn shapes without discarding them.
 *
 * The layer list offers them as an ordinary layer, and turning a layer off there
 * must not destroy anything the user has drawn.
 */
export function setDrawnVisible(visible) {
  if (!drawnItems) return;
  if (visible) drawnItems.addTo(map);
  else map.removeLayer(drawnItems);
}

/* ------------------------------------------------------------------ *
 * KML export
 * ------------------------------------------------------------------ */

/** KML colours are aabbggrr, the reverse byte order of CSS #rrggbb. */
function kmlColour(hex, alphaHex) {
  const h = String(hex || '#000000').replace('#', '');
  return `${alphaHex}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

export function exportKML(filename = 'radarloop-outlook.kml') {
  if (!drawnItems || !drawnItems.getLayers().length) return false;

  const placemarks = [];
  drawnItems.eachLayer((layer) => {
    if (typeof layer.toGeoJSON !== 'function') return;
    const geometry = layer.toGeoJSON().geometry;
    const ring = geometry?.coordinates?.[0];
    if (!ring) return;

    const risk = layer.feature?.properties?.name || 'Low risk';
    const colour = RISK_COLORS[risk] || '#5aac91';
    const coordinates = ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ');

    placemarks.push(`
    <Placemark>
      <name>${escapeHtml(risk)}</name>
      <Style>
        <LineStyle><color>${kmlColour(colour, 'ff')}</color><width>${style.weight}</width></LineStyle>
        <PolyStyle><color>${kmlColour(colour, isSevere(risk) ? '00' : '7f')}</color></PolyStyle>
      </Style>
      <Polygon><outerBoundaryIs><LinearRing>
        <coordinates>${coordinates}</coordinates>
      </LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`);
  });

  if (!placemarks.length) return false;

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>RadarLoop outlook</name>${placemarks.join('')}
</Document>
</kml>`;

  downloadBlob(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }), filename);
  return true;
}

/* ------------------------------------------------------------------ *
 * KML import
 * ------------------------------------------------------------------ */

let importedKmlLayer = null;

/**
 * Imports a KML overlay. Polygons whose name matches a risk category are
 * coloured accordingly; anything else falls back to a neutral outline.
 */
export async function importKML(file) {
  // Only an import needs the KML parser.
  await DEPS.togeojson().catch(() => {});
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No KML file selected'));
    if (typeof toGeoJSON?.kml !== 'function') return reject(new Error('togeojson is unavailable'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = (event) => {
      try {
        const xml = new DOMParser().parseFromString(event.target.result, 'text/xml');
        const geojson = toGeoJSON.kml(xml);
        safeRemove(importedKmlLayer);

        importedKmlLayer = L.geoJSON(geojson, {
          style: (feature) => {
            const name = feature.properties?.name || '';
            return RISK_COLORS[name] ? styleForRisk(name) : { color: '#94a3b8', fillOpacity: 0, weight: 2 };
          },
          onEachFeature: (feature, layer) => {
            if (feature.properties?.name) {
              layer.bindPopup(escapeHtml(feature.properties.name), { className: 'wx-popup-shell' });
            }
          },
        });
        resolve({ layer: importedKmlLayer, geojson });
      } catch (error) {
        reject(error);
      }
    };
    reader.readAsText(file);
  });
}

export function setKmlVisible(visible) {
  if (!importedKmlLayer) return;
  if (visible) importedKmlLayer.addTo(map);
  else safeRemove(importedKmlLayer);
}

export const hasKml = () => !!importedKmlLayer;

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
