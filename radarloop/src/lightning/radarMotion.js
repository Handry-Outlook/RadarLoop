/**
 * Storm motion and trend from radar, for the lightning nowcast.
 *
 * The nowcast used to derive a cluster's velocity from the drift of its own
 * strike centroid across five-minute bins. That is the only signal lightning
 * alone offers, and it is a poor one: strikes are sparse and scattered across the
 * whole convective area, so the centroid jitters by kilometres between bins for
 * reasons that have nothing to do with where the storm is going. A cell producing
 * six flashes in five minutes yields a velocity fitted to six points of noise.
 *
 * Radar gives a far better answer, and the technique is standard: take two
 * reflectivity fields a quarter of an hour apart and find the displacement that
 * best lines one up with the other. That is what every operational nowcasting
 * scheme does before it does anything clever, because advection is most of the
 * forecast at these ranges.
 *
 * Two further things fall out of having the field at all:
 *
 *  - **Extent.** A hull drawn around recent strikes is the electrically active
 *    part of a storm, which is not the storm. The radar core is.
 *  - **Trend.** Whether the convective area is growing or shrinking between the
 *    two frames is a direct measurement, where the old code had to infer it from
 *    a jump in flash rate.
 *
 * Everything here is best-effort. Radar tiles may be missing for a frame, the
 * area may be out of coverage, or the correlation may be too weak to trust; in
 * every one of those cases this returns null and the caller keeps the
 * lightning-only estimate it had before.
 */

import { LAYER_CATALOG } from '../data/layers.js';
import { expandUrl } from '../layers/urlTemplate.js';
import { encodedFromPixel } from '../layers/windy.js';
import { encodedToMmh } from '../layers/radarScale.js';

/**
 * Zoom the field is sampled at.
 *
 * Six puts a pixel at about 1.4 km over the UK, so a storm moving 50 km/h shifts
 * roughly nine pixels in a quarter of an hour — enough to measure, and coarse
 * enough that a window around one cluster is one or two tiles.
 */
const ZOOM = 6;
const TILE = 256;

/** Side of the window correlated, in pixels. About 220 km at this zoom. */
const WINDOW = 160;

/**
 * Largest displacement searched, in pixels.
 *
 * Twenty-four pixels over fifteen minutes is about 135 km/h, which is beyond any
 * storm motion these latitudes produce and well beyond the 80 km/h the nowcast
 * will accept.
 */
const MAX_SHIFT = 24;

/** Minutes between the two frames compared. */
export const SEPARATION_MIN = 15;

/** Rain rate above which a pixel counts as convective, in mm/h. */
const CONVECTIVE_MMH = 4;

/** Below this share of wet pixels there is nothing to correlate. */
const MIN_COVERAGE = 0.01;

/** Below this peak sharpness the match is not distinctive enough to use. */
const MIN_QUALITY = 0.12;

/* ------------------------------------------------------------------ *
 * Sampling the field
 * ------------------------------------------------------------------ */

/** Web Mercator pixel coordinates at ZOOM. */
function project(lat, lon) {
  const scale = TILE * 2 ** ZOOM;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** Ground size of one pixel at a latitude, in kilometres. */
const kmPerPixel = (lat) => (40075 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** ZOOM);

const tiles = new Map();
const TILE_CACHE_MAX = 120;

/**
 * One radar tile as rain rate per pixel, or null.
 *
 * These are the provider's data tiles — reflectivity lives in the red and green
 * channels and a blue pixel is the no-data mask — so they are decoded here with
 * the same functions the radar layer uses rather than read as a picture.
 */
async function loadTile(template, frameMs, x, y) {
  const key = `${frameMs}|${x}|${y}`;
  if (tiles.has(key)) return tiles.get(key);

  const promise = (async () => {
    const url = expandUrl(template, new Date(frameMs))
      .replace('{z}', String(ZOOM))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, TILE, TILE);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, TILE, TILE);

    const field = new Float32Array(TILE * TILE);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const encoded = encodedFromPixel(data[i], data[i + 1], data[i + 2]);
      field[p] = encoded === null ? 0 : encodedToMmh(encoded);
    }
    return field;
  })().catch(() => null);

  tiles.set(key, promise);
  if (tiles.size > TILE_CACHE_MAX) tiles.delete(tiles.keys().next().value);
  return promise;
}

/**
 * A square of rain rate centred on a position, or null if it cannot be filled.
 *
 * Missing tiles are fatal rather than zero-filled: a hole reads as "no rain",
 * which would drag the correlation towards whichever shift lines the hole up.
 */
async function sampleWindow(template, frameMs, lat, lon) {
  const centre = project(lat, lon);
  const left = Math.round(centre.x - WINDOW / 2);
  const top = Math.round(centre.y - WINDOW / 2);
  const field = new Float32Array(WINDOW * WINDOW);

  const first = { x: Math.floor(left / TILE), y: Math.floor(top / TILE) };
  const last = { x: Math.floor((left + WINDOW - 1) / TILE), y: Math.floor((top + WINDOW - 1) / TILE) };
  const span = 2 ** ZOOM;

  for (let ty = first.y; ty <= last.y; ty += 1) {
    for (let tx = first.x; tx <= last.x; tx += 1) {
      if (ty < 0 || ty >= span) return null;
      // eslint-disable-next-line no-await-in-loop
      const tile = await loadTile(template, frameMs, ((tx % span) + span) % span, ty);
      if (!tile) return null;
      for (let y = 0; y < TILE; y += 1) {
        const outY = ty * TILE + y - top;
        if (outY < 0 || outY >= WINDOW) continue;
        for (let x = 0; x < TILE; x += 1) {
          const outX = tx * TILE + x - left;
          if (outX < 0 || outX >= WINDOW) continue;
          field[outY * WINDOW + outX] = tile[y * TILE + x];
        }
      }
    }
  }
  return field;
}

/* ------------------------------------------------------------------ *
 * Matching two fields
 * ------------------------------------------------------------------ */

/**
 * The displacement that best lines up `earlier` with `later`.
 *
 * Normalised cross-correlation over integer shifts, on the inner region so every
 * candidate shift reads real data rather than an edge. The score reported is not
 * the peak correlation but how far the peak stands above the average of all the
 * others: a field of uniform drizzle correlates beautifully with itself at every
 * shift and tells you nothing, whereas a distinct cell produces one sharp peak.
 * That distinction is what separates a measurement from a coincidence.
 */
export function bestShift(earlier, later, size = WINDOW, maxShift = MAX_SHIFT) {
  const inner = size - 2 * maxShift;
  if (inner < 16) return null;

  // Only the overlap is compared, so each candidate is scored on the same pixels.
  const mean = (field, ox, oy) => {
    let sum = 0;
    for (let y = 0; y < inner; y += 1) {
      const row = (y + maxShift + oy) * size + maxShift + ox;
      for (let x = 0; x < inner; x += 1) sum += field[row + x];
    }
    return sum / (inner * inner);
  };

  const baseMean = mean(earlier, 0, 0);
  const scores = new Map();
  let best = null;
  let total = 0;
  let considered = 0;

  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      const shiftedMean = mean(later, dx, dy);
      let num = 0;
      let da = 0;
      let db = 0;
      for (let y = 0; y < inner; y += 1) {
        const aRow = (y + maxShift) * size + maxShift;
        const bRow = (y + maxShift + dy) * size + maxShift + dx;
        for (let x = 0; x < inner; x += 1) {
          const a = earlier[aRow + x] - baseMean;
          const b = later[bRow + x] - shiftedMean;
          num += a * b;
          da += a * a;
          db += b * b;
        }
      }
      const score = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
      scores.set(`${dx}|${dy}`, score);
      total += score;
      considered += 1;
      if (!best || score > best.score) best = { dx, dy, score };
    }
  }

  if (!best || best.score <= 0) return null;
  const average = total / considered;

  /**
   * The peak, refined below one pixel.
   *
   * Integer shifts quantise the answer badly at these distances. A storm moving
   * nine pixels in fifteen minutes is resolved to about 11% in speed, and the
   * bearing error near the axes is worse still — a displacement of (9, 0) and
   * one of (9, 1) are six degrees apart and indistinguishable. Fitting a
   * parabola through the peak and its two neighbours on each axis recovers the
   * fraction between them, which is standard for correlation peaks and costs
   * four extra lookups.
   */
  const at = (dx, dy) => scores.get(`${dx}|${dy}`) ?? -1;
  const parabola = (left, centre, right) => {
    const denominator = left - 2 * centre + right;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return 0;
    const offset = (0.5 * (left - right)) / denominator;
    return Math.abs(offset) <= 1 ? offset : 0;
  };

  let subX = best.dx;
  let subY = best.dy;
  if (Math.abs(best.dx) < maxShift && Math.abs(best.dy) < maxShift) {
    const west = at(best.dx - 1, best.dy);
    const east = at(best.dx + 1, best.dy);
    const north = at(best.dx, best.dy - 1);
    const south = at(best.dx, best.dy + 1);
    if (west >= 0 && east >= 0) subX += parabola(west, best.score, east);
    if (north >= 0 && south >= 0) subY += parabola(north, best.score, south);
  }

  return { ...best, subX, subY, prominence: best.score - average };
}

/** Share of a field above a rain rate. */
function coverage(field, threshold) {
  let wet = 0;
  for (let i = 0; i < field.length; i += 1) if (field[i] >= threshold) wet += 1;
  return wet / field.length;
}

/* ------------------------------------------------------------------ *
 * The estimate
 * ------------------------------------------------------------------ */

/** The catalog's own template, so there is one definition of the radar URL. */
const template = () => LAYER_CATALOG.radar?.['windy-radar']?.url || null;

/** Radar frames land on five-minute boundaries, a little behind the clock. */
const frameAt = (ms) => Math.floor(ms / 300000) * 300000;

/**
 * Motion and trend for one position, or null when radar cannot say.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} referenceMs the moment the nowcast is being made from
 */
export async function measureMotion(lat, lon, referenceMs) {
  const url = template();
  if (!url || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  // A published frame, not the current one: the composite runs a few minutes
  // behind and asking for the newest slot mostly returns nothing.
  const later = frameAt(referenceMs - 10 * 60 * 1000);
  const earlier = later - SEPARATION_MIN * 60 * 1000;

  const [a, b] = await Promise.all([
    sampleWindow(url, earlier, lat, lon),
    sampleWindow(url, later, lat, lon),
  ]);
  if (!a || !b) return null;

  const wetEarlier = coverage(a, CONVECTIVE_MMH);
  const wetLater = coverage(b, CONVECTIVE_MMH);
  if (Math.max(wetEarlier, wetLater) < MIN_COVERAGE) return null;

  const match = bestShift(a, b);
  if (!match || match.prominence < MIN_QUALITY) return null;

  const km = kmPerPixel(lat);
  const hours = SEPARATION_MIN / 60;
  // Screen y grows southwards.
  const eastKmH = (match.subX * km) / hours;
  const northKmH = (-match.subY * km) / hours;

  return {
    speedKmH: Math.hypot(eastKmH, northKmH),
    directionDeg: (Math.atan2(eastKmH, northKmH) * 180 / Math.PI + 360) % 360,
    // Prominence is a small number by construction; this maps the useful part of
    // its range onto nought-to-one without pretending to more precision.
    quality: Math.max(0, Math.min(1, (match.prominence - MIN_QUALITY) / 0.35)),
    coverage: wetLater,
    // Above one the convective area is growing, below one it is decaying.
    trend: wetEarlier > 0 ? wetLater / wetEarlier : 1,
    frames: [earlier, later],
  };
}

/** Forgets cached tiles. For tests, and when the radar scale changes. */
export function resetRadarMotion() {
  tiles.clear();
}
