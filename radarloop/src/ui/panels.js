/**
 * The slide-over panel and its groups.
 *
 * Groups are declared as data below. The rail, the panel headings and the
 * keyboard shortcuts are all derived from that one declaration, so adding a group
 * is a single entry rather than edits in five places.
 */

import { el, byId, toDateTimeLocal } from '../core/util.js';
import { emit, on, EVENTS } from '../core/bus.js';
import { lightning, runtime, slots, setLightningOption, setPerformanceMode, time, LAYER_LABELS } from '../core/state.js';
import { listLayers } from '../data/layers.js';
import { groupedBasemaps } from '../data/basemaps.js';
import { setBasemap, getBasemap, setReferenceOverlay, invalidateSizeIfChanged } from '../core/map.js';
import { renderAll } from '../layers/renderer.js';
import { selectProduct, setLayerEnabled, setLayerOpacity } from '../layers/control.js';
import * as scale from '../layers/radarScale.js';
import * as timeCtl from '../time/controller.js';
import { refresh as refreshLightning, recolour, setRefreshMinutes } from '../lightning/index.js';
import { resetNowcastHistory } from '../lightning/nowcast.js';
import { disclosure, layerCard, numberField, opacityRow, sectionTitle, selectField, switchRow, toast, dateTimeField } from './components.js';
import { buildOutlookPanel } from './outlookPanel.js';
import { buildToolsPanel } from './toolsPanel.js';
import { buildLayerManagerPanel } from './layerManager.js';
import { refreshTimelineAxis } from './timeline.js';
import { icon } from './icons.js';
import { DEPS } from '../core/deps.js';
import * as synoptic from '../layers/synoptic.js';

/* ------------------------------------------------------------------ *
 * Group declaration
 * ------------------------------------------------------------------ */

export const PANEL_GROUPS = [
  { id: 'layers', icon: 'layers', label: 'Layers', hint: 'What is drawn, and in what order' },
  { id: 'basemap', icon: 'basemap', label: 'Base map', hint: 'Background and reference overlays' },
  { id: 'precip', icon: 'radar', label: 'Radar & satellite', hint: 'Precipitation and cloud imagery', layers: ['radar', 'satellite'] },
  { id: 'air', icon: 'pressure', label: 'Pressure & wind', hint: 'Isobars, fronts and wind', layers: ['isobar', 'surfaceFront', 'wind'] },
  { id: 'lightning', icon: 'lightning', label: 'Lightning', hint: 'UK strikes, density and nowcasts' },
  { id: 'severe', icon: 'severe', label: 'Severe & warnings', hint: 'Nowcasts, storms, rotation and alerts', layers: ['nowcast', 'warning', 'tropicalStorms', 'rotation', 'lightning'] },
  { id: 'fields', icon: 'observations', label: 'Gridded fields', hint: 'Surface, marine, air quality and road conditions', layers: ['observation', 'roadWeather'] },
  { id: 'observations', icon: 'station', label: 'Station observations', hint: 'Live station models: temperature, wind, sky and pressure' },
  { id: 'outlook', icon: 'outlook', label: 'Outlooks', hint: 'Manual and automated HOCO' },
  { id: 'tools', icon: 'tools', label: 'Tools', hint: 'Drawing, imports and export' },
  { id: 'settings', icon: 'settings', label: 'Settings', hint: 'Time, performance and appearance' },
];

/** Accent colour per weather layer group. */
const ACCENTS = {
  radar: 'var(--wx-radar)',
  satellite: 'var(--wx-satellite)',
  isobar: 'var(--wx-pressure)',
  surfaceFront: 'var(--wx-pressure)',
  wind: 'var(--wx-pressure)',
  lightning: 'var(--wx-lightning)',
  nowcast: 'var(--wx-severe)',
  warning: 'var(--wx-severe)',
  tropicalStorms: 'var(--wx-severe)',
  rotation: 'var(--wx-severe)',
  observation: 'var(--wx-outlook)',
};

let activeGroup = null;
/** Remembered so the mobile toggle can reopen what was last shown. */
let lastOpened = 'precip';
const built = new Map();

/* ------------------------------------------------------------------ *
 * Weather layer cards
 * ------------------------------------------------------------------ */

/** Picker entries for a group, preserving the catalog's ordering and headers. */
function optionsFor(group) {
  return listLayers(group).map((entry) =>
    entry.header ? { header: entry.header } : { value: entry.value, label: entry.label },
  );
}

function buildWeatherCard(group) {
  const slot = slots.get(group);
  const options = optionsFor(group);
  if (!options.some((o) => o.value)) return null;

  // Default to the first real product so enabling the toggle shows something —
  // and do the same when the remembered one is no longer offered, which happens
  // when a product is retired between sessions. A `select` cannot display a
  // value that is not among its options: it would render blank and lose the
  // selection at the first interaction.
  const offered = options.filter((o) => o.value).map((o) => o.value);
  if (!slot.type || !offered.includes(slot.type)) slot.type = offered[0] ?? null;

  const extras = [];
  if (group === 'radar') extras.push(buildRadarExtras());

  const card = layerCard({
    group,
    title: LAYER_LABELS[group] || group,
    accent: ACCENTS[group] || 'var(--accent)',
    options,
    value: slot.type,
    enabled: slot.enabled,
    opacity: slot.opacity,
    onToggle: (enabled) => setLayerEnabled(group, enabled),
    onSelect: (value) => selectProduct(group, value),
    onOpacity: (value) => setLayerOpacity(group, value),
    extras,
  });

  built.set(group, card);
  return card.node;
}

/** Radar extras: the shared colour scale and its smoothing, for the two
 * products that arrive as data rather than as a picture. */
function buildRadarExtras() {
  const preview = el('div', { class: 'palette-preview' });
  const swatches = el('div', { class: 'palette-grid' });

  const paint = () => {
    preview.replaceChildren(...scale.legendStops().map((stop) =>
      el('span', { class: 'palette-preview__step', style: { background: stop.hex, opacity: String(Math.max(0.25, stop.alpha)) } })));

    swatches.replaceChildren(...scale.legendStops().map((stop) => {
      const input = el('input', { type: 'color', value: stop.hex });
      input.addEventListener('input', () => {
        scale.setLevelColour(stop.index, input.value);
        paint();
        emit(EVENTS.LEGEND_INVALIDATED);
        renderAll(time.current);
      });
      return el('label', { class: 'palette-swatch' }, [input, el('span', {}, `${stop.value}`)]);
    }));
  };

  const presets = selectField({
    label: 'Preset colour scheme',
    options: Object.entries(scale.presetNames()).map(([value, label]) => ({ value, label })),
    value: scale.getPreset(),
    onChange: (value) => {
      scale.setPreset(value);
      paint();
      emit(EVENTS.LEGEND_INVALIDATED);
      renderAll(time.current);
    },
  });

  const smooth = switchRow({
    label: 'Smooth',
    hint: '',
    checked: scale.isSmoothing(),
    onChange: (checked) => {
      scale.setSmoothing(checked);
      renderAll(time.current);
    },
  });

  paint();

  const panel = disclosure('Rainfall colour scale', [
    el('p', { class: 'tiny dim' },
      ''),
    smooth.node,
    presets.node,
    preview,
    swatches,
    el('button', {
      class: 'btn btn--block',
      onClick: () => {
        scale.resetOverrides();
        paint();
        emit(EVENTS.LEGEND_INVALIDATED);
        renderAll(time.current);
      },
    }, 'Reset custom colours'),
  ]);

  /**
   * Shown only for the products it can act on.
   *
   * These controls colour the data themselves, which is only possible for the
   * two products that arrive as data. For everything else in the radar list the
   * provider has already drawn the picture, and offering a colour editor and a
   * smoothing switch beside one of those is an offer the app cannot keep.
   */
  const sync = () => {
    const slot = slots.get('radar');
    panel.hidden = !scale.usesSharedScale(slot?.type);
  };
  sync();
  on(EVENTS.LAYER_SELECTED, ({ group }) => { if (group === 'radar') sync(); });

  return panel;
}

/* ------------------------------------------------------------------ *
 * Group builders
 * ------------------------------------------------------------------ */

function buildBasemapPanel() {
  const options = [];
  for (const [groupName, entries] of groupedBasemaps()) {
    options.push({ header: groupName });
    for (const entry of entries) options.push({ value: entry.id, label: entry.label });
  }

  const picker = selectField({
    label: 'Background',
    options,
    value: getBasemap(),
    onChange: (value) => setBasemap(value),
  });

  const reference = switchRow({
    label: 'Coastline & labels',
    hint: 'Drawn above the weather layers',
    checked: true,
    onChange: (checked) => setReferenceOverlay(checked),
  });

  return el('div', { class: 'stack' }, [picker.node, reference.node]);
}

function buildLayerGroupPanel(groupIds) {
  const nodes = groupIds.map(buildWeatherCard).filter(Boolean);
  return el('div', { class: 'stack' }, nodes);
}

function buildLightningPanel() {
  const nodes = [];

  nodes.push(sectionTitle('Strikes'));
  nodes.push(switchRow({
    label: 'Show strikes',
    hint: 'UK strike detection',
    checked: lightning.showLayer,
    onChange: (checked) => {
      setLightningOption('showLayer', checked);
      refreshLightning({ force: true });
    },
  }).node);

  nodes.push(switchRow({
    label: 'Colour by age',
    hint: 'Newest strikes gold, oldest indigo',
    checked: lightning.colorByAge,
    onChange: (checked) => {
      setLightningOption('colorByAge', checked);
      recolour();
    },
  }).node);

  const lifespan = numberField({
    label: 'Strike lifespan',
    unit: 'hours',
    value: lightning.lifespanHours,
    min: 0.1,
    step: 0.1,
    onChange: (value) => {
      setLightningOption('lifespanHours', value);
      refreshLightning({ force: true });
    },
  });
  // Focusing an outlook sets the lifespan to that window's length; reflect it.
  on(EVENTS.LIGHTNING_OPTIONS, () => {
    lifespan.input.value = String(lightning.lifespanHours);
  });
  nodes.push(lifespan.node);

  nodes.push(switchRow({
    label: 'Show every strike loaded',
    hint: 'Ignores the age window, including inside a filtered period',
    checked: lightning.showAll,
    onChange: (checked) => {
      lightning.showAll = checked;
      timeCtl.stop();
      refreshLightning({ force: true });
    },
  }).node);

  nodes.push(sectionTitle('Density'));

  const heatBlur = opacityRow({
    label: 'Blur',
    value: lightning.heatmapBlur,
    min: 1,
    max: 50,
    step: 1,
    format: (v) => String(Math.round(v)),
    onInput: (value) => {
      lightning.heatmapBlur = value;
      refreshLightning({ force: true });
    },
  });
  nodes.push(switchRow({
    label: 'Heatmap',
    hint: 'Strike density surface',
    checked: lightning.heatmap,
    onChange: async (checked) => {
      // The heat plugin is fetched the first time the surface is asked for.
      if (checked) await DEPS.heat().catch(() => {});
      lightning.heatmap = checked;
      refreshLightning({ force: true });
    },
  }).node, heatBlur.node);

  const counterDensity = opacityRow({
    label: 'Grid',
    value: lightning.counterDensity,
    min: 1,
    max: 100,
    step: 1,
    format: (v) => String(Math.round(v)),
    onInput: (value) => {
      lightning.counterDensity = value;
      refreshLightning({ force: true });
    },
  });
  nodes.push(switchRow({
    label: 'Cell counter',
    hint: 'Strike counts per grid cell',
    checked: lightning.counter,
    onChange: (checked) => {
      lightning.counter = checked;
      refreshLightning({ force: true });
    },
  }).node, counterDensity.node);

  nodes.push(sectionTitle('Nowcast'));
  nodes.push(switchRow({
    label: 'Storm projections',
    hint: 'Projected cell motion and footprint',
    checked: lightning.nowcast,
    onChange: (checked) => {
      // The hull used to come from turf, 590 KB fetched on demand; it is twenty
      // lines in the nowcast now, so there is nothing to wait for.
      setLightningOption('nowcast', checked);
      resetNowcastHistory();
      refreshLightning({ force: true });
    },
  }).node);

  nodes.push(opacityRow({
    label: 'Min confidence',
    value: lightning.nowcastConfidence,
    min: 0,
    max: 1,
    step: 0.01,
    onInput: (value) => {
      lightning.nowcastConfidence = value;
      refreshLightning({ force: true });
    },
  }).node);

  nodes.push(switchRow({
    label: 'Thunder cue',
    hint: 'Short rumble on new strikes in view',
    checked: lightning.sound,
    // Through setLightningOption so it persists: the cue silently reset to off
    // on every reload, which is most of why it never seemed to work.
    onChange: (checked) => setLightningOption('sound', checked),
  }).node);

  return el('div', { class: 'stack' }, nodes);
}

/**
 * Surface observations: station models from the Synoptic feed.
 *
 * The controls are deliberately few. A station plot is a fixed piece of
 * notation — what it shows is not a preference — so the panel offers the
 * choices that actually change what you can read: units, how densely the plots
 * are packed, how stale an observation may be, and how often to re-poll.
 */
function buildObservationsPanel() {
  const nodes = [sectionTitle('Surface observations')];

  const status = el('div', { class: 'tiny dim' }, 'Not loaded.');

  const paint = () => {
    if (!synoptic.options.enabled) {
      status.textContent = 'Switched off.';
      return;
    }
    const at = synoptic.lastUpdated();
    const when = at ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
    const plotted = synoptic.plottedCount();
    const held = synoptic.stationCount();
    status.textContent = `${plotted} of ${held} stations plotted · updated ${when}`
      + (synoptic.isClamped() ? ' · zoom in for full coverage' : '');
  };

  on(EVENTS.OBSERVATIONS_UPDATED, paint);

  nodes.push(switchRow({
    label: 'Show station models',
    hint: 'Temperature, dew point, wind, sky cover and pressure',
    checked: synoptic.options.enabled,
    onChange: (checked) => {
      setLayerEnabled('observations', checked);
      paint();
    },
  }).node);

  nodes.push(status);

  nodes.push(selectField({
    label: 'Temperature',
    options: [{ value: 'F', label: 'Fahrenheit' }, { value: 'C', label: 'Celsius' }],
    value: synoptic.options.tempUnit,
    // A unit change is a different request, not a different drawing.
    onChange: (value) => {
      synoptic.options.tempUnit = value;
      synoptic.applyOptions({ refetch: true });
    },
  }).node);

  nodes.push(selectField({
    label: 'Wind speed',
    options: [
      { value: 'kts', label: 'Knots' },
      { value: 'mph', label: 'Miles per hour' },
      { value: 'ms', label: 'Metres per second' },
    ],
    value: synoptic.options.windUnit,
    onChange: (value) => {
      synoptic.options.windUnit = value;
      synoptic.applyOptions({ refetch: true });
    },
  }).node);

  nodes.push(numberField({
    label: 'Plot spacing',
    unit: 'px',
    value: synoptic.options.spacing,
    min: 28,
    step: 4,
    onChange: (value) => {
      synoptic.options.spacing = Math.max(28, value);
      synoptic.applyOptions();
      paint();
    },
  }).node);

  nodes.push(numberField({
    label: 'Ignore reports older than',
    unit: 'minutes',
    value: synoptic.options.maxAgeMinutes,
    min: 15,
    step: 15,
    onChange: (value) => {
      synoptic.options.maxAgeMinutes = Math.max(15, value);
      synoptic.applyOptions({ refetch: true });
    },
  }).node);

  nodes.push(numberField({
    label: 'Refresh every',
    unit: 'minutes',
    value: synoptic.options.refreshMinutes,
    min: 1,
    step: 1,
    onChange: (value) => {
      synoptic.options.refreshMinutes = Math.max(1, value);
      synoptic.applyOptions();
    },
  }).node);

  nodes.push(switchRow({
    label: 'Pressure',
    hint: 'Sea-level pressure, coded to three digits',
    checked: synoptic.options.showPressure,
    onChange: (checked) => {
      synoptic.options.showPressure = checked;
      synoptic.applyOptions();
    },
  }).node);

  nodes.push(switchRow({
    label: 'Station identifier',
    checked: synoptic.options.showIdentifier,
    onChange: (checked) => {
      synoptic.options.showIdentifier = checked;
      synoptic.applyOptions();
    },
  }).node);

  nodes.push(el('button', {
    class: 'btn btn--block',
    onClick: () => {
      synoptic.applyOptions({ refetch: true });
      toast('Refreshing observations');
    },
  }, 'Refresh now'));

  paint();
  return el('div', { class: 'stack' }, nodes);
}

function buildSettingsPanel() {
  const nodes = [];

  nodes.push(sectionTitle('Time window'));

  const start = dateTimeField({ label: 'Start', value: toDateTimeLocal(time.current - 3 * 3600 * 1000) });
  const end = dateTimeField({ label: 'End', value: toDateTimeLocal(time.current) });
  const removeButton = el('button', {
    class: 'btn',
    hidden: !timeCtl.hasFilter() || null,
    onClick: () => {
      timeCtl.clearFilter();
      refreshLightning({ force: true });
      toast('Time filter removed');
    },
  }, 'Clear filter');

  nodes.push(start.node, end.node, el('div', { class: 'row' }, [
    el('button', {
      class: 'btn btn--primary',
      onClick: () => {
        const from = start.input.value ? new Date(start.input.value) : null;
        const to = end.input.value ? new Date(end.input.value) : null;
        if (!timeCtl.applyFilter(from, to)) {
          toast('Enter a valid range with the end after the start', { tone: 'error' });
          return;
        }
        refreshLightning({ force: true });
        toast('Timeline set to the filtered window', { tone: 'success' });
      },
    }, 'Apply filter'),
    removeButton,
  ]));

  // Keep the inputs and the clear button in step with whatever owns the
  // timeline, including an outlook selected from the outlook panel.
  on(EVENTS.TIME_FOCUS, (payload) => {
    removeButton.hidden = !payload;
    if (!payload) return;
    start.input.value = toDateTimeLocal(payload.start);
    end.input.value = toDateTimeLocal(payload.end);
  });

  nodes.push(numberField({
    label: 'Scrubber span',
    unit: 'hours',
    value: time.historyHours,
    min: 1,
    max: 720,
    step: 1,
    onChange: (value) => {
      timeCtl.setHistorySpan(value);
      refreshTimelineAxis();
      refreshLightning({ force: true });
    },
  }).node);
  nodes.push(el('p', { class: 'tiny dim' },
    'How far back the scrubber reaches. Longer spans keep more strike history in memory.'));

  nodes.push(sectionTitle('Automation'));

  nodes.push(selectField({
    label: 'Refresh interval',
    options: [
      { value: '0', label: 'Off' },
      { value: '0.167', label: '10 seconds' },
      { value: '0.5', label: '30 seconds' },
      { value: '1', label: '1 minute' },
      { value: '5', label: '5 minutes' },
      { value: '10', label: '10 minutes' },
    ],
    value: String(time.refreshMinutes),
    onChange: (value) => setRefreshMinutes(Number(value)),
  }).node);

  nodes.push(switchRow({
    label: 'Follow latest',
    hint: 'Keep the scrubber pinned to the newest frame',
    checked: time.autoLatest,
    onChange: (checked) => timeCtl.setAutoLatest(checked),
  }).node);

  nodes.push(sectionTitle('Performance'));

  const status = el('p', { class: 'tiny dim' });
  const updateStatus = () => {
    status.textContent = runtime.lowEnd
      ? 'Reduced detail: fewer nowcast clusters, smaller strike ceiling, lower concurrency.'
      : 'Full detail: all nowcast clusters and the full strike ceiling.';
  };
  updateStatus();

  nodes.push(selectField({
    label: 'Rendering mode',
    options: [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'high', label: 'Quality' },
      { value: 'low', label: 'Fast (low-end devices)' },
    ],
    value: runtime.performanceMode,
    onChange: (value) => {
      setPerformanceMode(value);
      applyPerformanceMode();
      updateStatus();
      refreshLightning({ force: true });
    },
  }).node, status);

  nodes.push(sectionTitle('Diagnostics'));
  const stats = el('pre', { class: 'tiny mono dim', style: { margin: '0', whiteSpace: 'pre-wrap' } });
  const paintStats = () => {
    const s = runtime.stats;
    stats.textContent =
      `frames rendered  ${s.rendered}\n` +
      `frames skipped   ${s.skippedFrames}\n` +
      `frames failed    ${s.failed}\n` +
      `network probes   ${s.probes}\n` +
      `cache hits       ${s.cacheHits}\n` +
      `strikes loaded   ${lightning.all.length}`;
  };
  paintStats();
  setInterval(paintStats, 2000);
  nodes.push(stats);

  return el('div', { class: 'stack' }, nodes);
}

/** Applies the auto/high/low rendering mode to runtime flags. */
export function applyPerformanceMode() {
  const mode = runtime.performanceMode;
  if (mode === 'low') runtime.lowEnd = true;
  else if (mode === 'high') runtime.lowEnd = false;
  else {
    const cores = Number(navigator.hardwareConcurrency || 4);
    const memory = Number(navigator.deviceMemory || 4);
    runtime.lowEnd = cores <= 4 || memory <= 4;
  }
}

/* ------------------------------------------------------------------ *
 * Panel shell
 * ------------------------------------------------------------------ */

function buildGroupContent(id) {
  const group = PANEL_GROUPS.find((g) => g.id === id);
  if (!group) return el('div');

  switch (id) {
    case 'layers': return buildLayerManagerPanel();
    case 'basemap': return buildBasemapPanel();
    case 'lightning': return buildLightningPanel();
    case 'outlook': return buildOutlookPanel();
    case 'observations': return buildObservationsPanel();
    case 'tools': return buildToolsPanel();
    case 'settings': return buildSettingsPanel();
    default: return buildLayerGroupPanel(group.layers || []);
  }
}

const contentCache = new Map();

export function openGroup(id) {
  const panel = byId('panel');
  const title = byId('panel-title');
  const subtitle = byId('panel-subtitle');
  const body = byId('panel-body');
  const group = PANEL_GROUPS.find((g) => g.id === id);
  if (!panel || !group) return;

  if (activeGroup === id) return closePanel();

  activeGroup = id;
  lastOpened = id;
  title.textContent = group.label;
  subtitle.textContent = group.hint;

  // Built once and kept, so panel state (open disclosures, scroll) survives.
  if (!contentCache.has(id)) contentCache.set(id, buildGroupContent(id));
  body.replaceChildren(contentCache.get(id));

  panel.hidden = false;
  syncRail();
  requestAnimationFrame(invalidateSizeIfChanged);
}

export function closePanel() {
  const panel = byId('panel');
  if (panel) panel.hidden = true;
  activeGroup = null;
  syncRail();
  requestAnimationFrame(invalidateSizeIfChanged);
}

export const currentGroup = () => activeGroup;
export const lastOpenedGroup = () => lastOpened;

/** Marks the selected group and shows which groups have an active layer. */
export function syncRail() {
  for (const button of document.querySelectorAll('.rail__btn')) {
    const id = button.dataset.group;
    button.setAttribute('aria-selected', String(id === activeGroup));

    const group = PANEL_GROUPS.find((g) => g.id === id);
    const active = (group?.layers || []).some((layerGroup) => slots.get(layerGroup)?.enabled) ||
      (id === 'lightning' && lightning.showLayer);
    button.dataset.active = String(!!active);
  }
}

export function buildRail() {
  const rail = byId('rail');
  if (!rail) return;

  rail.replaceChildren(...PANEL_GROUPS.flatMap((group, index) => {
    const button = el('button', {
      class: 'rail__btn',
      dataset: { group: group.id },
      'data-tip': group.label,
      'aria-selected': 'false',
      'aria-label': group.label,
      onClick: () => openGroup(group.id),
    }, icon(group.icon));

    // Visual break before the non-layer groups.
    const needsDivider = group.id === 'outlook';
    return needsDivider ? [el('div', { class: 'rail__divider' }), button] : [button];
  }));

  syncRail();
}

/** Reflects external layer changes (search, restore) back into the cards. */
export function syncCards() {
  for (const [group, card] of built) {
    const slot = slots.get(group);
    if (!slot) continue;
    card.toggle.checked = slot.enabled;
    card.body.hidden = !slot.enabled;
    card.node.dataset.active = String(slot.enabled);
    if (slot.type) card.select.value = slot.type;
    card.opacity.value = String(slot.opacity);
  }
  syncRail();
}

// syncCards, not syncRail: a layer can be switched off from the layer-order tab
// or by a share link as well as from its own card, and only the rail was being
// brought back into line — the card kept showing the switch on.
on(EVENTS.LAYER_TOGGLED, syncCards);
on(EVENTS.LAYER_SELECTED, syncCards);
