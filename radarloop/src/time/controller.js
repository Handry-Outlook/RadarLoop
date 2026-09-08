/**
 * The time model: the scrubber domain, the current timestamp, the active filter
 * and playback.
 *
 * ## The domain
 *
 * The scrubber spans an explicit **domain**. Normally that is
 * `[now - historyHours, live]`, but applying a time filter or focusing a forecast
 * window replaces it with exactly that window.
 *
 * This is the fix for a class of bugs: the domain used to be derived implicitly
 * from `historyHours`, and `setTime` clamped to it. Any timestamp outside — a
 * filter range further back than the scrubber span, or an outlook valid last
 * Tuesday — was silently clamped, so the scrubber could not move to it and the
 * weather and lightning layers disagreed about what was being shown.
 */

import { TUNING } from '../config.js';
import { emit, EVENTS } from '../core/bus.js';
import { time, setHistoryHours } from '../core/state.js';
import { debounce, clamp, saveSetting } from '../core/util.js';

/* ------------------------------------------------------------------ *
 * Domain
 * ------------------------------------------------------------------ */

/** Newest timestamp reachable live, allowing for provider ingest lag. */
export const liveTimestamp = () => Date.now() - TUNING.processingDelayMs;

/** The scrubber's current span. */
export function domain() {
  if (time.domainStart !== null && time.domainEnd !== null) {
    return { start: time.domainStart, end: time.domainEnd, focused: true };
  }
  return {
    start: Date.now() - time.historyHours * 3600 * 1000,
    end: liveTimestamp(),
    focused: false,
  };
}

export const isFocused = () => time.domainStart !== null && time.domainEnd !== null;

/** Oldest timestamp reachable from the scrubber. */
export const earliestTimestamp = () => domain().start;

/**
 * The time window whose data should be displayed.
 * With a filter or focus it is that window; otherwise it is the lightning
 * lifespan ending at the scrubber position.
 */
export function activeWindow(lifespanHours) {
  if (time.mode === 'inputs' && time.filterStart && time.filterEnd) {
    // Progressive reveal: strikes accumulate from the window's start up to the
    // scrubber position. Parking at the end shows the whole period, and dragging
    // back plays it out rather than showing everything at every position.
    const end = new Date(Math.min(time.current, time.filterEnd.getTime()));
    return { start: time.filterStart, end, progressive: true };
  }
  const end = new Date(time.current);
  const start = new Date(time.current - lifespanHours * 3600 * 1000);
  return { start, end, progressive: false };
}

/* ------------------------------------------------------------------ *
 * Changing the time
 * ------------------------------------------------------------------ */

const commit = debounce((timestamp) => emit(EVENTS.TIME_COMMITTED, timestamp), TUNING.scrubDebounceMs);

/**
 * Moves the displayed time.
 *
 * `TIME_CHANGED` fires immediately so labels track the scrubber with no lag;
 * `TIME_COMMITTED` is debounced and is what triggers a re-render, so dragging
 * does not queue one render per pixel.
 */
export function setTime(timestamp, { immediate = false } = {}) {
  const { start, end } = domain();
  // A focused domain is authoritative; the live domain allows a little slack
  // past the live edge for forecast products.
  const upper = isFocused() ? end : Date.now() + 6 * 3600 * 1000;
  const bounded = clamp(timestamp, start - 60000, upper);

  time.current = bounded;
  time.atLive = !isFocused() && bounded >= liveTimestamp() - 30000;

  emit(EVENTS.TIME_CHANGED, bounded);
  if (immediate) {
    commit.cancel();
    emit(EVENTS.TIME_COMMITTED, bounded);
  } else {
    commit(bounded);
  }
}

/** Returns to the live domain and jumps to the newest frame. */
export function goLive() {
  time.mode = 'slider';
  time.filterStart = null;
  time.filterEnd = null;
  clearFocus({ silent: true });
  setTime(liveTimestamp(), { immediate: true });
}

/** Steps by whole publishing intervals; the scrubber's ◀/▶ buttons use this. */
export function step(direction, minutes = 5) {
  stop();
  setTime(time.current + direction * minutes * 60000, { immediate: true });
}

export function setHistorySpan(hours) {
  setHistoryHours(hours);
  // Only meaningful for the live domain; a focused window keeps its own span.
  if (!isFocused() && time.current < earliestTimestamp()) {
    setTime(earliestTimestamp(), { immediate: true });
  } else {
    emit(EVENTS.TIME_CHANGED, time.current);
    // The reachable range changed, so dependent layers must re-evaluate.
    emit(EVENTS.TIME_COMMITTED, time.current);
  }
}

/* ------------------------------------------------------------------ *
 * Focus — filters and forecast windows
 * ------------------------------------------------------------------ */

/**
 * Points the whole timeline at one window.
 *
 * The scrubber is re-based onto `[start, end]`, the data filter is set to the
 * same window, and the position is parked at its end. Used by the time-filter
 * controls and by outlook selection.
 *
 * @param {Date} start
 * @param {Date} end
 * @param {{label?: string, source?: string}} [meta]
 */
export function focusWindow(start, end, { label = null, source = null } = {}) {
  if (!(start instanceof Date) || !(end instanceof Date)) return false;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (end <= start) return false;

  time.domainStart = start.getTime();
  time.domainEnd = end.getTime();
  time.focusLabel = label;
  time.focusSource = source;

  time.filterStart = start;
  time.filterEnd = end;
  time.mode = 'inputs';

  stop();
  setTime(end.getTime(), { immediate: true });
  emit(EVENTS.TIME_FOCUS, { start, end, label, source });
  return true;
}

/** Drops the focused domain and returns to the rolling live window. */
export function clearFocus({ silent = false } = {}) {
  const had = isFocused();
  time.domainStart = null;
  time.domainEnd = null;
  time.focusLabel = null;
  time.focusSource = null;
  if (had && !silent) emit(EVENTS.TIME_FOCUS, null);
}

export const focusSource = () => time.focusSource;
export const focusLabel = () => time.focusLabel;

/** Applies an explicit filter range from the time-filter controls. */
export function applyFilter(start, end) {
  return focusWindow(start, end, { label: 'Time filter', source: 'filter' });
}

export function clearFilter() {
  goLive();
  emit(EVENTS.TIME_FOCUS, null);
}

export const hasFilter = () => time.mode === 'inputs' && !!time.filterStart && !!time.filterEnd;

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

let timer = null;

/**
 * Plays forward through the domain, wrapping at its end.
 *
 * Driven by a self-scheduling timeout rather than a fixed interval: if a frame
 * takes longer than the step budget, the next step is not queued on top of it.
 */
export function play({ stepMinutes = 5 } = {}) {
  if (time.playing) return;
  time.playing = true;
  emit(EVENTS.ANIMATION_STATE, { playing: true });

  const tick = () => {
    if (!time.playing) return;
    const { start, end } = domain();
    const next = time.current + stepMinutes * 60000;
    setTime(next > end ? start : next, { immediate: true });
    timer = setTimeout(tick, Math.max(60, 1000 / time.speed));
  };
  timer = setTimeout(tick, Math.max(60, 1000 / time.speed));
}

export function stop() {
  if (!time.playing) return;
  time.playing = false;
  clearTimeout(timer);
  timer = null;
  emit(EVENTS.ANIMATION_STATE, { playing: false });
}

export function toggle(options) {
  if (time.playing) stop();
  else play(options);
}

export function setSpeed(stepsPerSecond) {
  time.speed = clamp(stepsPerSecond, 1, 15);
  saveSetting('animationSpeed', time.speed);
}

/* ------------------------------------------------------------------ *
 * Auto-follow
 * ------------------------------------------------------------------ */

let followTimer = null;

/**
 * Keeps the view pinned to the newest frame while the scrubber is at the live
 * edge. Deliberately inert while playing, filtered or focused.
 */
export function startAutoFollow() {
  stopAutoFollow();
  followTimer = setInterval(() => {
    if (!time.autoLatest || time.playing || hasFilter() || isFocused() || !time.atLive) return;
    setTime(liveTimestamp(), { immediate: true });
  }, 30000);
}

export function stopAutoFollow() {
  clearInterval(followTimer);
  followTimer = null;
}

export function setAutoLatest(enabled) {
  time.autoLatest = enabled;
  saveSetting('autoLatest', enabled);
  if (enabled) goLive();
}
