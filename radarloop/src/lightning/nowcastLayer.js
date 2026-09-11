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
import { calculateNowcast, compassPoint } from './nowcast.js';
import { refreshOverlayMirror } from '../layers/mirrorBridge.js';

/**
 * The nowcast's own colours.
 *
 * Cyan, and nothing warm. The strike age ramp runs yellow, magenta, pink,
 * purple, indigo — it owns every warm and violet hue on the map — and the
 * outline used to be drawn in red with a fill that ramped to violet at high
 * confidence, which is the colour of the oldest strikes. A projection drawn
 * around a dense field was therefore drawn in the field's own colours and
 * disappeared into it. Cyan is the part of the wheel nothing else is using.
 *
 * Every line is drawn twice, a dark halo first and the colour over it, so the
 * boundary holds against bright strikes and dark sea alike without needing a
 * colour that works on both.
 */
const EDGE = '#22d3ee';
const SEVERE_EDGE = '#f8fafc';

/**
 * Hail. Amber, which nothing else on the map is using as a boundary — the strike
 * ramp's yellow is a mark rather than a line, and the rainfall scale is a filled
 * field. With the halo under it there is no mistaking one for the other.
 */
const HAIL_EDGE = '#fbbf24';
const HALO = 'rgba(2, 6, 23, 0.85)';

let group = null;
let lastDrawn = [];

/** The projections as last drawn. For the legend, and for the checks. */
export const lastNowcastClusters = () => lastDrawn;

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
        <strong>${forecast.timeMinutes ? `+${forecast.timeMinutes} minutes` : 'now'}</strong>
      </header>
      <div class="wx-popup__impact" style="--accent:${impact.colour}">${escapeHtml(impact.label)}</div>
      <dl class="wx-popup__rows wx-popup__rows--grid">
        <div><dt>Speed</dt><dd>${cluster.speedKmH.toFixed(1)} km/h</dd></div>
        <div><dt>Heading</dt><dd>${cluster.directionDeg.toFixed(0)}° ${compassPoint(cluster.directionDeg)}</dd></div>
        <div><dt>Confidence</dt><dd>${(cluster.confidence * 100).toFixed(0)}%</dd></div>
        <div><dt>Strikes</dt><dd>${cluster.clusterSize}</dd></div>
        <div><dt>Motion from</dt><dd>${cluster.motionSource === 'radar+lightning' ? 'radar and strikes' : 'strikes'}</dd></div>
        <div><dt>Flash rate</dt><dd>${cluster.flashesPerMinute.toFixed(cluster.flashesPerMinute < 10 ? 1 : 0)}/min</dd></div>
        ${cluster.peakDbz === null ? '' : `
        <div><dt>Peak echo</dt><dd>${Math.round(cluster.peakDbz)} dBZ</dd></div>`}
        ${!cluster.hail ? '' : `
        <div><dt>Hail</dt><dd>${escapeHtml(cluster.hail.label)}</dd></div>`}
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

    const impact = cluster.impact;
    const strongAlert = impact.level >= 4;
    // Hail gets its own colour. Severity is already carried by the line weight,
    // so the hue is free to say something the weight cannot.
    const hailing = (cluster.hail?.level ?? 0) >= 1;
    const edge = hailing ? HAIL_EDGE : (strongAlert ? SEVERE_EDGE : EDGE);
    const baseOpacity = Math.max(0.45, cluster.confidence * 0.8 + 0.2);

    /** A line with a dark halo under it, so it reads on any background. */
    const stroke = (latLngs, { weight, dash, opacity, close }) => {
      const shared = {
        pane: 'nowcastOutlinePane',
        renderer: renderers.nowcastOutline,
        fill: false,
        interactive: false,
      };
      const shape = close ? L.polygon : L.polyline;
      shape(latLngs, { ...shared, color: HALO, weight: weight + 4, opacity: opacity * 0.8, dashArray: dash })
        .addTo(layers);
      return shape(latLngs, { ...shared, color: edge, weight, opacity, dashArray: dash, interactive: true });
    };

    // Furthest projection first so nearer ones draw on top.
    const projections = [...cluster.nowcastPolygons].sort((a, b) => b.timeMinutes - a.timeMinutes);
    for (const forecast of projections) {
      const latLngs = forecast.polygon.map(([lon, lat]) => [lat, lon]);
      const decay = 1 - forecast.timeMinutes / 120;

      L.polygon(latLngs, {
        pane: 'nowcastFillPane',
        renderer: renderers.nowcastFill,
        stroke: false,
        fillColor: edge,
        fillOpacity: 0.1 * decay,
        interactive: false,
      }).addTo(layers);

      stroke(latLngs, {
        weight: strongAlert ? 3.5 : 2.5,
        dash: '6, 6',
        opacity: Math.max(0.65, baseOpacity * decay),
        close: true,
      })
        .bindPopup(popupHtml(cluster, forecast, impact), { className: 'wx-popup-shell', closeButton: false })
        .addTo(layers);

      // A leader from the storm to where it is going, which is the one thing a
      // reader wants from a projection and the hardest to see in a pile of
      // overlapping outlines.
      const centre = forecast.polygon.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0])
        .map((v) => v / forecast.polygon.length);
      stroke([[cluster.baseLat, cluster.baseLon], [centre[1], centre[0]]], {
        weight: strongAlert ? 3 : 2,
        dash: null,
        opacity: 0.85 * decay,
        close: false,
      }).addTo(layers);
    }

    if (cluster.hullGeometry) {
      const ring = cluster.hullGeometry.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]);
      L.polygon(ring, {
        pane: 'nowcastFillPane',
        renderer: renderers.nowcastFill,
        stroke: false,
        fillColor: edge,
        fillOpacity: 0.2,
        interactive: false,
      }).addTo(layers);

      // The current footprint: solid and heaviest, since it is the one thing
      // here that is observed rather than projected.
      stroke(ring, { weight: strongAlert ? 6 : 4, dash: null, opacity: 0.95, close: true })
        .bindPopup(popupHtml(cluster, { timeMinutes: 0 }, impact), { className: 'wx-popup-shell', closeButton: false })
        .addTo(layers);
    }
  }

  // 3D mirrors these panes as a still, so it has to be told they changed.
  refreshOverlayMirror();
  lastDrawn = drawn;
  return drawn;
}

export function clearNowcast() {
  if (group) safeRemove(group);
  group = null;
  refreshOverlayMirror();
}
