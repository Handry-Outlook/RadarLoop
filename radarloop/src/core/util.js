/** Small, dependency-free helpers shared across the application. */

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** Trailing-edge throttle: guarantees the final call is not dropped. */
export function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  };
}

export const raf = (fn) => requestAnimationFrame(fn);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Yields to the event loop so a long synchronous loop cannot block painting. */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * Async pooling
 * ------------------------------------------------------------------ */

/**
 * Runs `jobs` with a bounded number in flight, preserving result order.
 * `shouldAbort` is consulted between batches so a superseded render can bail out
 * instead of finishing work whose result will be thrown away.
 */
export async function pool(jobs, limit, shouldAbort = () => false) {
  const results = new Array(jobs.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (cursor < jobs.length) {
      if (shouldAbort()) return;
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await jobs[index]() };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * Numbers & geometry
 * ------------------------------------------------------------------ */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const lerp = (a, b, t) => a + (b - a) * t;

/** Great-circle distance in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

export const clampByte = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));

export function hexToRgba(hex, alpha = 255) {
  const h = String(hex || '#000000').replace('#', '').trim();
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
    alpha,
  ];
}

export function rgbaToHex(rgba) {
  return `#${[rgba[0], rgba[1], rgba[2]]
    .map((v) => clampByte(v).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function sameRgb(a, b) {
  return clampByte(a[0]) === clampByte(b[0]) &&
    clampByte(a[1]) === clampByte(b[1]) &&
    clampByte(a[2]) === clampByte(b[2]);
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
export const byId = (id) => document.getElementById(id);

/**
 * Creates an element. `attrs.class`, `attrs.dataset`, `on*` handlers and a
 * `children` array (strings or nodes) are all supported.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') node.innerHTML = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Escapes text destined for an innerHTML template. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORE_PREFIX = 'radarloop:';

export function loadSetting(key, fallback = null) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode / quota — settings simply do not persist */
  }
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

export function formatClock(date, { seconds = false, utc = false } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '--:--';
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  return seconds ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`;
}

export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${formatClock(d)}`;
}

/** `YYYY-MM-DDTHH:mm` in local time, the format `<input type="datetime-local">` wants. */
export function toDateTimeLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function relativeTime(from, to = Date.now()) {
  const deltaMinutes = Math.round((to - new Date(from).getTime()) / 60000);
  if (!Number.isFinite(deltaMinutes)) return '—';
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes} min ago`;
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Local calendar-day key, used to group outlooks. */
export function dateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Accepts a Firestore Timestamp, an ISO string or a Date. */
export function toDate(value) {
  if (!value) return null;
  const d = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
