/**
 * Outlook risk scales.
 *
 * Two independent ladders are in play and conflating them produces wrong colours:
 *
 *  - **Auto HOCO** carries a `risk` *percentage* (0–99) and colours it through a
 *    100-entry ramp.
 *  - **Manual (published) outlooks** carry a *category* — Low through Severe — and
 *    use the six-colour published palette.
 */

import { PUBLISHED_RISKS } from '../config.js';

/** Run-length encoded 0–99 percentage ramp, expanded once at load. */
const RAMP_RUNS = [
  ['#ffffff', 1], ['#d0cece', 4], ['#bea497', 5], ['#66c2a4', 10], ['#b3ff00', 10],
  ['#fff200', 10], ['#ffb327', 10], ['#ff7f27', 10], ['#ff5227', 5], ['#ff2e27', 5],
  ['#ec1c24', 5], ['#ec1c5a', 5], ['#b83dba', 5], ['#5a099c', 5], ['#3e00e9', 5],
  ['#2600ff', 5],
];

export const RISK_RAMP = RAMP_RUNS.flatMap(([colour, count]) => Array(count).fill(colour));

/** Colour for a lightning-risk percentage. */
export function riskColour(risk) {
  if (risk === undefined || risk === null || Number.isNaN(Number(risk))) return 'rgba(0,0,0,0)';
  return RISK_RAMP[Math.min(Math.max(Math.floor(Number(risk)), 0), RISK_RAMP.length - 1)];
}

/** Distinct stops for the legend gradient, with the percentage each begins at. */
export function rampStops() {
  const stops = [];
  let position = 0;
  for (const [colour, count] of RAMP_RUNS) {
    stops.push({ colour, from: position, to: position + count - 1 });
    position += count;
  }
  return stops;
}

/* ------------------------------------------------------------------ *
 * Published (categorical) risks
 * ------------------------------------------------------------------ */

/**
 * Severity rank 0–6 for an outlook polygon.
 *
 * Feeds are inconsistent: the level may be a `risk` string, a `user_risk` string,
 * a numeric `rank`, or a `severe` flag, so all of them are honoured.
 */
export function outlookRank(feature) {
  const p = feature?.properties || {};
  const text = String(p.risk ?? p.user_risk ?? '').toUpperCase();
  if (p.isSevere || p.severe || p.user_severe || Number(p.rank ?? p.user_rank) === 6) return 6;
  if (text.includes('SEVERE')) return 6;
  if (text.includes('HIGH')) return 5;
  if (text.includes('MODERATE')) return 4;
  if (text.includes('ENHANCED')) return 3;
  if (text.includes('SLIGHT')) return 2;
  if (text.includes('LOW')) return 1;
  return Math.max(0, Math.min(5, Number(p.rank ?? p.user_rank ?? 0) || 0));
}

export const publishedRisk = (rank) => PUBLISHED_RISKS[rank] || PUBLISHED_RISKS[1];

/** Highest categorical risk in an outlook, ignoring the Severe overlay band. */
export function highestRank(geojson) {
  const ranks = (geojson?.features || []).map(outlookRank).filter((r) => r >= 1 && r <= 5);
  return ranks.length ? Math.max(...ranks) : 0;
}

/** Outlook GeoJSON may arrive as an object or as a JSON string. */
export function parseOutlookGeojson(item) {
  try {
    return typeof item?.geoJSON === 'string' ? JSON.parse(item.geoJSON) : (item?.geoJSON ?? null);
  } catch {
    return null;
  }
}
