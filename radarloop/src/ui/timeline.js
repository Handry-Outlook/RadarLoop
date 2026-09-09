/**
 * The timeline: scrubber, transport controls and status readout.
 *
 * The scrubber's value is a position within the current **domain** (see
 * time/controller.js) rather than "minutes back from now", so a focused window —
 * a time filter or a forecast validity period — maps onto the full width of the
 * track instead of being clamped out of reach.
 *
 * Labels update on every input event, but rendering is driven by the debounced
 * `TIME_COMMITTED`, which is what keeps a drag smooth.
 */

import { byId, el, formatClock, relativeTime } from '../core/util.js';
import { on, EVENTS } from '../core/bus.js';
import { lightning, time } from '../core/state.js';
import * as timeCtl from '../time/controller.js';

/** Scrubber resolution. The domain is mapped onto this many steps. */
const STEPS = 1000;

let slider = null;
let clock = null;
let dateLabel = null;
let liveChip = null;
let focusChip = null;
let playButton = null;
let statusLabel = null;
let ticksHost = null;
/** True while a pointer or finger is holding the scrubber. */
let scrubbing = false;

/* ------------------------------------------------------------------ *
 * Domain <-> slider mapping
 * ------------------------------------------------------------------ */

function toSliderValue(timestamp) {
  const { start, end } = timeCtl.domain();
  const span = Math.max(1, end - start);
  return Math.round(((timestamp - start) / span) * STEPS);
}

function fromSliderValue(value) {
  const { start, end } = timeCtl.domain();
  const span = Math.max(1, end - start);
  return start + (Number(value) / STEPS) * span;
}

/* ------------------------------------------------------------------ *
 * Ticks
 * ------------------------------------------------------------------ */

/** Candidate label intervals, in minutes, coarsest chosen to fit. */
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];

/**
 * Draws time ticks across the domain.
 *
 * The label interval is chosen so roughly six to eight labels fit whatever the
 * span is. The previous version emitted one tick per hour, which at a 300-hour
 * span meant ~600 DOM nodes and an unreadable axis.
 */
function paintTicks() {
  if (!ticksHost) return;
  const { start, end } = timeCtl.domain();
  const spanMinutes = Math.max(1, (end - start) / 60000);

  const target = spanMinutes / 7;
  const stepMinutes = TICK_STEPS.find((s) => s >= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const minorMinutes = stepMinutes / (stepMinutes >= 60 ? 4 : 5);

  const multiDay = spanMinutes > 36 * 60;
  const nodes = [];

  // Anchor ticks to whole units of the step so labels land on round times.
  const first = Math.ceil(start / (minorMinutes * 60000)) * minorMinutes * 60000;
  for (let t = first; t <= end; t += minorMinutes * 60000) {
    const percent = ((t - start) / (end - start)) * 100;
    const major = Math.round(t / 60000) % stepMinutes === 0;
    nodes.push(el('span', {
      class: `timeline__tick${major ? ' timeline__tick--major' : ''}`,
      style: { left: `${percent}%` },
    }));
    if (major) {
      const at = new Date(t);
      nodes.push(el('span', {
        class: 'timeline__tick-label',
        style: { left: `${percent}%` },
      }, multiDay
        ? at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : formatClock(at)));
    }
  }

  ticksHost.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ *
 * Readout
 * ------------------------------------------------------------------ */

function paintReadout(timestamp) {
  const date = new Date(timestamp);
  clock.textContent = formatClock(date);
  dateLabel.textContent = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  const live = time.atLive && !timeCtl.isFocused();
  liveChip.className = `chip ${live ? 'chip--live' : 'chip--stale'}`;
  liveChip.querySelector('.chip__label').textContent = live
    ? 'Live'
    : `${describeOffset(timeCtl.liveTimestamp() - timestamp)} back`;

  const label = timeCtl.focusLabel();
  focusChip.hidden = !label;
  if (label) focusChip.querySelector('.chip__label').textContent = label;
}

function describeOffset(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${Math.max(0, minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${Math.round(hours / 24)} d`;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export function buildTimeline() {
  const host = byId('timeline');
  if (!host) return;

  clock = el('span', { class: 'timeline__clock' }, '--:--');
  dateLabel = el('span', { class: 'timeline__date' }, '');
  liveChip = el('span', { class: 'chip chip--live' }, [
    el('span', { class: 'chip__dot' }),
    el('span', { class: 'chip__label' }, 'Live'),
  ]);

  focusChip = el('button', {
    class: 'chip chip--focus',
    hidden: true,
    title: 'Release this window and return to live',
    onClick: () => timeCtl.clearFilter(),
  }, [
    el('span', { class: 'chip__label' }, ''),
    el('span', { class: 'chip__close', 'aria-hidden': 'true' }, '✕'),
  ]);

  slider = el('input', {
    type: 'range',
    class: 'range',
    min: '0',
    max: String(STEPS),
    step: '1',
    value: String(STEPS),
    'aria-label': 'Time scrubber',
  });

  slider.addEventListener('input', () => {
    timeCtl.stop();
    timeCtl.setTime(fromSliderValue(slider.value));
  });

  // Whether the user has hold of the scrubber.
  //
  // The write-back below used to be gated on `document.activeElement === slider`,
  // which is true while dragging with a mouse but not while dragging with a
  // finger: touch does not focus a range input. So on a phone every TIME_CHANGED
  // during a drag rewrote the thumb from the rounded, clamped timestamp while the
  // readout showed the raw one, and the two drifted apart mid-drag. Pointer
  // events answer the question directly on both.
  for (const type of ['pointerdown', 'touchstart']) {
    slider.addEventListener(type, () => { scrubbing = true; }, { passive: true });
  }
  for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
    window.addEventListener(type, () => {
      if (!scrubbing) return;
      scrubbing = false;
      // Settle the thumb on whatever the clamped time actually became.
      slider.value = String(toSliderValue(time.current));
      paintReadout(time.current);
    }, { passive: true });
  }

  ticksHost = el('div', { class: 'timeline__ticks' });

  playButton = el('button', {
    class: 'btn btn--icon',
    'aria-label': 'Play or pause the animation',
    onClick: () => timeCtl.toggle(),
  }, '▶');

  const speed = el('input', {
    type: 'range',
    class: 'range',
    min: '1',
    max: '15',
    step: '1',
    value: String(time.speed),
    style: { width: '76px' },
    'aria-label': 'Animation speed',
  });
  const speedLabel = el('span', { class: 'tiny dim mono' }, `${time.speed}×`);
  speed.addEventListener('input', () => {
    timeCtl.setSpeed(Number(speed.value));
    speedLabel.textContent = `${time.speed}×`;
  });

  statusLabel = el('span', { class: 'tiny dim' }, 'Loading…');

  host.replaceChildren(
    el('div', { class: 'timeline__top' }, [
      el('div', { class: 'timeline__readout' }, [clock, dateLabel, liveChip, focusChip]),
      el('div', { class: 'timeline__transport' }, [
        el('button', { class: 'btn btn--icon', 'aria-label': 'Step back', onClick: () => timeCtl.step(-1) }, '◀'),
        playButton,
        el('button', { class: 'btn btn--icon', 'aria-label': 'Step forward', onClick: () => timeCtl.step(1) }, '▶'),
        el('button', { class: 'btn', onClick: () => timeCtl.goLive() }, 'Now'),
      ]),
      el('div', { class: 'timeline__scrub' }, [slider, ticksHost]),
      el('div', { class: 'row' }, [speed, speedLabel]),
    ]),
    el('div', { class: 'timeline__meta' }, [statusLabel]),
  );

  paintTicks();
  paintReadout(time.current);

  /* --- wiring --- */

  on(EVENTS.TIME_CHANGED, (timestamp) => {
    if (!scrubbing && document.activeElement !== slider) {
      slider.value = String(toSliderValue(timestamp));
    }
    paintReadout(timestamp);
  });

  // The domain itself moved: the whole axis has to be redrawn.
  on(EVENTS.TIME_FOCUS, () => {
    paintTicks();
    slider.value = String(toSliderValue(time.current));
    paintReadout(time.current);
  });

  on(EVENTS.ANIMATION_STATE, ({ playing }) => {
    playButton.textContent = playing ? '⏸' : '▶';
  });

  on(EVENTS.LIGHTNING_FILTERED, ({ total, shown, drawn, decimated }) => {
    const updated = lightning.lastUpdate ? relativeTime(lightning.lastUpdate) : 'never';
    statusLabel.textContent =
      `${shown.toLocaleString()} strikes in window · ${total.toLocaleString()} loaded` +
      (decimated ? ` · showing ${drawn.toLocaleString()}` : '') +
      ` · updated ${updated}`;
  });

  // A live domain slides forward with real time; a focused one is fixed.
  setInterval(() => {
    if (!timeCtl.isFocused()) paintTicks();
  }, 60000);
}

/** Redraws the axis after the scrubber span setting changes. */
export function refreshTimelineAxis() {
  paintTicks();
  if (slider) slider.value = String(toSliderValue(time.current));
}

/** Keyboard shortcuts for the timeline. */
export function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        timeCtl.toggle();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        timeCtl.step(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        timeCtl.step(1);
        break;
      case 'l':
      case 'L':
        timeCtl.goLive();
        break;
      default:
        break;
    }
  });
}
