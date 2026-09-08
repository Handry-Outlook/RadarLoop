/**
 * Automated HOCO runs.
 *
 * A run is a document in `hoco_requests` with `type == 'automated'`, produced for
 * Day 0, Day 1 and Day 2 from one creation time. The geometry itself lives in
 * Cloud Storage, so selecting a run resolves a fresh download URL and fetches it.
 *
 * Run identity is `createdAt` truncated to the minute plus the day offset, which
 * is why loading queries a one-minute window rather than an exact timestamp.
 */

import { emit, EVENTS } from '../core/bus.js';
import { map, safeRemove } from '../core/map.js';
import { dateKey, escapeHtml, toDate } from '../core/util.js';
import { firestoreTimestamp, mainDb, storageUrl } from './firebase.js';
import { riskColour } from './risk.js';
import { refreshOverlayMirror } from '../layers/mirrorBridge.js';

const state = {
  entries: [],
  selectedKey: null,
  opacity: 0.1,
  visible: false,
  loaded: false,
  meta: null,
};

let layer = null;

/* ------------------------------------------------------------------ *
 * Run index
 * ------------------------------------------------------------------ */

/**
 * Builds the calendar index of available runs.
 * One document covers one day offset, so each is expanded into its valid date.
 */
export async function loadRunIndex() {
  const db = mainDb();
  if (!db) return { ok: false, reason: 'Firebase unavailable' };

  try {
    const snapshot = await db.collection('hoco_requests')
      .where('type', '==', 'automated')
      .orderBy('createdAt', 'desc')
      .get();

    const seen = new Set();
    const entries = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      const created = toDate(data.createdAt);
      if (!created) return;
      const id = String(data.id || doc.id);

      for (let day = 0; day < 3; day += 1) {
        if (!id.includes(`Day${day}`)) continue;
        const base = new Date(created);
        base.setSeconds(0, 0);
        const valid = new Date(base);
        valid.setDate(valid.getDate() + day);

        const token = `${base.getTime()}|${day}`;
        if (seen.has(token)) continue;
        seen.add(token);

        entries.push({
          key: `${Math.floor(base.getTime() / 1000)}|${day}`,
          baseSeconds: Math.floor(base.getTime() / 1000),
          day,
          validKey: dateKey(valid),
          created,
          createdLabel: created.toLocaleString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          }),
          startTime: data.startTime,
          endTime: data.endTime,
          sourceId: id,
          maxRisk: Number.isFinite(Number(data.maxRisk ?? data.highestRisk))
            ? Number(data.maxRisk ?? data.highestRisk)
            : undefined,
        });
      }
    });

    state.entries = entries;
    state.loaded = true;
    return { ok: true, count: entries.length };
  } catch (error) {
    console.error('[hoco] run index failed:', error);
    return { ok: false, reason: 'Feed unavailable' };
  }
}

/**
 * Parses the validity window a run declares.
 *
 * Runs store the window inconsistently: sometimes a full ISO timestamp,
 * sometimes a bare "HH:mm" that is relative to the run's valid date.
 */
export function parseValidity(entry) {
  const parse = (value) => {
    if (!value) return null;
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct;
    // Runs often store a bare "HH:mm" against the valid date.
    const m = String(value).match(/(\d{1,2}):(\d{2})/);
    if (!m || !entry.validKey) return null;
    const d = new Date(`${entry.validKey}T00:00:00`);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };
  return { start: parse(entry.startTime), end: parse(entry.endTime) };
}

/** The run whose validity window covers `when`, most recently created first. */
export function activeRun(when = new Date()) {
  return state.entries
    .filter((entry) => {
      const { start, end } = parseValidity(entry);
      return start && end && start <= when && end >= when;
    })
    .sort((a, b) => b.baseSeconds - a.baseSeconds)[0] || null;
}

export const runsForDay = (key) =>
  state.entries.filter((e) => e.validKey === key).sort((a, b) => b.baseSeconds - a.baseSeconds);

/** Day key -> highest declared risk, for the calendar heat. */
export function calendarIndex() {
  const index = new Map();
  for (const entry of state.entries) {
    if (!entry.validKey) continue;
    const current = index.get(entry.validKey);
    if (entry.maxRisk === undefined) {
      if (current === undefined) index.set(entry.validKey, 0);
    } else {
      index.set(entry.validKey, Math.max(current || 0, entry.maxRisk));
    }
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Loading geometry
 * ------------------------------------------------------------------ */

export async function loadRun(key) {
  const entry = state.entries.find((e) => e.key === key);
  if (!entry) return null;

  const db = mainDb();
  if (!db) return null;

  try {
    // Run identity is only accurate to the minute, so query the whole minute.
    const snapshot = await db.collection('hoco_requests')
      .where('type', '==', 'automated')
      .where('createdAt', '>=', firestoreTimestamp(entry.baseSeconds))
      .where('createdAt', '<', firestoreTimestamp(entry.baseSeconds + 60))
      .get();

    const doc = snapshot.docs.find((d) => String(d.data().id || '').includes(`Day${entry.day}`));
    if (!doc) return { ok: false, reason: 'Run has no plot data' };

    const data = doc.data();
    let geojson = data.geojson || data.geoJSON || null;

    if (!geojson && data.geojsonUrl) {
      const url = await storageUrl(data.geojsonUrl);
      geojson = await fetch(url, { mode: 'cors' }).then((r) => r.json());
    }
    if (!geojson) return { ok: false, reason: 'Run has no plot data' };

    // Prefer the loaded document's own window, falling back to the index entry.
    const validity = parseValidity({
      startTime: data.startTime ?? entry.startTime,
      endTime: data.endTime ?? entry.endTime,
      validKey: entry.validKey,
    });

    state.selectedKey = key;
    state.meta = {
      created: toDate(data.createdAt),
      createdLabel: toDate(data.createdAt)?.toLocaleString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }) || '—',
      startTime: data.startTime || 'N/A',
      endTime: data.endTime || 'N/A',
      validFrom: validity.start,
      validTo: validity.end,
      validKey: entry.validKey,
      day: entry.day,
    };

    render(geojson);
    return { ok: true, meta: state.meta };
  } catch (error) {
    if (error?.code === 'storage/object-not-found') {
      return { ok: false, reason: 'Run geometry has expired' };
    }
    console.error('[hoco] run load failed:', error);
    return { ok: false, reason: 'Could not load run' };
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function style(feature) {
  const opacity = state.opacity;
  return {
    fillColor: riskColour(feature.properties?.risk),
    weight: 1,
    color: 'white',
    opacity: Math.min(1, opacity * 2),
    fillOpacity: opacity,
  };
}

function render(geojson) {
  clearAuto();
  const meta = state.meta;

  layer = L.geoJSON(geojson, {
    pane: 'hocoFillPane',
    filter: (f) => /Polygon/.test(f?.geometry?.type || ''),
    style,
    onEachFeature: (feature, featureLayer) => {
      featureLayer.bindPopup(`
        <div class="wx-popup">
          <header class="wx-popup__head" style="--accent:#66c2a4">
            <strong>Auto HOCO thunderstorm forecast</strong>
          </header>
          <dl class="wx-popup__rows">
            <dt>Risk of lightning</dt><dd>${escapeHtml(feature.properties?.risk ?? '—')}%</dd>
            <dt>Run created</dt><dd>${escapeHtml(meta?.createdLabel ?? '—')}</dd>
            <dt>Valid</dt><dd>${escapeHtml(meta?.startTime ?? '—')} – ${escapeHtml(meta?.endTime ?? '—')}</dd>
          </dl>
        </div>`, { className: 'wx-popup-shell' });
    },
  });

  if (state.visible) layer.addTo(map);
  emit(EVENTS.LEGEND_INVALIDATED);
  refreshOverlayMirror();
}

export function clearAuto() {
  safeRemove(layer);
  layer = null;
  refreshOverlayMirror();
}

export function setOpacity(value) {
  refreshOverlayMirror();
  state.opacity = value;
  layer?.setStyle?.(style);
}

export function setVisible(visible) {
  state.visible = visible;
  if (!layer) return;
  if (visible) layer.addTo(map);
  else safeRemove(layer);
}

export const autoState = () => state;
export const isLoaded = () => state.loaded;
export const currentMeta = () => state.meta;
