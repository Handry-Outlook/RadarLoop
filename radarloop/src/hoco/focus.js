/**
 * Pointing the timeline at a forecast outlook.
 *
 * Selecting an outlook re-bases the whole timeline onto its validity period, so
 * the scrubber, the weather layers and the strike filter all describe the same
 * window as the polygons on screen.
 *
 * Three rules govern it:
 *
 *  1. **A forecast that is valid right now is shown up to now, not to its end.**
 *     Its remaining validity is in the future, and there is no observed data
 *     there — running the scrubber into it would only show empty frames.
 *  2. **Strike lifespan matches the window.** The age gradient is normalised over
 *     the period being examined rather than the default few hours, so every
 *     strike in the outlook is drawn and coloured by its position within it.
 *  3. **Manual outlooks outrank automated ones.** While a manual outlook owns
 *     the timeline, selecting an automated run leaves it alone; releasing the
 *     manual window frees the timeline again.
 *
 * None of this happens from merely *viewing* an outlook — only from selecting
 * one. See focusOutlook().
 */

import { lightning, setLightningOption } from '../core/state.js';
import { emit, on, EVENTS } from '../core/bus.js';
import * as timeCtl from '../time/controller.js';

export const SOURCE_MANUAL = 'outlook:manual';
export const SOURCE_AUTO = 'outlook:auto';

/** Lifespan to restore when the outlook window is released. */
let previousLifespan = null;

/**
 * Resolves the window actually shown for an outlook valid over `[from, to]`.
 *
 * @returns {{start: Date, end: Date, live: boolean}|null}
 */
export function resolveWindow(from, to) {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null;
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) return null;

  const now = Date.now();
  // Rule 1: an in-force outlook is shown from its start up to now.
  if (from.getTime() <= now && to.getTime() >= now) {
    return { start: from, end: new Date(now), live: true };
  }
  if (to <= from) return null;
  return { start: from, end: to, live: false };
}

/**
 * Points the timeline at an outlook's validity period.
 *
 * Only ever called for an explicit selection. Merely *displaying* an outlook —
 * the panel auto-selecting whichever one is valid now — must not touch the
 * timeline or the strike lifespan, or simply opening the outlook panel would
 * silently change the user's settings.
 *
 * @param {Date} from             outlook validFrom
 * @param {Date} to               outlook validTo
 * @param {object} options
 * @param {string} options.source SOURCE_MANUAL or SOURCE_AUTO
 * @param {string} options.label  shown on the timeline chip
 * @returns {{start: Date, end: Date, live: boolean, hours: number}|null}
 *   null when the window is unusable, or when a manual outlook outranks it.
 */
export function focusOutlook(from, to, { source, label } = {}) {
  const window = resolveWindow(from, to);
  if (!window) return null;

  // Rule 3: a manual outlook keeps the timeline against an automated run.
  // Releasing it (the timeline chip) frees the timeline for automated runs.
  if (source === SOURCE_AUTO && timeCtl.focusSource() === SOURCE_MANUAL) return null;

  const hours = (window.end - window.start) / 3600000;

  // Rule 2: normalise the strike age gradient over this period.
  if (previousLifespan === null) previousLifespan = lightning.lifespanHours;
  // Not persisted: this is the outlook window length, not a preference the user
  // chose, and persisting it made it the startup default in later sessions.
  setLightningOption('lifespanHours', Math.max(0.1, Number(hours.toFixed(2))), { persist: false });
  emit(EVENTS.LIGHTNING_OPTIONS, { lifespanHours: lightning.lifespanHours });

  const ok = timeCtl.focusWindow(window.start, window.end, {
    label: label || (window.live ? 'Outlook · in force' : 'Outlook'),
    source,
  });
  if (!ok) return null;

  return { ...window, hours };
}

/** Restores the pre-outlook lifespan when the window is released. */
export function releaseOutlookLifespan() {
  if (previousLifespan === null) return;
  setLightningOption('lifespanHours', previousLifespan, { persist: false });
  emit(EVENTS.LIGHTNING_OPTIONS, { lifespanHours: lightning.lifespanHours });
  previousLifespan = null;
}

/** True while the timeline is pointed at an outlook. */
export const isOutlookFocused = () =>
  [SOURCE_MANUAL, SOURCE_AUTO].includes(timeCtl.focusSource());

/** A short human description of the focused window, for the panel. */
export function describeWindow(window) {
  if (!window) return '';
  const fmt = (d) => d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const length = window.hours >= 24
    ? `${(window.hours / 24).toFixed(1)} days`
    : `${window.hours.toFixed(window.hours < 10 ? 1 : 0)} hours`;
  return window.live
    ? `Showing ${fmt(window.start)} → now (${length}); the rest of this outlook is still in the future.`
    : `Showing ${fmt(window.start)} → ${fmt(window.end)} (${length}).`;
}

/**
 * Restores the lifespan whenever the focused window is released, by whatever
 * route — the timeline chip, the Now button, or clearing the time filter.
 */
export function initOutlookFocus() {
  on(EVENTS.TIME_FOCUS, (payload) => {
    if (payload === null) releaseOutlookLifespan();
  });
}
