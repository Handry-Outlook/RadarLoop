/**
 * Outlook panel: manual (published) HOCO and automated HOCO runs.
 *
 * Both feeds share the same shape — a calendar of days that have an outlook, a
 * picker for which issue/run to show, and an opacity control — so the calendar is
 * written once and parameterised.
 */

import { ASSETS } from '../config.js';
import { el, dateKey, escapeHtml, formatDateTime } from '../core/util.js';
import { time } from '../core/state.js';
import { toast } from './components.js';
import { disclosure, opacityRow, sectionTitle, switchRow } from './components.js';
import * as published from '../hoco/published.js';
import * as auto from '../hoco/auto.js';
import { publishedRisk, riskColour } from '../hoco/risk.js';
import { describeWindow, focusOutlook, SOURCE_AUTO, SOURCE_MANUAL } from '../hoco/focus.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * A month calendar whose days are enabled only where the index has an entry.
 *
 * `index` is read on every paint rather than captured once: outlooks arrive
 * asynchronously and the feed refreshes, and a snapshot taken when the panel was
 * built silently stopped showing anything published afterwards.
 *
 * `colourFor` maps a day's value to the marker colour.
 */
function buildCalendar({ index, colourFor, onSelect, initialMonth = new Date() }) {
  const readIndex = () => (typeof index === 'function' ? index() : index) || new Map();

  let month = new Date(initialMonth.getFullYear(), initialMonth.getMonth(), 1);
  let selected = null;

  const label = el('strong');
  const grid = el('div', { class: 'calendar__grid' });
  const prev = el('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Previous month' }, '‹');
  const next = el('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Next month' }, '›');

  /** Oldest and newest months that actually hold something. */
  function extent() {
    const keys = [...readIndex().keys()].sort();
    if (!keys.length) return null;
    return { first: keys[0].slice(0, 7), last: keys[keys.length - 1].slice(0, 7) };
  }

  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  const paint = () => {
    const entries = readIndex();
    label.textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;

    // Wandering off into empty years is not useful; the arrows stop at the data.
    const range = extent();
    const here = monthKey(month);
    prev.disabled = !!range && here <= range.first;
    next.disabled = !!range && here >= range.last;

    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    // Monday-first offset.
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const todayKey = dateKey(new Date());

    const cells = [];
    for (let i = 0; i < offset; i += 1) cells.push(el('div', { class: 'calendar__day', 'data-empty': 'true' }));

    for (let day = 1; day <= days; day += 1) {
      const date = new Date(month.getFullYear(), month.getMonth(), day);
      const key = dateKey(date);
      const value = entries.get(key);
      const has = value !== undefined;

      const cell = el('button', {
        class: 'calendar__day',
        'data-empty': has ? null : 'true',
        'data-today': key === todayKey ? 'true' : null,
        'data-risk': has ? 'true' : null,
        'aria-selected': String(key === selected),
        disabled: has ? null : true,
        onClick: () => {
          // Marking the selection in place rather than repainting: repainting
          // here replaced the very button handling the click, which lost the
          // element mid-event and made taps intermittent on touch.
          selected = key;
          for (const other of grid.children) {
            other.setAttribute('aria-selected', String(other === cell));
          }
          onSelect(key);
        },
      }, String(day));

      if (has) cell.style.setProperty('--day-risk', colourFor(value));
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
  };

  const shift = (delta) => {
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    paint();
  };

  prev.addEventListener('click', () => shift(-1));
  next.addEventListener('click', () => shift(1));

  paint();

  return {
    node: el('div', { class: 'calendar' }, [
      el('div', { class: 'calendar__head' }, [prev, label, next]),
      el('div', { class: 'calendar__weekdays' }, WEEKDAYS.map((d) => el('span', {}, d))),
      grid,
    ]),
    setMonth(date) {
      month = new Date(date.getFullYear(), date.getMonth(), 1);
      paint();
    },
    select(key) {
      selected = key;
      paint();
    },
    repaint: paint,
  };
}

/* ------------------------------------------------------------------ *
 * Manual (published) outlooks
 * ------------------------------------------------------------------ */

function buildPublishedSection() {
  const status = el('div', { class: 'tiny dim' }, 'Loading published outlooks…');
  const versions = el('select', { class: 'select' });
  const detail = el('div', { class: 'tiny muted' });
  const discussion = el('div', { class: 'tiny dim', hidden: true, style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto' } });
  const calendarHost = el('div');

  let calendar = null;

  const focusNote = el('div', { class: 'tiny dim' });

  /** The outlook currently drawn, so the focus button can act on it. */
  let shown = null;

  /**
   * Draws an outlook.
   *
   * `focus` is false when the panel merely *displays* whichever outlook is valid
   * now: opening this panel must not silently re-base the timeline or change the
   * strike lifespan. Only an explicit selection passes `focus: true`.
   */
  const show = (item, { focus = false } = {}) => {
    const info = published.renderPublished(item);
    if (!info) {
      detail.textContent = 'This outlook has no usable geometry.';
      shown = null;
      focusButton.disabled = true;
      return;
    }
    shown = info;
    focusButton.disabled = false;

    status.textContent = `${info.risk} · version ${info.version} · issued ${formatDateTime(info.issued)}`;
    detail.innerHTML = `Valid ${escapeHtml(formatDateTime(info.validFrom))} → ${escapeHtml(formatDateTime(info.validTo))}` +
      (info.live ? ' <span class="chip chip--live"><span class="chip__dot"></span>in force</span>' : '');
    discussion.textContent = info.discussion || 'No discussion published for this outlook.';

    if (focus) applyFocus(info);
    else focusNote.textContent = 'Select this outlook to point the timeline at its period.';
  };

  const applyFocus = (info) => {
    const window = focusOutlook(info.validFrom, info.validTo, {
      source: SOURCE_MANUAL,
      label: `Manual outlook · ${info.risk}`,
    });
    focusNote.textContent = window ? describeWindow(window) : '';
  };

  const focusButton = el('button', {
    class: 'btn btn--primary btn--block',
    disabled: true,
    onClick: () => { if (shown) applyFocus(shown); },
  }, 'Show this outlook’s period');

  const showDay = (key, options) => {
    const items = published.versionsForDay(key);
    versions.replaceChildren(...items.map((item, i) =>
      el('option', { value: item.id }, `${i === 0 ? 'Latest · ' : ''}v${item.issueVersion || 1} · ${formatDateTime(item.issuedAt || item.validFrom)}`)));
    if (items.length) {
      versions.value = items[0].id;
      show(items[0], options);
    } else {
      published.clearPublished();
      status.textContent = 'No outlook issued for this date.';
      focusNote.textContent = '';
      shown = null;
      focusButton.disabled = true;
    }
  };

  versions.addEventListener('change', () => {
    const item = published.getById(versions.value);
    if (item) show(item, { focus: true });
  });

  const visible = switchRow({
    label: 'Show manual outlook',
    checked: true,
    onChange: (checked) => {
      published.setVisible(checked);
      if (checked) {
        const item = published.getById(versions.value);
        if (item) show(item);
      }
    },
  });

  const opacity = opacityRow({
    label: 'Fill opacity',
    value: 0.12,
    onInput: (value) => published.setOpacity(value),
  });

  const legend = el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
    [1, 2, 3, 4, 5].map((rank) => {
      const risk = publishedRisk(rank);
      return el('span', { class: 'chip' }, [
        el('span', { class: 'chip__dot', style: { background: risk.color } }),
        risk.name,
      ]);
    }));

  // Load asynchronously; the panel stays usable meanwhile.
  published.loadPublishedOutlooks().then((result) => {
    if (!result.ok) {
      status.textContent = `Manual outlooks unavailable — ${result.reason}.`;
      return;
    }
    if (!result.count) {
      status.textContent = 'No manual outlooks have been published.';
      return;
    }

    calendar = buildCalendar({
      index: () => published.calendarIndex(),
      colourFor: (rank) => publishedRisk(rank).color,
      // Picking a day in the calendar is an explicit selection.
      onSelect: (key) => showDay(key, { focus: true }),
    });
    calendarHost.replaceChildren(calendar.node);

    const current = published.latestValidAt(Date.now());
    if (current) {
      const key = dateKey(current.validFrom?.toDate?.() || new Date(current.validFrom));
      calendar.setMonth(new Date(`${key}T12:00:00`));
      calendar.select(key);
      // Display only — opening the panel must not hijack the timeline.
      showDay(key, { focus: false });
    } else {
      status.textContent = 'No manual outlook is valid for the current time.';
    }
  });

  return el('div', { class: 'stack' }, [
    sectionTitle('Manual HOCO'),
    visible.node,
    status,
    versions,
    detail,
    focusButton,
    focusNote,
    calendarHost,
    legend,
    el('button', {
      class: 'btn btn--block',
      onClick: () => { discussion.hidden = !discussion.hidden; },
    }, 'Toggle discussion'),
    discussion,
    disclosure('Display settings', [opacity.node]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Automated runs
 * ------------------------------------------------------------------ */

function buildAutoSection() {
  const status = el('div', { class: 'tiny dim' }, 'Loading automated runs…');
  const runs = el('select', { class: 'select' });
  const meta = el('div', { class: 'tiny muted' });
  const calendarHost = el('div');

  let calendar = null;

  const focusNote = el('div', { class: 'tiny dim' });

  /** The run currently drawn, so the focus button can act on it. */
  let shown = null;

  const applyFocus = (metaData) => {
    const { validFrom, validTo, day } = metaData;
    if (!validFrom || !validTo) {
      focusNote.textContent = 'This run declares no usable validity period, so the timeline was left alone.';
      return;
    }
    const window = focusOutlook(validFrom, validTo, {
      source: SOURCE_AUTO,
      label: `Auto outlook · Day ${day}`,
    });
    // A null result means a manual outlook currently owns the timeline.
    focusNote.textContent = window
      ? describeWindow(window)
      : 'A manual outlook is holding the timeline — release it there first, then select this run again.';
  };

  const focusButton = el('button', {
    class: 'btn btn--primary btn--block',
    disabled: true,
    onClick: () => { if (shown) applyFocus(shown); },
  }, 'Show this run’s period');

  /** `focus` is false while merely displaying the active run — see the manual section. */
  const loadRun = async (key, { focus = false } = {}) => {
    status.textContent = 'Loading run…';
    const result = await auto.loadRun(key);
    if (!result?.ok) {
      status.textContent = result?.reason || 'Could not load that run.';
      focusNote.textContent = '';
      shown = null;
      focusButton.disabled = true;
      return;
    }
    status.textContent = 'Run loaded.';
    meta.innerHTML =
      `Created ${escapeHtml(result.meta.createdLabel)}<br>Valid ${escapeHtml(result.meta.startTime)} – ${escapeHtml(result.meta.endTime)}`;

    shown = result.meta;
    focusButton.disabled = false;

    if (focus) applyFocus(result.meta);
    else focusNote.textContent = 'Select this run to point the timeline at its period.';
  };

  const showDay = (key, options) => {
    const entries = auto.runsForDay(key);
    runs.replaceChildren(...entries.map((entry, i) =>
      el('option', { value: entry.key }, `${i === 0 ? 'Latest · ' : ''}Day ${entry.day} · ${entry.createdLabel}`)));
    if (entries.length) {
      runs.value = entries[0].key;
      loadRun(entries[0].key, options);
    } else {
      auto.clearAuto();
      status.textContent = 'No automated run for this date.';
      focusNote.textContent = '';
      shown = null;
      focusButton.disabled = true;
    }
  };

  runs.addEventListener('change', () => loadRun(runs.value, { focus: true }));

  const visible = switchRow({
    label: 'Show automated outlook',
    checked: false,
    onChange: (checked) => {
      auto.setVisible(checked);
      if (checked && runs.value) loadRun(runs.value);
    },
  });

  const opacity = opacityRow({
    label: 'Fill opacity',
    value: 0.1,
    onInput: (value) => auto.setOpacity(value),
  });

  // Percentage risk gradient legend.
  const gradient = el('div', { class: 'legend-scale' },
    Array.from({ length: 20 }, (_, i) =>
      el('span', { class: 'legend-scale__step', style: { background: riskColour(i * 5) } })));

  auto.loadRunIndex().then((result) => {
    if (!result.ok) {
      status.textContent = `Automated runs unavailable — ${result.reason}.`;
      return;
    }
    if (!result.count) {
      status.textContent = 'No automated runs available.';
      return;
    }

    calendar = buildCalendar({
      index: () => auto.calendarIndex(),
      colourFor: (risk) => riskColour(risk || 0),
      onSelect: (key) => showDay(key, { focus: true }),
    });
    calendarHost.replaceChildren(calendar.node);

    const active = auto.activeRun();
    if (active) {
      calendar.setMonth(new Date(`${active.validKey}T12:00:00`));
      calendar.select(active.validKey);
      // Display only — opening the panel must not hijack the timeline.
      showDay(active.validKey, { focus: false });
    } else {
      status.textContent = 'No automated run is valid for the current time.';
    }
  });

  return el('div', { class: 'stack' }, [
    sectionTitle('Auto HOCO'),
    visible.node,
    status,
    runs,
    meta,
    focusButton,
    focusNote,
    calendarHost,
    el('div', { class: 'legend-group' }, [
      el('div', { class: 'legend-group__title' }, 'Risk of lightning'),
      gradient,
      el('div', { class: 'legend-scale__labels' }, [el('span', {}, '0%'), el('span', {}, '50%'), el('span', {}, '100%')]),
    ]),
    disclosure('Display settings', [opacity.node]),
    el('a', {
      class: 'btn btn--block',
      href: 'https://handry-outlook.github.io/HOCO-V2.0/index.html',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, 'Open detailed forecast ↗'),
  ]);
}

/** Handry Outlook branding for the panel header. */
function outlookBrand() {
  return el('div', { class: 'panel-brand' }, [
    el('img', {
      class: 'panel-brand__icon',
      src: ASSETS.handryIcon,
      alt: '',
      width: 28,
      height: 28,
      decoding: 'async',
    }),
    el('div', {}, [
      el('div', { class: 'panel-brand__title' }, 'Handry Outlook'),
      el('div', { class: 'tiny dim' }, 'Convective outlooks for the UK and Ireland'),
    ]),
  ]);
}

export function buildOutlookPanel() {
  if (typeof firebase === 'undefined') {
    return el('div', { class: 'stack' }, [
      el('p', { class: 'tiny dim' }, 'Outlook feeds need the Firebase SDK, which did not load.'),
    ]);
  }
  return el('div', { class: 'stack' }, [
    outlookBrand(),
    buildPublishedSection(),
    buildAutoSection(),
  ]);
}
