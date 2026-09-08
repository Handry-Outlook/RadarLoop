/**
 * The legend.
 *
 * Rebuilt from current state whenever anything that affects it changes, rather
 * than being patched in place from a dozen call sites (the legacy `updateLegend`
 * was defined twice and called from fourteen places, so what it showed depended
 * on which one ran last).
 */

import { byId, el } from '../core/util.js';
import { on, EVENTS } from '../core/bus.js';
import { lightning, slots, LAYER_LABELS } from '../core/state.js';
import { getLayerDef } from '../data/layers.js';
import { legendStops } from '../layers/radarScale.js';
import { colourForAge } from '../lightning/render.js';
import { isPlotted as accumulationPlotted, legendStops as accumulationStops } from '../tools/accumulation.js';

const AGE_BANDS = [
  { label: '0–5%', fraction: 0.02 },
  { label: '5–20%', fraction: 0.1 },
  { label: '20–50%', fraction: 0.35 },
  { label: '50–80%', fraction: 0.65 },
  { label: '80–100%', fraction: 0.9 },
];

function radarScaleGroup() {
  const stops = legendStops();
  return el('div', { class: 'legend-group' }, [
    el('div', { class: 'legend-group__title' }, 'Rainfall rate'),
    el('div', { class: 'legend-scale' }, stops.map((stop) =>
      el('span', {
        class: 'legend-scale__step',
        style: { background: stop.hex, opacity: String(Math.max(0.3, stop.alpha)) },
        title: stop.label,
      }))),
    el('div', { class: 'legend-scale__labels' }, [
      el('span', {}, '0.03'), el('span', {}, '4'), el('span', {}, '256+ mm/h'),
    ]),
  ]);
}

function lightningGroup() {
  if (!lightning.showLayer) return null;
  if (!lightning.colorByAge) {
    return el('div', { class: 'legend-group' }, [
      el('div', { class: 'legend-group__title' }, 'Lightning'),
      el('div', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: { background: '#111111' } }),
        el('span', {}, 'Strike'),
      ]),
    ]);
  }
  return el('div', { class: 'legend-group' }, [
    el('div', { class: 'legend-group__title' }, 'Strike age'),
    ...AGE_BANDS.map((band) => el('div', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: { background: colourForAge(band.fraction) } }),
      el('span', { class: 'dim' }, band.label),
    ])),
  ]);
}

function activeLayersGroup() {
  const items = [];
  for (const [group, slot] of slots) {
    if (!slot.enabled || !slot.type) continue;
    const def = getLayerDef(group, slot.type);
    items.push(el('div', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: { background: 'var(--accent)' } }),
      el('div', { style: { minWidth: '0' } }, [
        el('div', { class: 'truncate' }, def?.label || slot.type),
        el('div', { class: 'tiny dim truncate' }, `${LAYER_LABELS[group] || group}`),
      ]),
    ]));
  }
  if (!items.length) return null;
  return el('div', { class: 'legend-group' }, [
    el('div', { class: 'legend-group__title' }, 'Active layers'),
    ...items,
  ]);
}

function accumulationGroup() {
  if (!accumulationPlotted()) return null;
  return el('div', { class: 'legend-group' }, [
    el('div', { class: 'legend-group__title' }, 'Accumulated rainfall'),
    el('div', { class: 'legend-scale' }, accumulationStops().map((stop) =>
      el('span', { class: 'legend-scale__step', style: { background: stop.colour }, title: stop.label }))),
    el('div', { class: 'legend-scale__labels' }, [
      el('span', {}, '0.5'), el('span', {}, '20'), el('span', {}, '200 mm'),
    ]),
  ]);
}

/** True when a recolourable radar product is active. */
function usesSharedScale() {
  const radar = slots.get('radar');
  return radar?.enabled && (radar.type === 'windy-radar' || radar.type === 'opera-dbzh');
}

export function renderLegend() {
  const body = byId('legend-body');
  if (!body) return;

  const groups = [
    usesSharedScale() ? radarScaleGroup() : null,
    accumulationGroup(),
    lightningGroup(),
    activeLayersGroup(),
  ].filter(Boolean);

  body.replaceChildren(...(groups.length
    ? groups
    : [el('p', { class: 'tiny dim' }, 'No layers active.')]));
}

export function buildLegend() {
  const card = byId('legend');
  const toggle = byId('legend-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const collapsed = card.dataset.collapsed === 'true';
      card.dataset.collapsed = String(!collapsed);
      toggle.textContent = collapsed ? '−' : '+';
    });
  }
  renderLegend();
  on(EVENTS.LEGEND_INVALIDATED, renderLegend);
}

export function toggleLegendVisible() {
  const card = byId('legend');
  if (card) card.hidden = !card.hidden;
}
