/**
 * Frame resolution: given a product and a target time, work out the URL of the
 * newest frame that actually exists.
 *
 * ## Why this file is the answer to "poor plotting speed"
 *
 * The legacy resolver probed candidate timestamps **sequentially**, and each probe
 * was a real network round trip (or an `<img>` load with a 2.5–5 s timeout). Every
 * scrubber movement could therefore pay several serial round trips *before* the
 * first tile request was even issued. With four or five layers enabled that is
 * where the perceived lag came from.
 *
 * Three changes remove almost all of it:
 *
 *  1. **Learned publish lag.** Providers run a fairly constant number of minutes
 *     behind real time. We remember the offset that last worked for each product
 *     and start there, so the first guess is usually correct and no probe happens.
 *  2. **Probe only when it buys something.** Historical frames (older than the
 *     learned lag) are assumed present — the provider is not going to un-publish
 *     them — so scrubbing back through history issues zero probes.
 *  3. **Shared in-flight promises + positive/negative caches**, so N layers or a
 *     rapid scrub collapse onto one request per distinct frame.
 */

import { TUNING } from '../config.js';
import { runtime } from '../core/state.js';
import { expandUrl, roundToInterval } from './urlTemplate.js';

/* ------------------------------------------------------------------ *
 * Caches
 * ------------------------------------------------------------------ */

const positive = new Map(); // key -> { url, timestamp, at }
const negative = new Map(); // key -> at
const inflight = new Map(); // key -> Promise
/** Last URL known to render for a product, used as a graceful fallback. */
const lastGood = new Map(); // productKey -> { url, timestamp }
/** Learned provider publish lag, in whole intervals behind the target. */
const learnedLag = new Map(); // productKey -> integer >= 0

const LIMITS = { positive: 400, negative: 120, inflight: 48 };

function prune(map, limit) {
  if (map.size <= limit) return;
  let excess = map.size - limit;
  for (const key of map.keys()) {
    map.delete(key);
    if (--excess <= 0) break;
  }
}

export function clearProductCaches(match) {
  lagFoundAt.delete(match);
  discovering.delete(match);
  const hit = (key) => String(key).includes(match);
  for (const key of [...positive.keys()]) if (hit(key)) positive.delete(key);
  for (const key of [...negative.keys()]) if (hit(key)) negative.delete(key);
  for (const key of [...inflight.keys()]) if (hit(key)) inflight.delete(key);
  lastGood.delete(match);
  learnedLag.delete(match);
}

export function clearAllCaches() {
  positive.clear();
  negative.clear();
  inflight.clear();
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

/** Substitutes a representative tile / bbox into a template so it can be fetched. */
function toProbeUrl(url) {
  return url.replace(
    /(\{z\}\/\{x\}\/\{y\}|z=\{z\}&x=\{x\}&y=\{y\}|\{bbox\})/,
    (match) => {
      if (match.startsWith('{z}')) return '5/16/11';
      if (match === '{bbox}') return '39.375,-11.25,45,-5.625';
      return 'z=6&x=31&y=23';
    },
  );
}

/**
 * Some providers (notably the EUMETSAT WMS) send no CORS headers, so `fetch`
 * cannot read the response even when the frame exists. An `<img>` load is the
 * only reliable availability signal for those.
 */
function probeWithImage(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    const join = url.includes('?') ? '&' : '?';
    image.src = `${url}${join}_probe=${Date.now()}`;
  });
}

async function probeWithFetch(url, { noStore = false } = {}) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: noStore ? 'no-store' : 'force-cache',
      // A failed probe must never reject the whole render.
      redirect: 'follow',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True for products whose availability must be tested with an image element. */
const needsImageProbe = (def, type) =>
  def.kind === 'wms' || def.kind === 'image' || type === 'eumetsat-geocolor';

async function probe(url, def, type) {
  runtime.stats.probes += 1;
  if (needsImageProbe(def, type)) return probeWithImage(toProbeUrl(url));
  return probeWithFetch(toProbeUrl(url), { noStore: type === 'windy-radar' });
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * How many earlier frames to try before giving up. Kept deliberately small while
 * animating: during playback a missing frame should be skipped, not hunted for.
 */
function attemptBudget({ animating, historical, activeLayers }) {
  // A gap in the archive is real; step back a little rather than showing nothing.
  if (animating) return 2;
  if (historical) return 3;
  if (runtime.lowEnd) return 3;
  if (activeLayers >= 4) return 3;
  return 4;
}

/* ------------------------------------------------------------------ *
 * Finding the newest published frame
 * ------------------------------------------------------------------ */

/**
 * Offsets (in publishing intervals) probed when a product's lag is unknown.
 *
 * Products run anywhere from a few minutes to several hours behind real time,
 * and some publish only every few hours. A linear walk back from "now" would
 * need dozens of round trips to reach them, so the previous small fixed budget
 * simply gave up and the layer drew nothing at all. This ladder brackets the
 * newest frame in a handful of probes; the exact offset is then pinned down by
 * a short refinement and cached, so it is paid once per product.
 */
const LADDER = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96, 144, 288];
const REFINE_LIMIT = 5;
/** Re-discover periodically so a recovering feed is picked up again. */
const LAG_TTL_MS = 10 * 60 * 1000;

const lagFoundAt = new Map();
const discovering = new Map();

/**
 * Searches back from `rounded` for the newest frame that exists.
 * @returns {Promise<number|null>} the offset in intervals, or null
 */
async function discoverLag(productKey, def, rounded, interval, extraTokens) {
  const existing = discovering.get(productKey);
  if (existing) return existing;

  const job = (async () => {
    let hit = -1;
    let previous = -1;

    for (const offset of LADDER) {
      const ts = rounded - offset * interval;
      // Do not search past the point where the product could plausibly exist.
      if (ts < Date.now() - 400 * interval) break;
      const url = expandUrl(def.url, new Date(ts), extraTokens);
      if (!url) break;
      if (await probe(url, def, productKey)) {
        hit = offset;
        break;
      }
      previous = offset;
    }

    if (hit < 0) return null;

    // Between the last failure and the first success there may be newer frames;
    // walk forward a bounded number of steps to find the freshest.
    let best = hit;
    for (let step = 1; step <= REFINE_LIMIT; step += 1) {
      const candidate = hit - step;
      if (candidate <= previous || candidate < 0) break;
      const url = expandUrl(def.url, new Date(rounded - candidate * interval), extraTokens);
      if (!url) break;
      if (await probe(url, def, productKey)) best = candidate;
      else break;
    }

    learnedLag.set(productKey, best);
    lagFoundAt.set(productKey, Date.now());
    return best;
  })().finally(() => discovering.delete(productKey));

  discovering.set(productKey, job);
  return job;
}

/** True when a cached lag is still worth trusting. */
function lagIsFresh(productKey) {
  const at = lagFoundAt.get(productKey);
  return at !== undefined && Date.now() - at < LAG_TTL_MS;
}

/**
 * Resolves the frame for one product.
 *
 * @returns {Promise<{url:string, timestamp:number, probed:boolean}|null>}
 */
export function resolveFrame(productKey, def, targetTimestamp, opts = {}) {
  const {
    animating = false,
    activeLayers = 1,
    contextKey = '',
    extraTokens = {},
  } = opts;

  const interval = def.interval || 5 * 60 * 1000;
  const rounded = roundToInterval(targetTimestamp, interval);
  const cacheKey = `${productKey}|${rounded}|${contextKey}`;
  const now = Date.now();

  const hit = positive.get(cacheKey);
  if (hit && now - hit.at < TUNING.tileUrlCacheTtlMs) {
    runtime.stats.cacheHits += 1;
    return Promise.resolve({ url: hit.url, timestamp: hit.timestamp, probed: false });
  }
  const miss = negative.get(cacheKey);
  if (miss && now - miss < TUNING.tileUrlNegativeTtlMs) {
    const fallback = lastGood.get(productKey);
    return Promise.resolve(fallback ? { ...fallback, probed: false } : null);
  }

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const job = (async () => {
    try {
      // A frame comfortably in the past is assumed published. This is the case
      // that used to cost a network round trip per scrubber step.
      let lagIntervals = learnedLag.get(productKey) ?? 0;

      // First sight of a product at the live edge: find out how far behind it
      // publishes before guessing, so the very first frame is not a blank.
      if (!animating && !lagIsFresh(productKey) && !lastGood.has(productKey)) {
        const discovered = await discoverLag(productKey, def, rounded, interval, extraTokens);
        if (discovered !== null) lagIntervals = discovered;
      }

      const historical = rounded < now - Math.max(lagIntervals + 2, 4) * interval;

      const budget = attemptBudget({ animating, historical, activeLayers });
      const start = historical ? 0 : lagIntervals;

      for (let step = 0; step < budget; step += 1) {
        const candidateTs = rounded - (start + step) * interval;
        const url = expandUrl(def.url, new Date(candidateTs), extraTokens);
        if (!url) break;

        // Historical frames and plain raster tiles are handed straight to Leaflet.
        // Leaflet already retries and reports tile errors, so a blocking pre-flight
        // check buys nothing but latency.
        const skipProbe = historical || (def.kind === 'raster' && step === 0 && lagIntervals > 0);
        const ok = skipProbe || (await probe(url, def, productKey));

        if (ok) {
          const result = { url, timestamp: candidateTs, probed: !skipProbe };
          positive.set(cacheKey, { url, timestamp: candidateTs, at: Date.now() });
          lastGood.set(productKey, { url, timestamp: candidateTs });
          if (!historical) learnedLag.set(productKey, start + step);
          prune(positive, LIMITS.positive);
          return result;
        }
      }

      // Nothing in the immediate window. Rather than drawing nothing, go and
      // find where this product's data actually starts. This is the case the
      // user sees as "the layer just doesn't appear at NOW".
      if (!animating) {
        const discovered = await discoverLag(productKey, def, rounded, interval, extraTokens);
        if (discovered !== null) {
          const ts = rounded - discovered * interval;
          const url = expandUrl(def.url, new Date(ts), extraTokens);
          if (url) {
            const result = { url, timestamp: ts, probed: true, staleBy: discovered * interval };
            positive.set(cacheKey, { url, timestamp: ts, at: Date.now() });
            lastGood.set(productKey, { url, timestamp: ts });
            prune(positive, LIMITS.positive);
            return result;
          }
        }
      }

      negative.set(cacheKey, Date.now());
      prune(negative, LIMITS.negative);
      // Showing the previous good frame beats blanking the map.
      const fallback = lastGood.get(productKey);
      return fallback ? { ...fallback, probed: false } : null;
    } finally {
      inflight.delete(cacheKey);
      prune(inflight, LIMITS.inflight);
    }
  })();

  inflight.set(cacheKey, job);
  return job;
}

/**
 * Warms the caches for the frames either side of the current one so a scrub or a
 * playback step finds its URL already resolved. Fire-and-forget by design.
 */
export function prefetchNeighbours(productKey, def, targetTimestamp, opts = {}) {
  const interval = def.interval || 5 * 60 * 1000;
  const rounded = roundToInterval(targetTimestamp, interval);
  for (let i = 1; i <= TUNING.prefetchRadius; i += 1) {
    for (const direction of [-1, 1]) {
      const ts = rounded + direction * i * interval;
      if (ts > Date.now() && !def.allowFuture) continue;
      resolveFrame(productKey, def, ts, { ...opts, animating: true }).catch(() => {});
    }
  }
}

/** Diagnostics for the stats panel. */
export const resolverStats = () => ({
  discovered: Object.fromEntries(lagFoundAt),
  positive: positive.size,
  negative: negative.size,
  inflight: inflight.size,
  learnedLag: Object.fromEntries(learnedLag),
});
