/**
 * Time-token expansion for layer URL templates.
 *
 * The legacy code repeated the same eleven `.replace(/\$\{token\}/g, …)` calls in
 * three places, rebuilding every formatter closure on each call. The token table
 * below is declared once and the substitution is a single regex pass, so building
 * a URL is O(url) rather than O(url x tokens).
 *
 * Ordering used to matter (`${isoMs}` had to be replaced before `${iso}` or the
 * shorter token would corrupt the longer one). A single pass over `\$\{name\}`
 * removes that hazard entirely.
 */

const pad = (n) => String(n).padStart(2, '0');

/** Floors a date to the nearest `minutes` boundary in UTC. */
export function floorUtcMinutes(value, minutes) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / minutes) * minutes, 0, 0);
  return d;
}

/** Floors to a boundary using local-time minutes, matching the legacy behaviour. */
function floorLocalMinutes(value, minutes) {
  const d = new Date(value);
  d.setMinutes(Math.floor(d.getMinutes() / minutes) * minutes, 0, 0);
  return d;
}

const windyRadarFrame = (d) => floorUtcMinutes(d, 5);

const compact = (d) =>
  String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
  pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());

/**
 * Token table. Each entry receives the target Date and returns its replacement.
 * Add a provider format here rather than in the renderer.
 */
export const TOKENS = {
  /** Full ISO with milliseconds, e.g. 2026-09-08T14:35:00.000Z */
  isoMs: (d) => d.toISOString(),
  /** ISO to the second, e.g. 2026-09-08T14:35:00Z */
  iso: (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  /** Compact 14-char stamp, e.g. 20260908143500 */
  iso2: (d) => d.toISOString().replace(/[-:T.]/g, '').slice(0, 14),

  /** Windy satellite frame id: 10-minute buckets, e.g. 2026-09-08-143000 */
  windyIso: (d) => {
    const r = floorLocalMinutes(d, 10);
    return `${r.toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15)}00`;
  },
  /** Windy satellite freshness bound: frame + 4 minutes. */
  windyMaxt: (d) => {
    const r = floorLocalMinutes(d, 10);
    return new Date(r.getTime() + 4 * 60 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  },

  /** Windy radar composite path parts: 5-minute UTC buckets. */
  windyRadarYYYY: (d) => String(windyRadarFrame(d).getUTCFullYear()),
  windyRadarMM: (d) => pad(windyRadarFrame(d).getUTCMonth() + 1),
  windyRadarDD: (d) => pad(windyRadarFrame(d).getUTCDate()),
  windyRadarHHmm: (d) => {
    const f = windyRadarFrame(d);
    return pad(f.getUTCHours()) + pad(f.getUTCMinutes());
  },
  /** Windy radar cache-buster: frame + 4 min 51 s, as the provider publishes it. */
  windyRadarMaxt: (d) => compact(new Date(windyRadarFrame(d).getTime() + (4 * 60 + 51) * 1000)),

  /** OPERA binary filename stamp: 5-minute UTC buckets, e.g. 20260908T1435 */
  operaTime: (d) => {
    const f = floorUtcMinutes(d, 5);
    if (!f) return '';
    return `${f.getUTCFullYear()}${pad(f.getUTCMonth() + 1)}${pad(f.getUTCDate())}T${pad(f.getUTCHours())}${pad(f.getUTCMinutes())}`;
  },

  // Note: the legacy `uk-nw-precip-intensity` product references ${isoNw1} /
  // ${isoNw2}, but no substitution for them was ever implemented, so the layer
  // could not resolve. It is carried over as an unlisted definition; adding the
  // two formatters here is all that would be needed to revive it.
};

const TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expands `${token}` placeholders in a URL template.
 *
 * @param {string} template  the raw URL from the catalog
 * @param {Date|number} date the frame time to render
 * @param {object} [extra]   additional literal substitutions, e.g. `{ iso_now, iso_future }`
 *                           for the dual-timestamp nowcast products
 */
export function expandUrl(template, date, extra = {}) {
  if (!template) return '';
  const d = date instanceof Date ? date : new Date(date);
  return template.replace(TOKEN_RE, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
    const fn = TOKENS[name];
    if (!fn) return match; // leave unknown tokens intact rather than silently blanking them
    try {
      return fn(d);
    } catch {
      return match;
    }
  });
}

/**
 * Rounds a target timestamp down to a product's publishing interval, so two
 * scrubber positions inside the same interval resolve to the same frame — the
 * cheapest possible way to avoid redundant network work while scrubbing.
 */
export function roundToInterval(timestamp, intervalMs) {
  const interval = intervalMs || 5 * 60 * 1000;
  const d = new Date(timestamp);
  const minutes = interval / 60000;
  d.setMinutes(Math.floor(d.getMinutes() / minutes) * minutes, 0, 0);
  return d.getTime();
}

/** True when a URL resolves to an image payload rather than vector data. */
export const isImagePayload = (url) => /\.(?:png|webp|jpe?g)(?:\?|$)/i.test(url || '');
