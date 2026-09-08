/**
 * Xweather point and polygon products: storm threats, hail threats, live strikes
 * and official alerts.
 *
 * These are JSON feeds rather than tiles, so each product is normalised into
 * GeoJSON and drawn as a single Leaflet layer. Refreshes swap the data on the
 * existing layer instead of recreating it, which is what stops the overlay
 * flickering on every poll.
 */

import { CREDENTIALS } from '../config.js';
import { escapeHtml, formatDateTime } from '../core/util.js';
import { map, safeRemove } from '../core/map.js';
import { emit, EVENTS } from '../core/bus.js';
import { is3D } from '../core/map3d.js';
import { clearMirror, mirrorGeoJson } from '../core/mirror3d.js';
import { cleanLabel } from '../data/sourceNames.js';

const AUTH = `client_id=${CREDENTIALS.xweatherId}&client_secret=${CREDENTIALS.xweatherSecret}`;
const WORLD = '-90,-180,90,180';

const ENDPOINTS = {
  'xweather-storm-threats': `https://data.api.xweather.com/lightning/threats/within?p=${WORLD}&limit=500&${AUTH}`,
  'xweather-hail-threats': `https://data.api.xweather.com/hail/threats/within?p=${WORLD}&${AUTH}`,
  'xweather-lightning': `https://data.api.xweather.com/lightning/within?p=${WORLD}&limit=5000&${AUTH}`,
  'xweather-alerts': `https://data.api.xweather.com/alerts/within?p=${WORLD}&limit=5000&filter=geo&${AUTH}`,
};

/** group -> Leaflet layer currently shown. */
const layers = new Map();

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

const empty = () => ({ type: 'FeatureCollection', features: [] });

export function toGeoJson(data, type) {
  if (!data?.response) return empty();
  const features = [];

  switch (type) {
    case 'xweather-alerts':
      for (const alert of data.response) {
        const geometry = alert.geoPoly || alert.poly ||
          (alert.loc ? { type: 'Point', coordinates: [alert.loc.long, alert.loc.lat] } : null);
        if (!geometry) continue;
        const raw = alert.details?.color || '808080';
        features.push({
          type: 'Feature',
          geometry,
          properties: {
            id: alert.id,
            name: alert.details?.name,
            body: alert.details?.bodyFull || alert.details?.body,
            issued: alert.timestamps?.issuedISO,
            expires: alert.timestamps?.expiresISO,
            color: raw.startsWith('#') ? raw : `#${raw}`,
            place: alert.place?.name || 'Unknown location',
          },
        });
      }
      break;

    case 'xweather-hail-threats':
      for (const hail of data.response) {
        const period = hail.periods?.[0];
        if (!period?.polygon) continue;
        features.push({
          type: 'Feature',
          geometry: period.polygon,
          properties: {
            ...hail.details,
            severe: true,
            name: 'Hail Threat',
            color: '#ea00ff',
            hailProb: period.hail?.prob ?? 0,
          },
        });
      }
      break;

    case 'xweather-storm-threats':
      for (const threat of data.response) {
        const period = threat.periods?.[0];
        if (!period?.polygon) continue;
        features.push({
          type: 'Feature',
          geometry: period.polygon,
          properties: { name: 'Storm Threat', color: '#ff9800', details: threat.details },
        });
      }
      break;

    case 'xweather-lightning':
      for (const strike of data.response) {
        if (!strike.loc) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [strike.loc.long, strike.loc.lat] },
          properties: {
            timestamp: strike.ob?.timestamp,
            type: 'lightning',
            name: 'Lightning strike',
            color: '#ffeb3b',
          },
        });
      }
      break;

    default:
      break;
  }

  return { type: 'FeatureCollection', features };
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function fetchProduct(type) {
  const url = ENDPOINTS[type];
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[xweather] ${type} returned HTTP ${response.status}`);
      return null;
    }
    const text = await response.text();
    if (!text) return null;
    const data = JSON.parse(text);
    return data?.success ? toGeoJson(data, type) : null;
  } catch (error) {
    console.warn(`[xweather] ${type} failed:`, error);
    return null;
  }
}

/** The combined product overlays live storm and hail threats together. */
async function fetchCombined() {
  const [storm, hail] = await Promise.all([
    fetchProduct('xweather-storm-threats'),
    fetchProduct('xweather-hail-threats'),
  ]);
  if (!storm && !hail) return null;
  return {
    type: 'FeatureCollection',
    features: [...(storm?.features || []), ...(hail?.features || [])],
  };
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

function popupHtml(properties, type) {
  // Alert titles and bodies are third-party prose and routinely name the issuing
  // agency, so they go through the same scrub as our own labels. Removing a name
  // mid-sentence can read a little oddly; leaving it in would disclose the source.
  const rows = [];
  if (properties.place) rows.push(['Location', properties.place]);
  if (properties.issued) rows.push(['Issued', formatDateTime(properties.issued)]);
  if (properties.expires) rows.push(['Expires', formatDateTime(properties.expires)]);
  if (properties.hailProb) rows.push(['Hail probability', `${properties.hailProb}%`]);
  if (properties.timestamp) rows.push(['Time', formatDateTime(properties.timestamp * 1000)]);

  const body = properties.body
    ? `<div class="wx-popup__body">${escapeHtml(cleanLabel(properties.body)).slice(0, 1200)}</div>`
    : '';

  return `
    <div class="wx-popup" data-kind="${escapeHtml(type)}">
      <header class="wx-popup__head" style="--accent:${escapeHtml(properties.color || '#ff9800')}">
        <strong>${escapeHtml(cleanLabel(properties.name) || 'Weather feature')}</strong>
      </header>
      ${rows.length ? `<dl class="wx-popup__rows">${rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('')}</dl>` : ''}
      ${body}
    </div>`;
}

function buildLayer(geojson, type, opacity) {
  return L.geoJSON(geojson, {
    pane: 'overlayPane',
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 4,
      fillColor: feature.properties?.color || '#fff200',
      color: '#000',
      weight: 1,
      opacity: 1,
      fillOpacity: 0.9,
    }),
    style: (feature) => {
      const isHail = feature.properties?.name === 'Hail Threat';
      const colour = isHail ? '#800080' : (feature.properties?.color || '#ff4500');
      return {
        color: colour,
        weight: isHail ? 4 : 3,
        fill: true,
        fillColor: colour,
        fillOpacity: (isHail ? 0.3 : 0.1) * (opacity / 0.8),
        dashArray: isHail ? '5, 10' : null,
      };
    },
    onEachFeature: (feature, layer) => {
      layer.bindPopup(() => popupHtml(feature.properties || {}, type), {
        className: 'wx-popup-shell',
        maxWidth: 380,
      });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export async function renderXweatherLayer(group, type, slot) {
  const geojson = type === 'stormHailThreat' ? await fetchCombined() : await fetchProduct(type);
  if (!geojson?.features?.length) return;

  const existing = layers.get(group);
  if (existing && existing._xwType === type) {
    // Swapping the data in place keeps the overlay from flashing on refresh.
    existing.clearLayers();
    existing.addData(geojson);
    // 3D holds its own copy of the features, so it needs the new data too — the
    // early return used to leave the mirror showing the previous refresh.
    if (is3D()) mirrorGeoJson(group, geojson, slot.opacity);
    return;
  }

  if (existing) safeRemove(existing);
  const layer = buildLayer(geojson, type, slot.opacity);
  layer._xwType = type;
  layer.addTo(map);
  layers.set(group, layer);

  // These are already GeoJSON, so 3D takes the same features directly.
  if (is3D()) mirrorGeoJson(group, geojson, slot.opacity);

  emit(EVENTS.LAYER_RENDERED, { group, type, features: geojson.features.length });
}

export function clearXweatherLayer(group) {
  const layer = layers.get(group);
  if (!layer) return;
  safeRemove(layer);
  layers.delete(group);
  clearMirror(group);
}

export function setXweatherOpacity(group, opacity) {
  const layer = layers.get(group);
  layer?.setStyle?.({ opacity, fillOpacity: opacity * 0.35 });
}
