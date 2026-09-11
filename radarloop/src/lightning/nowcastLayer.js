/**
 * Draws nowcast output: the current storm footprint, its projected positions and
 * a summary popup.
 *
 * Fills and outlines are deliberately in different panes. The fill interleaves
 * with the weather tiles (above satellite, below radar) so radar echoes stay
 * readable through it, while the outline sits above the whole weather stack so
 * the boundary is never lost. That separation is why there are two renderers
 * rather than one.
 *
 * The outline pane used to be declared inside `overlayPane` at z 145, under
 * radar and everything above it, so the second half of that was not true: a
 * projection's boundary was routinely buried by the echoes it was drawn around.
 */

import { map, renderers, safeRemove } from '../core/map.js';
import { escapeHtml } from '../core/util.js';
import { lightning } from '../core/state.js';
import { calculateNowcast, compassPoint, confidenceColour, impactLevel } from './nowcast.js';
import { refreshOverlayMirror } from '../layers/mirrorBridge.js';

let group = null;

function ensureGroup() {
  if (!group) group = L.layerGroup();
  if (!map.hasLayer(group)) group.addTo(map);
  return group;
}

/**
 * How the convective area is changing, as measured between two radar frames.
 *
 * A ratio is the honest number but not a readable one, so the bands are named.
 * The thresholds match the ones the projection scales the footprint by.
 */
function trendLabel(ratio) {
  if (ratio > 1.4) return 'growing quickly';
  if (ratio > 1.15) return 'growing';
  if (ratio < 0.6) return 'decaying quickly';
  if (ratio < 0.85) return 'decaying';
  return 'steady';
}

function popupHtml(cluster, forecast, impact) {
  return `
    <div class="wx-popup wx-popup--nowcast">
      <header class="wx-popup__head" style="--accent:${impact.colour}">
        <span class="wx-popup__eyebrow">Storm projection</span>
        <strong>+${forecast.timeMinutes} minutes</strong>
      </header>
      <div class="wx-popup__impact" style="--accent:${impact.colour}">${escapeHtml(impact.label)}</div>
      <dl class="wx-popup__rows wx-popup__rows--grid">
        <div><dt>Speed</dt><dd>${cluster.speedKmH.toFixed(1)} km/h</dd></div>
        <div><dt>Heading</dt><dd>${cluster.directionDeg.toFixed(0)}° ${compassPoint(cluster.directionDeg)}</dd></div>
        <div><dt>Confidence</dt><dd>${(cluster.confidence * 100).toFixed(0)}%</dd></div>
        <div><dt>Strikes</dt><dd>${cluster.clusterSize}</dd></div>
        <div><dt>Motion from</dt><dd>${cluster.motionSource === 'radar+lightning' ? 'radar and strikes' : 'strikes'}</dd></div>
        ${cluster.radarTrend === null || cluster.radarTrend === undefined ? '' : `
        <div><dt>Trend</dt><dd>${trendLabel(cluster.radarTrend)}</dd></div>`}
        ${cluster.lifeMinutes === null || cluster.lifeMinutes === undefined ? '' : `
        <div><dt>Expected to last</dt><dd>~${cluster.lifeMinutes} min</dd></div>`}
      </dl>
    </div>`;
}

/**
 * Recomputes and redraws the nowcast for a filtered strike set.
 * Returns the clusters drawn, for the legend.
 */
export function drawNowcast(filtered, reference) {
  if (group) group.clearLayers();
  if (!lightning.nowcast) {
    if (group) safeRemove(group);
    group = null;
    return [];
  }

  const clusters = calculateNowcast(filtered, reference);
  const layers = ensureGroup();
  const minConfidence = lightning.nowcastConfidence;
  const drawn = [];

  for (const cluster of clusters) {
    if (cluster.confidence < minConfidence) continue;
    drawn.push(cluster);

    const colour = confidenceColour(cluster.confidence);
    const baseOpacity = Math.max(0.2, cluster.confidence * 0.8 + 0.2);
    const impact = impactLevel(cluster.clusterSize, cluster.confidence);
    const strongAlert = impact.level >= 4;
    const outlineWeight = strongAlert ? 9 : 3;
    const forecastWeight = strongAlert ? 5 : 2.5;
    const outlineColour = strongAlert ? impact.colour : '#ef4444';

    // Furthest projection first so nearer ones draw on top.
    const projections = [...cluster.nowcastPolygons].sort((a, b) => b.timeMinutes - a.timeMinutes);
    for (const forecast of projections) {
      const latLngs = forecast.polygon.map(([lon, lat]) => [lat, lon]);
      const decay = 1 - forecast.timeMinutes / 80;

      L.polygon(latLngs, {
        pane: 'nowcastFillPane',
        renderer: renderers.nowcastFill,
        stroke: false,
        fillColor: colour,
        fillOpacity: baseOpacity * decay * 0.3,
        interactive: false,
      }).addTo(layers);

      L.polygon(latLngs, {
        pane: 'nowcastOutlinePane',
        renderer: renderers.nowcastOutline,
        color: outlineColour,
        weight: forecastWeight,
        opacity: Math.max(0.58, baseOpacity * Math.max(0.72, decay)),
        fill: false,
        dashArray: '5, 5',
      })
        .bindPopup(popupHtml(cluster, forecast, impact), { className: 'wx-popup-shell', closeButton: false })
        .addTo(layers);
    }

    if (cluster.hullGeometry) {
      L.geoJSON(cluster.hullGeometry, {
        pane: 'nowcastFillPane',
        renderer: renderers.nowcastFill,
        interactive: false,
        style: { fillColor: colour, fillOpacity: Math.min(baseOpacity, 0.7), stroke: false },
      }).addTo(layers);

      L.geoJSON(cluster.hullGeometry, {
        pane: 'nowcastOutlinePane',
        renderer: renderers.nowcastOutline,
        style: { color: outlineColour, weight: outlineWeight, opacity: 0.9, fill: false },
      }).addTo(layers);
    }
  }

  // 3D mirrors these panes as a still, so it has to be told they changed.
  refreshOverlayMirror();
  return drawn;
}

export function clearNowcast() {
  if (group) safeRemove(group);
  group = null;
  refreshOverlayMirror();
}
