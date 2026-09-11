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
import { measureMotion, resetRadarMotion, SEPARATION_MIN } from './radarMotion.js';

/* ------------------------------------------------------------------ *
 * Performance envelope
 * ------------------------------------------------------------------ */

/**
 * Work allowed per run.
 *
 * `maxInput` was 700 when it was a truncation, where a bigger number only bought
 * a longer tail of the same minute. Now that it is a stride across the window it
 * decides how finely the field is sampled, and the clustering is linear in it
 * against a spatial grid, so it can afford to be an order larger.
 */
export const PROFILES = {
  low: { maxInput: 1200, maxClusters: 6, ransacMax: 24, steps: [60] },
  high: { maxInput: 6000, maxClusters: 12, ransacMax: 60, steps: [30, 60] },
};

export const profile = () => (runtime.lowEnd ? PROFILES.low : PROFILES.high);

/**
 * Reduces a strike set to a budget without shortening it.
 *
 * The budget used to be applied by taking the most recent N, which is the single
 * worst thing that could be done to a nowcast. On a busy day — 42,000 strikes in
 * an hour is an ordinary June afternoon here — the most recent 700 strikes span
 * about one minute. Every cluster was therefore a one-minute snapshot: one time
 * bin, nothing to fit a velocity to, and so a heading of zero and a speed of zero
 * on every cell. It also meant cells were never followed, because there was no
 * track to follow.
 *
 * Sampling at a stride keeps the whole window instead. A cell loses some of its
 * flashes and keeps all of its history, which is the right way round: the
 * clustering needs enough points to find a cell, and the fit needs time.
 */
export function thinAcrossTime(strikes, budget) {
  if (strikes.length <= budget) return strikes;
  const stride = strikes.length / budget;
  const out = [];
  for (let i = 0; i < strikes.length; i += stride) out.push(strikes[Math.floor(i)]);
  return out;
}

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


/**
 * Convex hull of a set of strikes, as a closed ring of [lon, lat].
 *
 * Andrew's monotone chain. This used to call turf, which is loaded on demand and
 * only when the nowcast checkbox is ticked — so anything that switched the
 * nowcast on another way, or any run where that fetch failed, produced clusters
 * with no footprint and drew nothing at all, silently. A convex hull is not worth
 * a network dependency and a failure mode.
 *
 * Degenerate input — fewer than three points, or all of them collinear — has no
 * hull, and returns null rather than a sliver.
 */
export function convexHull(points) {
  if (points.length < 3) return null;
  const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  // Cross product of OA and OB. Positive means a left turn.
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const half = (input) => {
    const out = [];
    for (const point of input) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };

  const ring = [...half(sorted), ...half([...sorted].reverse())];
  if (ring.length < 3) return null;
  return [...ring, ring[0]];
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

/** How much further apart than they are wide two halves must be to be two cells. */
/** How much of a cell's recent history the drawn footprint covers. */
const HULL_WINDOW_MS = 20 * 60 * 1000;

const SPLIT_RATIO = 1.7;

/** And at least this far apart, so two blobs of noise are not called cells. */
const SPLIT_MIN_KM = 15;

/**
 * Splits a cluster that is really two, and says so recursively.
 *
 * The core-point rule stops a handful of stray flashes chaining two cells
 * together, but it cannot stop a bridge that is itself dense enough to be core —
 * and four flashes strung between two storms is enough. Connected components are
 * the wrong shape of question for that: two cells joined by a thread are one
 * component however obviously they are two storms.
 *
 * So the components are tested afterwards for being two things. Two-means on the
 * storm-relative positions gives the best split available; whether to take it is
 * decided by comparing how far apart the two halves are against how spread out
 * each half is on its own. A single cell is one blob, and the best split of one
 * blob separates centres by about as much as the blob's own width. Two cells
 * separate them by much more. The ratio is what distinguishes them, and it does
 * not need to know how big a storm is in kilometres.
 *
 * @param {Array} members    strikes in the cluster
 * @param {Function} at      strike to its storm-relative position
 * @param {number} minSize   smallest half worth calling a cell
 * @param {number} depth     guard against splitting for ever
 */
function splitIfTwoCells(members, at, minSize, depth = 0) {
  if (depth >= 3 || members.length < minSize * 2) return [members];

  const points = members.map(at);

  // Seed on the two furthest-apart points, which is the split worth testing.
  let seedA = 0;
  let seedB = 0;
  let furthest = -1;
  const step = Math.max(1, Math.floor(points.length / 40));
  for (let i = 0; i < points.length; i += step) {
    for (let j = i + step; j < points.length; j += step) {
      const d = haversineKm(points[i][0], points[i][1], points[j][0], points[j][1]);
      if (d > furthest) { furthest = d; seedA = i; seedB = j; }
    }
  }
  if (furthest <= 0) return [members];

  let centreA = points[seedA];
  let centreB = points[seedB];
  let groupA = [];
  let groupB = [];

  for (let pass = 0; pass < 8; pass += 1) {
    groupA = [];
    groupB = [];
    for (let i = 0; i < points.length; i += 1) {
      const dA = haversineKm(points[i][0], points[i][1], centreA[0], centreA[1]);
      const dB = haversineKm(points[i][0], points[i][1], centreB[0], centreB[1]);
      (dA <= dB ? groupA : groupB).push(i);
    }
    if (!groupA.length || !groupB.length) return [members];
    const mean = (group) => {
      let lat = 0;
      let lon = 0;
      for (const i of group) { lat += points[i][0]; lon += points[i][1]; }
      return [lat / group.length, lon / group.length];
    };
    const nextA = mean(groupA);
    const nextB = mean(groupB);
    const settled = haversineKm(nextA[0], nextA[1], centreA[0], centreA[1]) < 0.2
      && haversineKm(nextB[0], nextB[1], centreB[0], centreB[1]) < 0.2;
    centreA = nextA;
    centreB = nextB;
    if (settled) break;
  }

  if (groupA.length < minSize || groupB.length < minSize) return [members];

  const spread = (group, centre) => {
    let total = 0;
    for (const i of group) total += haversineKm(points[i][0], points[i][1], centre[0], centre[1]);
    return total / group.length;
  };
  const separation = haversineKm(centreA[0], centreA[1], centreB[0], centreB[1]);
  const width = (spread(groupA, centreA) + spread(groupB, centreB)) / 2;

  // Below this the split is just cutting one blob in half.
  if (!(separation > Math.max(SPLIT_MIN_KM, width * SPLIT_RATIO))) return [members];

  const pick = (group) => group.map((i) => members[i]);
  return [
    ...splitIfTwoCells(pick(groupA), at, minSize, depth + 1),
    ...splitIfTwoCells(pick(groupB), at, minSize, depth + 1),
  ];
}

/**
 * Separates strikes into storm cells.
 *
 * Two things decide whether distinct cells stay distinct.
 *
 * **Only dense points may recruit.** The old flood fill was single-linkage: a
 * strike joined if it was within range of *any* strike already in the cluster,
 * and that strike could then recruit further. Two cells thirty kilometres apart
 * with a handful of flashes between them therefore merged into one, which is the
 * chaining failure single-linkage is known for. Here a strike only extends a
 * cluster if it has neighbours of its own — DBSCAN's core-point rule. Sparse
 * strikes still join the cluster they touch, they just cannot pass the join on,
 * so a thin bridge between two cells no longer welds them together.
 *
 * **Distance is measured in the storm's frame, not the ground's.** A cell moving
 * at 50 km/h covers 25 km in half an hour, so its own strikes spread across more
 * ground than the gap to its neighbour — no fixed radius can separate those two
 * situations. Given a motion estimate, every strike is first carried forward to
 * the reference time as if it moved with the storm, which collapses one cell's
 * half-hour of flashes onto roughly one spot while leaving two genuinely separate
 * cells as far apart as they always were. The join radius can then be tight.
 * Without an estimate this is the identity and the behaviour is as before.
 *
 * @param {Array} strikes
 * @param {object} options
 * @param {(lat:number, lon:number, ms:number) => [number, number]} [options.advect]
 */
function clusterStrikes(strikes, {
  minClusterSize, maxDistance, maxTemporalSeparation, advect = null, minNeighbours = 3,
}) {
  if (!strikes.length) return [];

  // Positions in the storm-relative frame, computed once.
  const lat = new Float64Array(strikes.length);
  const lon = new Float64Array(strikes.length);
  for (let i = 0; i < strikes.length; i += 1) {
    if (advect) {
      const [la, lo] = advect(strikes[i].lat, strikes[i].lon, strikes[i].ms);
      lat[i] = la;
      lon[i] = lo;
    } else {
      lat[i] = strikes[i].lat;
      lon[i] = strikes[i].lon;
    }
  }

  const index = buildSpatialGrid(
    Array.from(strikes, (s, i) => ({ lat: lat[i], lon: lon[i] })),
    Math.max(maxDistance, 40),
  );

  /** Indices within reach of `i`, in space and in time. */
  const neighboursOf = (i) => {
    const out = [];
    for (const j of index.queryNearby(lat[i], lon[i])) {
      if (j === i) continue;
      if (Math.abs(strikes[i].ms - strikes[j].ms) > maxTemporalSeparation) continue;
      if (haversineKm(lat[i], lon[i], lat[j], lon[j]) > maxDistance) continue;
      out.push(j);
    }
    return out;
  };

  // Density is a property of a strike, so it is settled before any recruiting
  // starts. Deciding it mid-expansion made membership depend on visit order.
  const dense = new Uint8Array(strikes.length);
  const cached = new Array(strikes.length);
  for (let i = 0; i < strikes.length; i += 1) {
    cached[i] = neighboursOf(i);
    dense[i] = cached[i].length >= minNeighbours ? 1 : 0;
  }

  const clusters = [];
  const assigned = new Int32Array(strikes.length).fill(-1);
  const positionOf = new Map();
  for (let i = 0; i < strikes.length; i += 1) positionOf.set(strikes[i], i);

  for (let i = 0; i < strikes.length; i += 1) {
    if (assigned[i] !== -1 || !dense[i]) continue;
    const id = clusters.length;
    const members = [];
    const queue = [i];
    assigned[i] = id;

    while (queue.length) {
      const current = queue.pop();
      members.push(strikes[current]);
      // A sparse strike is carried along but does not recruit: that is the whole
      // difference between this and the chaining it replaces.
      if (!dense[current]) continue;
      for (const j of cached[current]) {
        if (assigned[j] !== -1) continue;
        assigned[j] = id;
        queue.push(j);
      }
    }

    if (members.length < minClusterSize) continue;
    // A component can still be two storms joined by a thread; this is where that
    // is caught.
    const at = (strike) => {
      const i = positionOf.get(strike);
      return i === undefined ? [strike.lat, strike.lon] : [lat[i], lon[i]];
    };
    for (const part of splitIfTwoCells(members, at, minClusterSize)) {
      if (part.length >= minClusterSize) clusters.push(part);
    }
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



/**
 * Time-binned centroids for a cluster, and the motion fitted through them.
 *
 * Pulled out of the main loop so the clustering can use it too. Separating cells
 * needs to know how fast they are travelling, and knowing that needs a fit, so
 * the first pass fits coarse clusters only to work out the flow, and the second
 * uses that flow to cluster properly.
 */
function fitCluster(cluster, { binSize, decayConstant, ransacIterations }) {
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const s of cluster) {
    if (s.ms < minTime) minTime = s.ms;
    if (s.ms > maxTime) maxTime = s.ms;
  }

  const bins = [];
  for (let t = minTime; t < maxTime; t += binSize) {
    let sumLat = 0;
    let sumLon = 0;
    let sumW = 0;
    let count = 0;
    for (const s of cluster) {
      if (s.ms < t || s.ms >= t + binSize) continue;
      const ageRatio = maxTime > minTime ? (maxTime - s.ms) / (maxTime - minTime) : 0;
      const w = 1 - ageRatio * decayConstant;
      sumLat += s.lat * w;
      sumLon += s.lon * w;
      sumW += w;
      count += 1;
    }
    if (count) bins.push({ time: t + binSize / 2, lat: sumLat / sumW, lon: sumLon / sumW, count });
  }

  const result = {
    bins, minTime, maxTime, speedKmH: 0, directionDeg: 0, regressionScore: 0.1, residualKm: 100,
  };
  if (bins.length < 2) return result;

  const spanHours = (maxTime - minTime) / 3600000;
  const threshold = Math.max(0.03, Math.min(0.1, 0.05 + spanHours * 0.02));
  const model = ransacRegression(bins, ransacIterations, threshold, decayConstant);
  const latFactor = Math.cos((bins[0].lat * Math.PI) / 180);
  const vLat = model.slopeLat * 111 * 3600;
  const vLon = model.slopeLon * 111 * latFactor * 3600;

  result.regressionScore = model.r2;
  result.residualKm = model.residualKm;
  result.speedKmH = Math.min(Math.hypot(vLat, vLon), MAX_SPEED_KMH);
  result.directionDeg = (Math.atan2(vLon, vLat) * 180) / Math.PI % 360;
  if (result.directionDeg < 0) result.directionDeg += 360;
  return result;
}

/**
 * The flow the whole field is travelling in, fitted from the lightning alone.
 *
 * A first clustering pass with no motion to work from produces blobs: a cell's
 * three-hour track spreads across more ground than the gap to its neighbours, so
 * neighbouring cells chain into one. Those blobs are useless as cells and
 * perfectly good for measuring the flow, which is all this asks of them. The
 * second pass uses the answer to put every strike in the storm's frame, where
 * cells actually separate.
 *
 * Weighted by cluster size and by how well each fit held, so one small erratic
 * cluster cannot steer the field.
 */
function steeringFromLightning(clusters, fitOptions) {
  let u = 0;
  let v = 0;
  let weight = 0;
  for (const cluster of clusters) {
    const fit = fitCluster(cluster, fitOptions);
    if (fit.bins.length < 3 || fit.speedKmH < 5) continue;
    const w = cluster.length * Math.max(0.1, fit.regressionScore);
    const rad = (fit.directionDeg * Math.PI) / 180;
    u += Math.sin(rad) * fit.speedKmH * w;
    v += Math.cos(rad) * fit.speedKmH * w;
    weight += w;
  }
  if (!weight) return null;
  u /= weight;
  v /= weight;
  const speedKmH = Math.hypot(u, v);
  if (speedKmH < 5) return null;
  return { speedKmH, directionDeg: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360, quality: 0.4 };
}

/* ------------------------------------------------------------------ *
 * How long a cell has left
 * ------------------------------------------------------------------ */

/** Flash rate below which a cell is no longer worth projecting, per minute. */
const SPENT_RATE = 0.5;

/** Bounds on the answer. Nothing useful is said outside them. */
const MIN_LIFE_MIN = 5;
const MAX_LIFE_MIN = 120;

/**
 * Minutes of useful life left in a cell.
 *
 * The old code had no estimate at all. It projected every cluster to the same
 * horizon and let an inactivity decay fade the confidence, which says a storm is
 * ending only once it has already stopped — too late to be a forecast.
 *
 * The rate of flashes is treated as changing exponentially, which is a fair
 * description of a convective cell over the half hour that matters here.
 * Measuring that rate of change over two windows gives a growth constant, and
 * the remaining life is the time for the rate to fall to nothing much. A growing
 * cell instead gets what is left of a typical lifetime for its age, because
 * extrapolating growth forward says a cell will last for ever.
 *
 * Radar's area trend is folded in where there is one: it is a direct measurement
 * of the same thing, and it moves before the flash rate does.
 *
 * @param {object} counts  flashes in the last window and the one before it
 * @param {number} windowMin  length of each window, in minutes
 * @param {number} ageMin  how long the cell has been producing strikes
 * @param {number} silentMin  minutes since its last strike
 * @param {number|null} radarTrend  ratio of convective area between radar frames
 */
export function remainingLifeMinutes({ latest, previous }, windowMin, ageMin, silentMin, radarTrend) {
  const rateNow = latest / windowMin;
  const ratePrev = previous / windowMin;

  // Growth constants, per minute. Both are logs of a ratio over a known span.
  const fromFlashes = rateNow > 0 && ratePrev > 0 ? Math.log(rateNow / ratePrev) / windowMin : null;
  const fromRadar = radarTrend > 0 ? Math.log(radarTrend) / SEPARATION_MIN : null;

  let k;
  if (fromFlashes !== null && fromRadar !== null) k = fromFlashes * 0.45 + fromRadar * 0.55;
  else k = fromFlashes ?? fromRadar ?? 0;

  // Already quiet: what is left is what is left of the silence allowance.
  if (rateNow <= 0) return Math.max(0, Math.round(MIN_LIFE_MIN - silentMin));

  // What a steady cell of this age would have left. It is also the ceiling on a
  // decaying one: extrapolating a gentle decline from a high flash rate gave a
  // collapsing storm a longer life than a healthy one, which cannot be right.
  const typical = ageMin > 60 ? 45 : 55;
  const steadyCeiling = Math.max(MIN_LIFE_MIN, typical - ageMin * 0.35);

  let minutes;
  if (k < -0.005) {
    minutes = Math.min(steadyCeiling, Math.log(SPENT_RATE / rateNow) / k);
  } else {
    // Steady or growing. An ordinary cell runs about an hour; a cluster that has
    // already lasted longer than that is a multicell system and gets more, but
    // not without limit.
    minutes = steadyCeiling * (k > 0.01 ? 1.35 : 1);
  }

  if (!Number.isFinite(minutes)) minutes = MIN_LIFE_MIN;
  return Math.round(Math.max(MIN_LIFE_MIN, Math.min(MAX_LIFE_MIN, minutes)));
}

const MAX_SPEED_KMH = 80;
let previousNowcasts = [];
let lastRaw = [];

/** The fitted vectors from the last run, before smoothing. Diagnostics only. */
export const nowcastInternals = () => lastRaw;

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
  // Positions belong in the key as well as times. Two sets with the same count
  // and the same first and last timestamps were treated as the same input, which
  // is wrong however unlikely — and not unlikely at all for anything generated,
  // where three tracks heading in three directions all came back as the first
  // one. Sampling a dozen strikes is enough to tell them apart without hashing
  // the lot on every draw.
  let shape = 0;
  const stride = Math.max(1, Math.floor(strikes.length / 12));
  for (let i = 0; i < strikes.length; i += stride) {
    shape = (shape * 31 + Math.round(strikes[i].lat * 1000) + Math.round(strikes[i].lon * 1000) * 7) % 2147483647;
  }
  const key = [
    strikes.length,
    strikes[0].ms,
    strikes[strikes.length - 1].ms,
    shape,
    Math.floor(reference.getTime() / 60000),
    p.maxInput, p.maxClusters, p.ransacMax, p.steps.join('-'),
  ].join('|');
  if (key === memoKey) return memoResult;

  const referenceMs = reference.getTime();

  // Density drives the clustering window: busy days want tighter, more precise
  // clusters; quiet days want a longer memory so a slow cell is not dropped.
  let recent = strikes.filter((s) => referenceMs - s.ms <= 7 * 3600 * 1000);
  const rawCount = recent.length;
  recent = thinAcrossTime(recent, p.maxInput);

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

  const input = thinAcrossTime(recent.filter((s) => referenceMs - s.ms <= maxTimeRange), p.maxInput);

  const fitOptions = { binSize, decayConstant, ransacIterations };

  /* ---- the storm's frame ---- */

  // One steering estimate for the whole field. Radar first, because it measures
  // the flow directly; the lightning's own first-pass fit otherwise, which needs
  // no radar coverage and is what makes cell separation work at all on an
  // archived day.
  let sumLat = 0;
  let sumLon = 0;
  for (const s of input) {
    sumLat += s.lat;
    sumLon += s.lon;
  }
  const centreLat = input.length ? sumLat / input.length : null;
  const centreLon = input.length ? sumLon / input.length : null;
  const fromRadar = centreLat === null ? null : radarHintFor(centreLat, centreLon, referenceMs);
  if (centreLat !== null) refreshRadarHints([[centreLat, centreLon]], referenceMs);

  let steering = fromRadar && fromRadar.quality > 0 ? fromRadar : null;
  if (!steering) {
    // A pass with nothing to advect by produces blobs rather than cells, which
    // is useless as an answer and perfectly good for measuring the flow.
    const coarse = clusterStrikes(input, {
      minClusterSize, maxDistance, maxTemporalSeparation, minNeighbours: 3,
    }).sort((a, b) => b.length - a.length).slice(0, 6);
    steering = steeringFromLightning(coarse, fitOptions);
  }

  /**
   * Carries a strike to where the storm that made it would be now.
   *
   * Clustering then measures the gap between cells rather than the ground each
   * has covered, which is the difference between separating two cells and
   * merging a single moving one.
   */
  const advect = steering && steering.speedKmH > 3
    ? (lat, lon, ms) => {
      const hours = (referenceMs - ms) / 3600000;
      const km = steering.speedKmH * hours;
      const rad = (steering.directionDeg * Math.PI) / 180;
      return [
        lat + (km * Math.cos(rad)) / KM_PER_DEG_LAT,
        lon + (km * Math.sin(rad)) / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos((lat * Math.PI) / 180))),
      ];
    }
    : null;

  // In the storm's frame a cell's own strikes sit on top of one another, so the
  // radius that separates neighbours can be much tighter than the one that had
  // to tolerate hours of travel.
  const joinKm = advect ? Math.max(8, maxDistance * 0.4) : maxDistance;
  const minNeighbours = Math.max(2, Math.round(3 + densityRatio * 3));

  const clusters = clusterStrikes(input, {
    minClusterSize, maxDistance: joinKm, maxTemporalSeparation, advect, minNeighbours,
  })
    .sort((a, b) => b.length - a.length)
    .slice(0, p.maxClusters);

  const raw = [];
  const MIN_BINS_FOR_CONFIDENCE = 5;

  for (const cluster of clusters) {
    const fit = fitCluster(cluster, fitOptions);
    const { bins, minTime, maxTime } = fit;
    const sinceLast = referenceMs - maxTime;
    if (sinceLast > maxInactivityMs) continue;
    if (!bins.length) continue;

    let speedKmH = fit.speedKmH;
    let directionDeg = fit.directionDeg;
    const regressionScore = fit.regressionScore;
    const residualKm = fit.residualKm;

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
    const lifeMinutes = remainingLifeMinutes(
      { latest, previous: middle },
      jumpWindow / 60000,
      (maxTime - minTime) / 60000,
      sinceLast / 60000,
      radar?.trend ?? null,
    );

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
      confidence, clusterSize: cluster.length, bins: bins.length,
      jump, growing, lifeMinutes,
      decaying: shrinking === null ? decayFactor < 0.5 : shrinking || decayFactor < 0.5,
      radar,
    });
  }

  // Kept for diagnostics: the fitted vectors before smoothing and projection,
  // which is where a velocity that comes out as zero has to be looked for.
  lastRaw = raw.map((entry) => ({
    size: entry.cluster.length,
    spanMin: +((Math.max(...entry.cluster.map((s) => s.ms)) - Math.min(...entry.cluster.map((s) => s.ms))) / 60000).toFixed(1),
    bins: entry.bins,
    speed: +entry.speedKmH.toFixed(1),
    dir: +entry.directionDeg.toFixed(0),
    r2: +entry.regressionScore.toFixed(2),
    consistency: +entry.consistency.toFixed(2),
  }));

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
  /**
   * The current footprint: the last twenty minutes of strikes, in the storm's
   * own frame.
   *
   * Drawn from ground positions it was not a footprint at all but a smear. A
   * cell travelling at 75 km/h covers 37 km in half an hour, so the hull of its
   * last half hour is forty-odd kilometres long however small the storm is, and
   * every cell on a fast-moving day came out the same elongated shape pointing
   * the same way. Carrying each strike forward to now by the storm motion undoes
   * exactly that, leaving the extent the cell actually has.
   */
  let hull = null;
  if (entry.cluster.length >= 3) {
    const sorted = [...entry.cluster].sort((a, b) => a.ms - b.ms);
    let recent = sorted.filter((s) => referenceMs - s.ms <= HULL_WINDOW_MS);
    if (recent.length < 3) recent = sorted.slice(-3);
    const toRad = Math.PI / 180;
    const points = recent.map((s) => {
      const hours = (referenceMs - s.ms) / 3600000;
      const km = speedKmH * hours;
      const rad = directionDeg * toRad;
      const lat = s.lat + (km * Math.cos(rad)) / KM_PER_DEG_LAT;
      const lon = s.lon + (km * Math.sin(rad)) / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos(s.lat * toRad)));
      return [lon, lat];
    });
    const ring = convexHull(points);
    // Kept in the shape the drawing code already expects.
    if (ring) hull = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  const polygons = [];
  const ring = hull?.geometry?.coordinates?.[0];
  if (ring) {
    // Nothing is projected past the point the cell is expected to be finished.
    // A plus-sixty footprint for a cell with twenty minutes left is a drawing of
    // something that will not be there, and it is the projection people read.
    const horizon = entry.lifeMinutes ?? Infinity;
    for (const minutes of steps.filter((m) => m <= horizon * 1.1)) {
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
    lifeMinutes: entry.lifeMinutes ?? null,
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
