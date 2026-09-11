/**
 * Lightning nowcasting: cluster recent strikes, fit a motion vector to each
 * cluster and project its footprint forward.
 *
 * The algorithm is carried over unchanged in behaviour — clustering parameters,
 * the RANSAC fit, the confidence weighting and the smoothing are all as tuned.
 * What changed is the packaging: the legacy file defined `ransacRegression`,
 * `randomSample`, `fitLinearModel` and `calculateDistance` *twice each* at top
 * level (see lines 16586/17276 and 17193/17631 of the original), so which copy ran
 * depended on source order. There is now one of each.
 *
 * Results are memoised on the inputs, because the draw path used to re-run the
 * whole calculation on every scrubber movement even when nothing had changed.
 */

import { haversineKm } from '../core/util.js';
import { runtime } from '../core/state.js';
import { emit, EVENTS } from '../core/bus.js';
import { measureMotion, resetRadarMotion } from './radarMotion.js';

/* ------------------------------------------------------------------ *
 * Performance envelope
 * ------------------------------------------------------------------ */

export const PROFILES = {
  low: { maxInput: 260, maxClusters: 4, ransacMax: 24, steps: [60] },
  high: { maxInput: 700, maxClusters: 8, ransacMax: 60, steps: [30, 60] },
};

export const profile = () => (runtime.lowEnd ? PROFILES.low : PROFILES.high);

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

const KM_PER_DEG_LAT = 111;

function bearingDeg(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Circular standard deviation of a set of bearings, in degrees. */
function circularStdDev(bearings) {
  if (bearings.length < 2) return 90;
  let sumSin = 0;
  let sumCos = 0;
  for (const b of bearings) {
    const r = b * Math.PI / 180;
    sumSin += Math.sin(r);
    sumCos += Math.cos(r);
  }
  const R = Math.sqrt(sumSin ** 2 + sumCos ** 2) / bearings.length;
  if (R >= 1) return 0;
  return Math.min(90, Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI);
}

function translatePolygon(coords, bearing, distanceKm) {
  const rad = bearing * Math.PI / 180;
  const dLat = (distanceKm * Math.cos(rad)) / KM_PER_DEG_LAT;
  return coords.map(([lon, lat]) => {
    const dLon = (distanceKm * Math.sin(rad)) / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    return [lon + dLon, lat + dLat];
  });
}

function polygonCentroid(coords) {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of coords) { lon += x; lat += y; }
  return [lon / coords.length, lat / coords.length];
}

function scalePolygon(coords, factor, [cx, cy]) {
  return coords.map(([lon, lat]) => [cx + (lon - cx) * factor, cy + (lat - cy) * factor]);
}

/* ------------------------------------------------------------------ *
 * Spatial index
 * ------------------------------------------------------------------ */

/**
 * Uniform lat/lon grid so neighbour lookups scan a 3x3 block instead of the whole
 * dataset. `cellSizeKm` must be at least the largest query radius.
 */
function buildSpatialGrid(strikes, cellSizeKm) {
  const grid = new Map();
  const latDeg = cellSizeKm / KM_PER_DEG_LAT;

  const cellFor = (lat, lon) => {
    const lonDeg = cellSizeKm / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    return { row: Math.floor(lat / latDeg), col: Math.floor(lon / lonDeg) };
  };

  strikes.forEach((s, index) => {
    const { row, col } = cellFor(s.lat, s.lon);
    const key = `${row}_${col}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });

  return {
    queryNearby(lat, lon) {
      const { row, col } = cellFor(lat, lon);
      const out = [];
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const bucket = grid.get(`${row + dr}_${col + dc}`);
          if (bucket) out.push(...bucket);
        }
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Clustering
 * ------------------------------------------------------------------ */

/** Density-aware flood fill in space and time. */
function clusterStrikes(strikes, { minClusterSize, maxDistance, maxTemporalSeparation }) {
  const clusters = [];
  const used = new Set();
  const index = buildSpatialGrid(strikes, Math.max(maxDistance, 40));
  const densityWindowMs = 15 * 60 * 1000;
  const densityDistanceKm = 20;

  for (let i = 0; i < strikes.length; i += 1) {
    if (used.has(i)) continue;
    used.add(i);
    const queue = [i];
    const cluster = [];

    while (queue.length) {
      const current = queue.pop();
      const strike = strikes[current];
      cluster.push(strike);

      const nearby = index.queryNearby(strike.lat, strike.lon);

      // Dense areas get a tighter join radius so separate cells do not merge.
      let localDensity = 0;
      for (const j of nearby) {
        const other = strikes[j];
        if (strike.ms - other.ms <= densityWindowMs &&
            haversineKm(strike.lat, strike.lon, other.lat, other.lon) <= densityDistanceKm) {
          localDensity += 1;
        }
      }
      const dynamicMaxDistance = maxDistance * Math.max(0.5, 1 - (localDensity / 50) * 0.5);

      for (const j of nearby) {
        if (used.has(j)) continue;
        const neighbour = strikes[j];
        if (haversineKm(strike.lat, strike.lon, neighbour.lat, neighbour.lon) <= dynamicMaxDistance &&
            Math.abs(strike.ms - neighbour.ms) <= maxTemporalSeparation) {
          used.add(j);
          queue.push(j);
        }
      }
    }

    if (cluster.length >= minClusterSize) clusters.push(cluster);
  }
  return clusters;
}

/* ------------------------------------------------------------------ *
 * Motion fitting
 * ------------------------------------------------------------------ */

function randomSample(array, n) {
  const pool = array.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

/** Age-weighted least squares fit of lat/lon against time. */
function fitLinearModel(bins, decayConstant) {
  const empty = { slopeLat: 0, slopeLon: 0, interceptLat: 0, interceptLon: 0, r2: 0, residualKm: 100 };
  if (!bins.length) return empty;

  const baseTime = bins[0].time;
  let maxTime = -Infinity;
  let minTime = Infinity;
  for (const b of bins) {
    if (b.time > maxTime) maxTime = b.time;
    if (b.time < minTime) minTime = b.time;
  }
  const span = maxTime - minTime;

  const weightOf = (b) => {
    const ageRatio = span > 0 ? (maxTime - b.time) / span : 0;
    return (1 - ageRatio * decayConstant) * Math.log1p(b.count || 1);
  };

  let sumT = 0, sumLat = 0, sumLon = 0, sumTLat = 0, sumTLon = 0, sumT2 = 0, sumW = 0;
  for (const b of bins) {
    const t = (b.time - baseTime) / 1000;
    const w = weightOf(b);
    sumT += t * w; sumLat += b.lat * w; sumLon += b.lon * w;
    sumTLat += t * b.lat * w; sumTLon += t * b.lon * w;
    sumT2 += t * t * w; sumW += w;
  }
  if (sumW === 0) return empty;

  const denominator = sumT2 * sumW - sumT * sumT;
  const slopeLat = denominator !== 0 ? (sumTLat * sumW - sumT * sumLat) / denominator : 0;
  const slopeLon = denominator !== 0 ? (sumTLon * sumW - sumT * sumLon) / denominator : 0;
  const interceptLat = (sumLat - slopeLat * sumT) / sumW;
  const interceptLon = (sumLon - slopeLon * sumT) / sumW;

  const meanLat = sumLat / sumW;
  const meanLon = sumLon / sumW;
  let ssTotLat = 0, ssResLat = 0, ssTotLon = 0, ssResLon = 0, residualSum = 0;

  for (const b of bins) {
    const t = (b.time - baseTime) / 1000;
    const w = weightOf(b);
    const predLat = interceptLat + slopeLat * t;
    const predLon = interceptLon + slopeLon * t;
    ssTotLat += w * (b.lat - meanLat) ** 2;
    ssTotLon += w * (b.lon - meanLon) ** 2;
    ssResLat += w * (b.lat - predLat) ** 2;
    ssResLon += w * (b.lon - predLon) ** 2;
    residualSum += haversineKm(b.lat, b.lon, predLat, predLon) * w;
  }

  const r2 = ((ssTotLat > 0 ? 1 - ssResLat / ssTotLat : 0) + (ssTotLon > 0 ? 1 - ssResLon / ssTotLon : 0)) / 2;
  return { slopeLat, slopeLon, interceptLat, interceptLon, r2, residualKm: residualSum / sumW };
}

/** RANSAC wrapper: resists a few stray cells dragging the vector off. */
function ransacRegression(bins, iterations, threshold, decayConstant) {
  let best = { slopeLat: 0, slopeLon: 0, interceptLat: 0, interceptLon: 0, r2: 0, residualKm: 100 };
  let mostInliers = 0;

  for (let i = 0; i < iterations; i += 1) {
    const sample = randomSample(bins, 2);
    if (sample.length < 2) continue;
    const model = fitLinearModel(sample, decayConstant);
    const inliers = bins.filter((b) => {
      const t = (b.time - sample[0].time) / 1000;
      return Math.abs(b.lat - (model.interceptLat + model.slopeLat * t)) < threshold &&
        Math.abs(b.lon - (model.interceptLon + model.slopeLon * t)) < threshold;
    });
    if (inliers.length > mostInliers) {
      mostInliers = inliers.length;
      best = fitLinearModel(inliers.length >= 2 ? inliers : sample, decayConstant);
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Main calculation
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * Radar advection
 * ------------------------------------------------------------------ */

/**
 * Motion measured from the radar field, cached by area.
 *
 * The nowcast has to stay synchronous — it runs on the draw path — so radar is
 * consulted from a cache and refreshed behind it. A cluster with no hint yet
 * behaves exactly as it did before radar was involved, and improves on the next
 * refresh. That is also what keeps the whole thing optional: no radar frames, no
 * hint, no change.
 *
 * Keyed on a quarter-degree cell, which is about 25 km. Storms inside one cell
 * are steered by the same flow, so sharing a measurement between them is not an
 * approximation worth avoiding — and it means a squall line of six clusters
 * costs one pair of radar windows rather than six.
 */
const hints = new Map();
const pending = new Set();

/** How long a measurement is trusted before it is taken again. */
const HINT_TTL_MS = 8 * 60 * 1000;

const hintKey = (lat, lon) => `${Math.round(lat * 4)}|${Math.round(lon * 4)}`;

/** The cached measurement for a position, if it is still fresh. */
function radarHintFor(lat, lon, referenceMs) {
  const hint = hints.get(hintKey(lat, lon));
  if (!hint) return null;
  return Math.abs(referenceMs - hint.at) <= HINT_TTL_MS ? hint : null;
}

/**
 * Measures anything missing, in the background.
 *
 * The result is not returned: it lands in the cache and the listener is told, so
 * whoever is drawing can ask again. Failures are cached as a null measurement so
 * a region out of radar coverage is not retried on every pass.
 */
function refreshRadarHints(positions, referenceMs) {
  for (const [lat, lon] of positions) {
    const key = hintKey(lat, lon);
    if (pending.has(key)) continue;
    const existing = hints.get(key);
    if (existing && Math.abs(referenceMs - existing.at) <= HINT_TTL_MS) continue;

    pending.add(key);
    measureMotion(lat, lon, referenceMs)
      .then((measured) => {
        hints.set(key, measured ? { ...measured, at: referenceMs } : { at: referenceMs, quality: 0 });
        if (measured) {
          // The memo is keyed on the strikes and the minute, neither of which
          // changed; without this the next call would hand back the answer that
          // was computed before the radar arrived.
          memoKey = '';
          emit(EVENTS.LIGHTNING_FILTERED, { reason: 'radar-motion' });
        }
      })
      .catch(() => { hints.set(key, { at: referenceMs, quality: 0 }); })
      .finally(() => pending.delete(key));
  }
}

/** Angular difference between two bearings, 0 to 180. */
function bearingGap(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return 180 - d;
}

/** Forgets every measurement. For tests, and when the view changes wholesale. */
export function resetRadarHints() {
  hints.clear();
  pending.clear();
  resetRadarMotion();
}

/** What the nowcast knows from radar right now. For diagnostics and checks. */
export const radarHints = () => [...hints.entries()].map(([key, value]) => ({ key, ...value }));

const MAX_SPEED_KMH = 80;
let previousNowcasts = [];

let memoKey = '';
let memoResult = [];

/**
 * Produces the cluster projections for a filtered strike set.
 * @param {Array} strikes  filtered strikes, ascending by time
 * @param {Date}  reference the "now" the projection is made from
 */
export function calculateNowcast(strikes, reference = new Date()) {
  if (!strikes?.length) return [];

  const p = profile();
  const key = [
    strikes.length,
    strikes[0].ms,
    strikes[strikes.length - 1].ms,
    Math.floor(reference.getTime() / 60000),
    p.maxInput, p.maxClusters, p.ransacMax, p.steps.join('-'),
  ].join('|');
  if (key === memoKey) return memoResult;

  const referenceMs = reference.getTime();

  // Density drives the clustering window: busy days want tighter, more precise
  // clusters; quiet days want a longer memory so a slow cell is not dropped.
  let recent = strikes.filter((s) => referenceMs - s.ms <= 7 * 3600 * 1000);
  const rawCount = recent.length;
  if (recent.length > p.maxInput) recent = recent.slice(-p.maxInput);

  const densityRatio = Math.min(1, rawCount / 2000);
  const baseMaxHours = 6 - 2 * densityRatio;

  let timePenalty = 1;
  if (densityRatio < 0.4) timePenalty = 0.6 + 0.4 * (densityRatio / 0.4) ** 1.5;
  const recentStrikes = recent.filter((s) => referenceMs - s.ms <= 3 * 3600 * 1000);
  if (recentStrikes.length / 3 > 8) timePenalty = Math.max(timePenalty, 0.85);

  const maxTimeRange = baseMaxHours * 3600 * 1000 * timePenalty;
  const maxDistance = Math.max(15, Math.min(40, 35 - 15 * (1 - densityRatio)));
  const minClusterSize = Math.max(4, Math.floor(5 + 4 * densityRatio));
  const maxInactivityMs = Math.max(10 * 60 * 1000, 25 * 60 * 1000 * (1 - densityRatio * 0.4));
  const maxTemporalSeparation = Math.max(10 * 60 * 1000, 30 * 60 * 1000 * (1 - densityRatio * 0.6));
  const ransacIterations = Math.min(p.ransacMax, 25 + Math.floor(rawCount / 18));
  const decayConstant = 0.5 + 0.1 * densityRatio;
  const binSize = 5 * 60 * 1000;
  const jumpWindow = 10 * 60 * 1000;

  let input = recent.filter((s) => referenceMs - s.ms <= maxTimeRange);
  if (input.length > p.maxInput) input = input.slice(-p.maxInput);

  const clusters = clusterStrikes(input, { minClusterSize, maxDistance, maxTemporalSeparation })
    .sort((a, b) => b.length - a.length)
    .slice(0, p.maxClusters);

  const raw = [];
  const MIN_BINS_FOR_CONFIDENCE = 5;

  for (const cluster of clusters) {
    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const s of cluster) {
      if (s.ms < minTime) minTime = s.ms;
      if (s.ms > maxTime) maxTime = s.ms;
    }
    const sinceLast = referenceMs - maxTime;
    if (sinceLast > maxInactivityMs) continue;

    // Age-weighted centroid per time bin — the track the fit runs against.
    const bins = [];
    for (let t = minTime; t < maxTime; t += binSize) {
      let sumLat = 0, sumLon = 0, sumW = 0, count = 0;
      for (const s of cluster) {
        if (s.ms < t || s.ms >= t + binSize) continue;
        const ageRatio = maxTime > minTime ? (maxTime - s.ms) / (maxTime - minTime) : 0;
        const w = 1 - ageRatio * decayConstant;
        sumLat += s.lat * w; sumLon += s.lon * w; sumW += w; count += 1;
      }
      if (count) bins.push({ time: t + binSize / 2, lat: sumLat / sumW, lon: sumLon / sumW, count });
    }
    if (!bins.length) continue;

    const spanHours = (maxTime - minTime) / 3600000;
    const threshold = Math.max(0.03, Math.min(0.1, 0.05 + spanHours * 0.02));

    let speedKmH = 0;
    let directionDeg = 0;
    let regressionScore = 0.1;
    let residualKm = 100;

    if (bins.length >= 2) {
      const model = ransacRegression(bins, ransacIterations, threshold, decayConstant);
      regressionScore = model.r2;
      residualKm = model.residualKm;
      const latFactor = Math.cos(bins[0].lat * Math.PI / 180);
      const vLat = model.slopeLat * 111 * 3600;
      const vLon = model.slopeLon * 111 * latFactor * 3600;
      speedKmH = Math.min(Math.hypot(vLat, vLon), MAX_SPEED_KMH);
      directionDeg = (Math.atan2(vLon, vLat) * 180 / Math.PI + 360) % 360;
    }

    const bearings = [];
    for (let i = 1; i < bins.length; i += 1) {
      bearings.push(bearingDeg(bins[i - 1].lon, bins[i - 1].lat, bins[i].lon, bins[i].lat));
    }
    const consistency = 1 - circularStdDev(bearings) / 90;

    const baseLat = bins[bins.length - 1].lat;
    const baseLon = bins[bins.length - 1].lon;

    /* ---- radar ---- */
    const radar = radarHintFor(baseLat, baseLon, referenceMs);
    const lightningSpeed = speedKmH;
    const lightningDirection = directionDeg;

    // How much the lightning-only fit deserves to be believed. A cluster with
    // one bin has no fit at all, which is the case radar helps most.
    const lightningQuality = bins.length < 2
      ? 0
      : Math.max(0, Math.min(1, regressionScore * 0.5 + consistency * 0.5)) * Math.min(1, bins.length / 4);

    let radarAgreement = 0;
    if (radar && radar.quality > 0) {
      // Blended as vectors, weighted by how much each estimate has earned. Two
      // bearings cannot be averaged arithmetically — north-by-one-degree and
      // north-by-minus-one average to south — and the speeds want combining too.
      const weight = radar.quality / (radar.quality + lightningQuality + 1e-6);
      const toRad = Math.PI / 180;
      const u = lightningSpeed * Math.sin(lightningDirection * toRad) * (1 - weight)
        + radar.speedKmH * Math.sin(radar.directionDeg * toRad) * weight;
      const v = lightningSpeed * Math.cos(lightningDirection * toRad) * (1 - weight)
        + radar.speedKmH * Math.cos(radar.directionDeg * toRad) * weight;
      speedKmH = Math.min(Math.hypot(u, v), MAX_SPEED_KMH);
      directionDeg = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

      // Two independent measurements agreeing is worth more than either alone.
      if (lightningQuality > 0.15 && lightningSpeed > 5) {
        radarAgreement = Math.max(0, Math.cos(bearingGap(lightningDirection, radar.directionDeg) * toRad));
      }
    }

    // A "lightning jump" — a sudden rate increase — usually precedes intensification.
    const cutoff = referenceMs - jumpWindow;
    const latest = cluster.filter((s) => s.ms >= cutoff).length;
    const middle = cluster.filter((s) => s.ms < cutoff && s.ms >= cutoff - jumpWindow).length;
    const jump = latest > 2.5 * middle && latest >= 6;

    // Whether the convective area is growing is a thing radar measures directly.
    // The flash-rate jump stays as the fallback, and as corroboration.
    const growing = radar && radar.trend !== undefined
      ? radar.trend > 1.15 || (jump && radar.trend > 0.95)
      : jump;
    const shrinking = radar && radar.trend !== undefined ? radar.trend < 0.85 : null;

    const decayFactor = (1 - Math.min(sinceLast / maxInactivityMs, 1)) ** 2;
    const sizeScore = Math.min(cluster.length / 50, 1);
    const binMultiplier = Math.min(1, (bins.length / MIN_BINS_FOR_CONFIDENCE) * (1 + 0.1 * sizeScore));

    let confidence = sizeScore * 0.15 +
      (speedKmH / MAX_SPEED_KMH) * 0.05 +
      regressionScore * 0.30 +
      consistency * 0.35 +
      (bins.length / MIN_BINS_FOR_CONFIDENCE) * 0.10;
    confidence *= decayFactor * binMultiplier;
    confidence = Math.min(1, confidence + (jump ? 0.35 : 0));
    // A measured motion is evidence in its own right, and one that agrees with
    // the lightning track is better evidence than either on its own.
    if (radar && radar.quality > 0) {
      confidence = Math.min(1, confidence + radar.quality * 0.15 + radarAgreement * radar.quality * 0.15);
    }

    raw.push({
      cluster,
      baseLat,
      baseLon,
      speedKmH, directionDeg, regressionScore, consistency, residualKm,
      confidence, clusterSize: cluster.length,
      jump, growing,
      decaying: shrinking === null ? decayFactor < 0.5 : shrinking || decayFactor < 0.5,
      radar,
    });
  }

  // Anything without a fresh measurement is queued now, so the next pass has it.
  refreshRadarHints(raw.map((entry) => [entry.baseLat, entry.baseLon]), referenceMs);

  const result = raw
    .map((entry) => smoothAndProject(entry, referenceMs, minClusterSize, p.steps))
    .filter(Boolean);

  previousNowcasts = result;
  memoKey = key;
  memoResult = result;
  return result;
}

/**
 * Blends each vector with the nearest previous one so cones do not jitter between
 * refreshes, then projects the footprint forward.
 */
function smoothAndProject(entry, referenceMs, minClusterSize, steps) {
  let speedKmH = entry.speedKmH;
  let directionDeg = entry.cluster.length < minClusterSize ? 0 : entry.directionDeg;

  const MAX_SMOOTHING_KM = 50;
  if (previousNowcasts.length) {
    let nearest = null;
    let nearestKm = Infinity;
    for (const prev of previousNowcasts) {
      const d = haversineKm(entry.baseLat, entry.baseLon, prev.baseLat, prev.baseLon);
      if (d < nearestKm) { nearestKm = d; nearest = prev; }
    }
    if (nearest && nearestKm <= MAX_SMOOTHING_KM) {
      // A well-behaved track needs less smoothing than an erratic one.
      const dynamic = 0.8 - entry.consistency * 0.6;
      const weight = dynamic * nearest.confidence * (1 - nearestKm / MAX_SMOOTHING_KM);
      const inverse = 1 - weight;
      const toRad = Math.PI / 180;
      const u = speedKmH * Math.sin(directionDeg * toRad) * inverse + nearest.speedKmH * Math.sin(nearest.directionDeg * toRad) * weight;
      const v = speedKmH * Math.cos(directionDeg * toRad) * inverse + nearest.speedKmH * Math.cos(nearest.directionDeg * toRad) * weight;
      speedKmH = Math.min(Math.hypot(u, v), MAX_SPEED_KMH);
      directionDeg = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
    }
  }

  // Current footprint: the convex hull of the last 30 minutes of strikes.
  let hull = null;
  if (typeof turf !== 'undefined' && entry.cluster.length >= 3) {
    const sorted = [...entry.cluster].sort((a, b) => a.ms - b.ms);
    let recent = sorted.filter((s) => referenceMs - s.ms <= 30 * 60 * 1000);
    if (recent.length < 3) recent = sorted.slice(-3);
    if (recent.length >= 3) {
      try {
        hull = turf.convex(turf.featureCollection(recent.map((s) => turf.point([s.lon, s.lat]))));
      } catch {
        hull = null; // collinear points — turf returns null, which is handled below
      }
    }
  }

  const polygons = [];
  const ring = hull?.geometry?.coordinates?.[0];
  if (ring) {
    for (const minutes of steps) {
      const moved = translatePolygon(ring, directionDeg, speedKmH * (minutes / 60));
      // Growing storms expand, decaying ones shrink.
      let scale = 1;
      // Scaled by how fast the area is actually changing where radar says so,
      // rather than by a fixed tenth for every growing storm.
      const rate = entry.radar?.trend !== undefined
        ? Math.max(-0.25, Math.min(0.25, (entry.radar.trend - 1) * 0.35))
        : null;
      if (rate !== null) scale = 1 + rate * (minutes / 15);
      else if (entry.jump) scale = 1 + 0.1 * (minutes / 15);
      else if (entry.decaying) scale = 1 - 0.15 * (minutes / 15);
      polygons.push({
        timeMinutes: minutes,
        polygon: scalePolygon(moved, Math.max(0.1, scale), polygonCentroid(moved)),
      });
    }
  }

  if (entry.confidence <= 0.1) return null;

  const errorDeg = (1 - entry.consistency) * 90;
  const distanceKm = speedKmH;
  return {
    baseLat: entry.baseLat,
    baseLon: entry.baseLon,
    speedKmH,
    directionDeg,
    confidence: entry.confidence,
    clusterSize: entry.clusterSize,
    motionSource: entry.radar?.quality > 0 ? 'radar+lightning' : 'lightning',
    radarTrend: entry.radar?.trend ?? null,
    hullGeometry: hull,
    nowcastPolygons: polygons,
    uncertainty: {
      semiMinorKm: Math.min(75, Math.max(10, distanceKm * Math.sin(errorDeg * Math.PI / 180) * 0.7)),
      semiMajorKm: Math.min(150, Math.max(20, distanceKm + entry.residualKm * 3)),
      rotationDeg: directionDeg,
    },
  };
}

export function resetNowcastHistory() {
  previousNowcasts = [];
  memoKey = '';
  memoResult = [];
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassPoint = (deg) => COMPASS[Math.round(((deg % 360) / 22.5)) % 16];

/** Five-level impact rating from cluster intensity and trajectory confidence. */
export function impactLevel(clusterSize, confidence) {
  const score = Math.min(1, clusterSize / 120) * 0.6 + confidence * 0.4;
  if (score >= 0.78) return { level: 5, label: 'Level 5 — Severe', colour: '#8a2be2' };
  if (score >= 0.6) return { level: 4, label: 'Level 4 — High', colour: '#c026d3' };
  if (score >= 0.42) return { level: 3, label: 'Level 3 — Elevated', colour: '#f43f5e' };
  if (score >= 0.25) return { level: 2, label: 'Level 2 — Moderate', colour: '#f97316' };
  return { level: 1, label: 'Level 1 — Low', colour: '#eab308' };
}

export function confidenceColour(confidence) {
  // Amber (low) through red to violet (high).
  const stops = [[0, [234, 179, 8]], [0.5, [244, 63, 94]], [1, [138, 43, 226]]];
  for (let i = 1; i < stops.length; i += 1) {
    if (confidence <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const t = (confidence - t0) / (t1 - t0 || 1);
      const mix = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return `rgb(${mix.join(',')})`;
    }
  }
  return 'rgb(138,43,226)';
}
