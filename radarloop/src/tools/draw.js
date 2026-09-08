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
  if (!drawnItems) drawnItems = new L.FeatureGroup();
  if (!map.hasLayer(drawnItems)) drawnItems.addTo(map);
  return drawnItems;
}

export function toggleDrawing(enabled = !drawing) {
  const items = ensureDrawnItems();

  if (!enabled) {
    if (drawControl) {
      map.removeControl(drawControl);
      drawControl = null;
    }
    drawing = false;
    return false;
  }

  if (typeof L.Control?.Draw !== 'function') {
    console.warn('[draw] leaflet-draw is unavailable');
    return false;
  }

  drawControl = new L.Control.Draw({
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
  const layer = event.layer;
  const risk = currentRisk.value;
  layer.setStyle(styleForRisk(risk));
  layer.feature = { type: 'Feature', properties: { name: risk } };
  layer.bindPopup(`<div class="wx-popup"><header class="wx-popup__head" style="--accent:${RISK_COLORS[risk]}">
    <strong>${escapeHtml(risk)}</strong></header></div>`, { className: 'wx-popup-shell' });
  ensureDrawnItems().addLayer(layer);
  emit(EVENTS.LEGEND_INVALIDATED);
}

export const isDrawing = () => drawing;

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
export function importKML(file) {
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
