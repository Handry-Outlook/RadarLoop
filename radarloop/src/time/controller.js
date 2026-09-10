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
const LIVE_SKEW_MS = 60 * 1000;

export function activeWindow(lifespanHours) {
  if (time.mode === 'inputs' && time.filterStart && time.filterEnd) {
    // Progressive reveal: strikes accumulate from the window's start up to the
    // scrubber position. Parking at the end shows the whole period, and dragging
    // back plays it out rather than showing everything at every position.
    const end = new Date(Math.min(time.current, time.filterEnd.getTime()));
    return { start: time.filterStart, end, progressive: true };
  }
  // At the live edge the window runs to *now*, not to the last clock tick.
  //
  // `time.current` only advances when the auto-follow timer fires, so a strike
  // arriving between ticks fell outside the window and was not drawn. That also
  // silenced the cue: the live poll asks "are any of these strikes new?" at the
  // moment the data lands, and the answer was no because none of them were in
  // range yet. By the time the clock caught up, the redraw was a clock refresh
  // rather than a data one, and the cue only fires for data.
  //
  // The tolerance absorbs clock skew between the browser and the feed, which
  // otherwise puts a just-detected strike marginally in the future.
  const liveEdge = time.atLive ? Math.max(time.current, Date.now() + LIVE_SKEW_MS) : time.current;
  const end = new Date(liveEdge);
  const start = new Date(liveEdge - lifespanHours * 3600 * 1000);
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
 * How long a single frame may take before playback moves on regardless.
 *
 * Without a cap, one provider stalling would freeze the animation rather than
 * degrade it.
 */
/**
 * How long a single frame may take before playback moves on regardless.
 *
 * A fixed 4 s was wrong on a slow device: a throttled machine takes around
 * 3.5 s to load a 3D frame, so frames timed out and were skipped just as they
 * were about to appear — which reads as nothing being plotted at all rather
 * than as slow playback. The budget follows the recent frames instead, so a
 * slow device degrades to a slideshow that still shows every frame.
 */
const FRAME_DEADLINE_MIN_MS = 4000;
const FRAME_DEADLINE_MAX_MS = 15000;

/** Durations of the last few frames, for the adaptive budget. */
const frameTimes = [];

function frameDeadline() {
  if (frameTimes.length < 3) return FRAME_DEADLINE_MIN_MS;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Generous against the median so an ordinary frame is never cut off, but
  // still bounded so a genuinely stuck one cannot freeze playback.
  return Math.min(FRAME_DEADLINE_MAX_MS, Math.max(FRAME_DEADLINE_MIN_MS, median * 3));
}

function noteFrameTime(ms) {
  frameTimes.push(ms);
  if (frameTimes.length > 8) frameTimes.shift();
}

/**
 * Waits for the frame just requested to reach the screen.
 *
 * Injected rather than imported: the renderer pulls in the whole map stack, and
 * importing it here made this module impossible to load without a DOM — which
 * the equivalence harness does, and which is worth protecting. main.js supplies
 * the real one; on its own the controller simply does not wait.
 */
let framePacer = () => Promise.resolve(true);

export function setFramePacer(fn) {
  if (typeof fn === 'function') framePacer = fn;
}

/** Called when playback ends; main.js supplies the catch-up. */
let onStopped = () => {};

export function setPlaybackSettled(fn) {
  if (typeof fn === 'function') onStopped = fn;
}

/**
 * Plays forward through the domain, wrapping at its end.
 *
 * Each step waits for the previous frame to actually reach the screen before
 * scheduling the next. That is the whole point: the loop used to reschedule on a
 * bare timer, so at 4x it asked for a frame every 250 ms while frames were
 * taking around 700 ms. `renderAll` dropped the requests it could not service,
 * but `time.current` had already advanced past them, so tiles were fetched for
 * frames that were superseded before they finished — 455 tile requests to draw
 * 16 frames, and the faster you asked it to go, the more of the connection went
 * to frames nobody ever saw.
 *
 * Pacing on the frame instead makes speed a ceiling rather than a demand:
 * playback runs as fast as the data allows, and no faster.
 */
export function play({ stepMinutes = 5 } = {}) {
  if (time.playing) return;
  time.playing = true;
  emit(EVENTS.ANIMATION_STATE, { playing: true });

  const tick = async () => {
    if (!time.playing) return;
    const started = performance.now();

    const { start, end } = domain();
    const next = time.current + stepMinutes * 60000;
    setTime(next > end ? start : next, { immediate: true });

    await framePacer(frameDeadline());
    if (!time.playing) return;
    noteFrameTime(performance.now() - started);

    // Whatever is left of this frame's budget, if anything.
    const budget = Math.max(60, 1000 / time.speed);
    const remaining = budget - (performance.now() - started);
    timer = setTimeout(tick, Math.max(0, remaining));
  };

  timer = setTimeout(tick, Math.max(60, 1000 / time.speed));
}

export function stop() {
  if (!time.playing) return;
  time.playing = false;
  frameTimes.length = 0;
  // Slow products held their frame while this was running; let them catch up.
  onStopped();
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
