/**
 * GeoJSON weather products (bulletin zones, SIGMETs, cyclone tracks, corridors).
 *
 * These feeds carry their own styling hints in feature properties, so the styling
 * function reads the provider's colour where one is supplied and falls back to a
 * severity-derived palette otherwise.
 */

import { escapeHtml, formatDateTime } from '../core/util.js';
import { cleanLabel } from '../data/sourceNames.js';

/** Provider colour hints, in the order feeds tend to supply them. */
function featureColour(properties = {}) {
  const raw = properties.color || properties.colour || properties.fill || properties['fill-color'];
  if (typeof raw === 'string' && raw.trim()) {
    const value = raw.trim();
    return value.startsWith('#') ? value : `#${value}`;
  }
  const severity = String(properties.severity || properties.priority || '').toLowerCase();
  if (severity.includes('extreme') || severity.includes('red')) return '#e11d48';
  if (severity.includes('severe') || severity.includes('amber') || severity.includes('orange')) return '#f97316';
  if (severity.includes('moderate') || severity.includes('yellow')) return '#eab308';
  return '#38bdf8';
}

function popupHtml(properties = {}) {
  const title = properties.name || properties.headline || properties.title || properties.event || 'Feature';
  // Feeds carry the issuing body in any of a dozen field names, and this popup
  // renders whatever properties a feature happens to have — so the fields that
  // exist to identify a source are dropped, and the remaining free text is
  // scrubbed the same way labels are.
  const skip = new Set([
    'name', 'headline', 'title', 'color', 'colour', 'fill', 'fill-color',
    'source', 'sender', 'senderName', 'sender_name', 'agency', 'provider',
    'issuer', 'author', 'attribution', 'org', 'organisation', 'organization',
    'publisher', 'url', 'link', 'web', 'website', 'credit', 'copyright',
  ]);
  const rows = Object.entries(properties)
    .filter(([key, value]) => !skip.has(key) && value !== null && value !== undefined && typeof value !== 'object')
    .slice(0, 12)
    .map(([key, value]) => {
      const pretty = /(time|issued|expires|start|end)/i.test(key) && (typeof value === 'number' || /\d{4}-\d{2}/.test(value))
        ? formatDateTime(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
        : value;
      return `<dt>${escapeHtml(key.replace(/[_-]/g, ' '))}</dt><dd>${escapeHtml(cleanLabel(String(pretty)))}</dd>`;
    });

  return `
    <div class="wx-popup">
      <header class="wx-popup__head" style="--accent:${escapeHtml(featureColour(properties))}">
        <strong>${escapeHtml(cleanLabel(title) || 'Feature')}</strong>
      </header>
      ${rows.length ? `<dl class="wx-popup__rows">${rows.join('')}</dl>` : ''}
    </div>`;
}

/**
 * Fetches a GeoJSON frame and returns a styled Leaflet layer.
 * Returns null on failure so the renderer keeps the previous frame on screen.
 */
export async function renderGeoJsonLayer(url, def, slot) {
  let data;
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) return null;
    data = await response.json();
  } catch (error) {
    console.warn(`[geojson] ${slot.type} failed:`, error);
    return null;
  }
  if (!data) return null;

  return L.geoJSON(data, {
    pane: slot.group === 'warning' ? 'warningPane' : 'overlayPane',
    interactive: true,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: 5,
      fillColor: featureColour(feature.properties),
      color: '#0b0f17',
      weight: 1,
      fillOpacity: 0.9,
    }),
    style: (feature) => {
      const colour = featureColour(feature.properties);
      const isLine = feature.geometry?.type?.includes('LineString');
      return {
        color: colour,
        weight: isLine ? 3 : 1.5,
        fill: !isLine,
        fillColor: colour,
        fillOpacity: isLine ? 0 : slot.opacity * 0.35,
        opacity: slot.opacity,
      };
    },
    onEachFeature: (feature, layer) => {
      if (feature.properties) {
        layer.bindPopup(() => popupHtml(feature.properties), { className: 'wx-popup-shell', maxWidth: 360 });
      }
    },
  });
}
