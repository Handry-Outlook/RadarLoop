/**
 * Manually published Handry Outlook forecasts ("Manual HOCO").
 *
 * Each outlook is valid over a window and may be reissued as several versions.
 * The panel shows a calendar of days that have an outlook, a version picker for
 * the selected day, and the discussion text.
 */

import { emit, EVENTS } from '../core/bus.js';
import { map, renderers, safeRemove } from '../core/map.js';
import { dateKey, toDate } from '../core/util.js';
import { outlookDb, loadFirebase } from './firebase.js';
import { highestRank, outlookRank, parseOutlookGeojson, publishedRisk } from './risk.js';
import { refreshOverlayMirror } from '../layers/mirrorBridge.js';

const state = {
  outlooks: [],
  selectedId: null,
  opacity: 0.12,
  visible: true,
  loaded: false,
};

let fillLayer = null;
let outlineLayer = null;

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export async function loadPublishedOutlooks() {
  // The SDK is fetched on demand; this is the first thing that needs it.
  await loadFirebase().catch(() => {});
  const db = outlookDb();
  if (!db) return { ok: false, reason: 'Firebase unavailable' };

  try {
    const snapshot = await db.collection('forecasts_v2').get();
    const outlooks = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      // isActive === false is a soft delete; missing validity means unusable.
      if (data.geoJSON && data.validFrom && data.validTo && data.isActive !== false) {
        outlooks.push({ id: doc.id, ...data });
      }
    });
    state.outlooks = outlooks;
    state.loaded = true;
    return { ok: true, count: outlooks.length };
  } catch (error) {
    console.error('[outlook] load failed:', error);
    return { ok: false, reason: 'Feed unavailable' };
  }
}

const issueTime = (item) =>
  toDate(item.issuedAt)?.getTime() || toDate(item.validFrom)?.getTime() || 0;

/** Newest issue wins; ties broken by explicit version number. */
function latest(items) {
  return items.slice().sort((a, b) =>
    issueTime(b) - issueTime(a) || Number(b.issueVersion || 0) - Number(a.issueVersion || 0),
  )[0] || null;
}

/** Outlooks whose validity window contains `timestamp`. */
export function validAt(timestamp) {
  return state.outlooks.filter((item) => {
    const from = toDate(item.validFrom);
    const to = toDate(item.validTo);
    return from && to && from.getTime() <= timestamp && to.getTime() >= timestamp;
  });
}

export const latestValidAt = (timestamp) => latest(validAt(timestamp));

/** All versions issued for a calendar day, newest first. */
export function versionsForDay(key) {
  return state.outlooks
    .filter((item) => dateKey(toDate(item.validFrom)) === key)
    .sort((a, b) => issueTime(b) - issueTime(a) || Number(b.issueVersion || 0) - Number(a.issueVersion || 0));
}

/** Day key -> highest risk, for colouring the calendar. */
export function calendarIndex() {
  const index = new Map();
  for (const item of state.outlooks) {
    const key = dateKey(toDate(item.validFrom));
    if (!key) continue;
    const rank = highestRank(parseOutlookGeojson(item));
    index.set(key, Math.max(index.get(key) || 0, rank));
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** The outlook to restore when visibility is switched back on. */
let lastSelectedId = null;

export function clearPublished() {
  safeRemove(fillLayer);
  safeRemove(outlineLayer);
  fillLayer = null;
  outlineLayer = null;
  state.selectedId = null;
  refreshOverlayMirror();
}

/**
 * Draws one outlook.
 *
 * The Severe band (rank 6) is drawn as an outline only — it marks a hatched
 * overlay area rather than a fill category, so filling it would hide the
 * underlying risk colour.
 */
export function renderPublished(item) {
  clearPublished();
  if (!item || !state.visible) return null;

  const geo = parseOutlookGeojson(item);
  const polygons = (geo?.features || []).filter((f) => /Polygon/.test(f?.geometry?.type || ''));
  if (!polygons.length) return null;

  fillLayer = L.geoJSON(
    { type: 'FeatureCollection', features: polygons.filter((f) => outlookRank(f) !== 6) },
    {
      pane: 'publishedOutlookFillPane',
      renderer: renderers.publishedFill,
      interactive: false,
      style: (f) => ({
        fillColor: publishedRisk(outlookRank(f)).color,
        fillOpacity: state.opacity,
        stroke: false,
        weight: 0,
      }),
    },
  ).addTo(map);

  outlineLayer = L.geoJSON(
    { type: 'FeatureCollection', features: polygons },
    {
      pane: 'publishedOutlookOutlinePane',
      renderer: renderers.publishedOutline,
      interactive: false,
      style: (f) => {
        const rank = outlookRank(f);
        return {
          fill: false,
          fillOpacity: 0,
          color: publishedRisk(rank).color,
          opacity: 0.98,
          weight: rank === 6 ? 3.5 : 2.2,
        };
      },
    },
  ).addTo(map);

  state.selectedId = item.id;
  emit(EVENTS.LEGEND_INVALIDATED);
  refreshOverlayMirror();

  const from = toDate(item.validFrom);
  const to = toDate(item.validTo);
  const now = Date.now();
  return {
    id: item.id,
    live: !!(from && to && from.getTime() <= now && to.getTime() >= now),
    risk: publishedRisk(highestRank(geo)).name,
    version: item.issueVersion || 1,
    issued: toDate(item.issuedAt || item.validFrom),
    validFrom: from,
    validTo: to,
    discussion: item.discussion || item.text || '',
    detailUrl: item.detailUrl || null,
  };
}

export function setOpacity(value) {
  state.opacity = value;
  fillLayer?.setStyle?.({ fillOpacity: value });
  refreshOverlayMirror();
}

export function setVisible(visible) {
  state.visible = visible;
  if (!visible) {
    // clearPublished forgets the selection, so remember it: switching the layer
    // back on from the layer list has to restore what was being shown.
    lastSelectedId = state.selectedId ?? lastSelectedId;
    clearPublished();
    return;
  }
  const item = getById(state.selectedId ?? lastSelectedId);
  if (item) renderPublished(item);
}

export const getById = (id) => state.outlooks.find((item) => item.id === id) || null;
export const publishedState = () => state;
export const isLoaded = () => state.loaded;
export const hasOutlooks = () => state.outlooks.length > 0;
