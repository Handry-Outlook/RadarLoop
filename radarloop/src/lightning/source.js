/**
 * UK lightning strike ingestion.
 *
 * Data arrives from three places with very different latencies:
 *  - the Met Office live endpoint (fast, the last few minutes),
 *  - its chunked catch-up endpoints (one request per missed chunk),
 *  - large GitHub-hosted seasonal archives (slow, historical).
 *
 * The rule that keeps startup fast is that **nothing waits for the archives**.
 * The live response paints first, chunks paint as each one lands, and the
 * archives merge in whenever they finish.
 */

import { ENDPOINTS } from '../config.js';
import { emit, EVENTS } from '../core/bus.js';
import { lightning } from '../core/state.js';

let inFlight = null;
let archivePromise = null;
let lastCompletedAt = 0;
let lastVisibleAt = Date.now();

/* ------------------------------------------------------------------ *
 * Normalisation & merging
 * ------------------------------------------------------------------ */

/**
 * Converts a payload into lean strike records.
 *
 * Deliberately does **not** spread the source record or keep a `Date`: the
 * archives hold over 1.6 million strikes, and one extra object plus one Date
 * each costs hundreds of megabytes. Everything downstream needs only the
 * timestamp in milliseconds and the position.
 */
function normalise(payload) {
  const strikes = payload?.lightning_strikes;
  if (!Array.isArray(strikes)) return [];

  const out = [];
  for (let i = 0; i < strikes.length; i += 1) {
    const strike = strikes[i];
    const coords = strike.coordinates;
    if (!coords || coords.length < 2) continue;
    const ms = Date.parse(strike.strike_time);
    if (!Number.isFinite(ms)) continue;
    out.push({ ms, lon: +coords[0], lat: +coords[1] });
  }
  return out;
}

/** Two strikes are the same observation if time and position both match. */
function samePoint(a, b) {
  return a.ms === b.ms &&
    Math.round(a.lat * 1e4) === Math.round(b.lat * 1e4) &&
    Math.round(a.lon * 1e4) === Math.round(b.lon * 1e4);
}

/**
 * Merges new strikes into the store, keeping it sorted ascending by time.
 *
 * Implemented as a linear two-pointer merge of two sorted arrays.
 *
 * The previous implementation used `all.push(...fresh)`, which throws
 * `RangeError: Maximum call stack size exceeded` once the batch exceeds the
 * engine's argument limit — so the 1.6-million-strike archives silently failed
 * to merge and no history older than the live feed ever appeared. It also kept a
 * `Set` of string keys for de-duplication, which for that many strikes cost more
 * memory than the strikes themselves. Sorted order makes both unnecessary:
 * duplicates can only be adjacent.
 */
export function merge(incoming) {
  if (!incoming?.length) return 0;

  const sorted = incoming.length > 1
    ? incoming.slice().sort((a, b) => a.ms - b.ms)
    : incoming;

  const all = lightning.all;
  const merged = new Array(all.length + sorted.length);

  let i = 0;
  let j = 0;
  let k = 0;
  let added = 0;

  const write = (entry) => {
    // Duplicates are adjacent once sorted, so one comparison suffices.
    if (k > 0 && samePoint(merged[k - 1], entry)) return false;
    merged[k] = entry;
    k += 1;
    return true;
  };

  while (i < all.length && j < sorted.length) {
    if (all[i].ms <= sorted[j].ms) {
      write(all[i]);
      i += 1;
    } else {
      if (write(sorted[j])) added += 1;
      j += 1;
    }
  }
  while (i < all.length) {
    write(all[i]);
    i += 1;
  }
  while (j < sorted.length) {
    if (write(sorted[j])) added += 1;
    j += 1;
  }

  merged.length = k;
  lightning.all = merged;

  if (added === 0) return 0;
  lightning.lastUpdate = new Date();
  emit(EVENTS.LIGHTNING_DATA, { added, total: merged.length });
  return added;
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export function noteVisible() {
  lastVisibleAt = Date.now();
}

/**
 * Background tabs have their timers throttled, so on resume we may have missed
 * many minutes. Ask for every missed minute rather than only the newest chunk.
 */
function catchupMinutes() {
  const reference = lastCompletedAt || lastVisibleAt || Date.now();
  return Math.max(1, Math.min(120, Math.ceil((Date.now() - reference) / 60000) + 1));
}

/**
 * The archive payloads, kept after the first load.
 *
 * Retaining them costs one copy of a bounded dataset and makes re-merging free.
 * Without it, pruning to bound live-feed growth would permanently discard the
 * historical strikes, and browsing back to an outlook from weeks ago would show
 * an empty map with no way to recover the data.
 */
let archiveStrikes = null;

function loadArchives() {
  if (archivePromise) return archivePromise;
  archivePromise = Promise.allSettled(
    ENDPOINTS.lightningArchives.map((url) => fetch(url).then((r) => (r.ok ? r.json() : null))),
  ).then((results) => {
    archiveStrikes = results.flatMap((r) => (r.status === 'fulfilled' ? normalise(r.value) : []));
    return archiveStrikes;
  });
  return archivePromise;
}

/**
 * Makes sure the store covers back to `startMs`, re-merging the archives if
 * pruning has since removed that far back.
 *
 * @returns {Promise<boolean>} true when strikes were added
 */
export async function ensureCoverage(startMs) {
  if (!Number.isFinite(startMs)) return false;
  const oldest = lightning.all.length ? lightning.all[0].ms : Infinity;
  if (startMs >= oldest) return false;

  const strikes = archiveStrikes ?? (await loadArchives());
  if (!strikes?.length) return false;
  return merge(strikes) > 0;
}

/** Oldest strike currently held, or null. */
export const oldestRetained = () => (lightning.all.length ? lightning.all[0].ms : null);

/**
 * Fetches live strikes. Concurrent calls share one request so an interval tick
 * cannot pile up behind a slow response.
 */
export function fetchStrikes() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const base = await fetch(`${ENDPOINTS.metOfficeLightning}?_=${Date.now()}`, { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error(`Met Office lightning HTTP ${r.status}`);
          return r.json();
        });

      // First paint from the base response — usually one request.
      merge(normalise(base));

      const minutes = catchupMinutes();
      const chunkJobs = (base?.chunks || []).map((chunk) =>
        fetch(
          `${ENDPOINTS.metOfficeLightning}?last-minutes=${minutes}&chunk=${encodeURIComponent(chunk.chunk)}&_=${Date.now()}`,
          { cache: 'no-store' },
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => merge(normalise(payload)))
          .catch((error) => console.warn('[lightning] chunk skipped:', error)),
      );

      // Archives are never on the critical path for the first paint.
      loadArchives()
        .then((strikes) => merge(strikes))
        .catch((error) => console.warn('[lightning] archive load skipped:', error));

      await Promise.allSettled(chunkJobs);
    } catch (error) {
      console.error('[lightning] live fetch failed:', error);
      // Keep whatever is on screen; never replace good data with nothing.
      loadArchives().then((strikes) => merge(strikes)).catch(() => {});
    } finally {
      lastCompletedAt = Date.now();
      inFlight = null;
    }
  })();

  return inFlight;
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * Selects the strikes inside a window.
 *
 * `lightning.all` is kept sorted, so this binary-searches the start and walks
 * forward — O(log n + k) rather than the O(n) scan the old build ran on every
 * scrubber movement with tens of thousands of strikes loaded.
 */
export function filterWindow(startMs, endMs) {
  const all = lightning.all;
  if (!all.length) return [];

  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].ms < startMs) lo = mid + 1;
    else hi = mid;
  }

  const out = [];
  for (let i = lo; i < all.length && all[i].ms <= endMs; i += 1) out.push(all[i]);
  return out;
}

/**
 * Drops strikes older than `cutoffMs` to bound memory.
 *
 * The cutoff must be derived from what the user can actually scrub to, not a
 * fixed age. A hardcoded 48-hour horizon meant that raising the scrubber span to,
 * say, 300 hours deleted every strike the extra range could have shown, so
 * scrubbing back plotted nothing at all.
 */
export function pruneBefore(cutoffMs) {
  if (!Number.isFinite(cutoffMs)) return 0;
  const all = lightning.all;
  // Sorted, so everything to drop is a prefix — one slice beats repeated shift().
  let cut = 0;
  while (cut < all.length && all[cut].ms < cutoffMs) cut += 1;
  if (cut === 0) return 0;
  lightning.all = all.slice(cut);
  return cut;
}

export const lastUpdated = () => lightning.lastUpdate;
