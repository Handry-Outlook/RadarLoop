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
import { MMH_INTERVALS } from '../data/palettes.js';
import { legendStops } from '../layers/radarScale.js';
import { colourForAge } from '../lightning/render.js';
import { isPlotted as accumulationPlotted, legendStops as accumulationStops } from '../tools/accumulation.js';

const AGE_BANDS = [
  { label: 'Newest sixth', fraction: 0.08 },
  { label: '2nd', fraction: 0.25 },
  { label: '3rd', fraction: 0.42 },
  { label: '4th', fraction: 0.58 },
  { label: '5th', fraction: 0.75 },
  { label: 'Oldest', fraction: 0.92 },
];

/** A rate as few characters as it can be read in. */
const format = (mmh) => (mmh >= 10 ? String(Math.round(mmh)) : mmh.toFixed(mmh >= 1 ? 1 : 2));

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
      el('span', {}, format(MMH_INTERVALS[1])),
      el('span', {}, format(MMH_INTERVALS[Math.floor(MMH_INTERVALS.length / 2)])),
      el('span', {}, `${format(MMH_INTERVALS[MMH_INTERVALS.length - 1])}+ mm/h`),
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
    // Shape says the same thing as colour for the band that matters most, so
    // the newest strikes are findable without reading the colours off.
    el('div', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: { background: '#38bdf8' } }),
      el('span', { class: 'dim' }, 'Just arrived'),
    ]),
    el('p', { class: 'tiny dim' }, 'Arrivals are bolts, the rest squares.'),
  ]);
}

/**
 * The nowcast's key, shown only while it is switched on.
 *
 * Three colours mean three different things and none of them is guessable, least
 * of all on a map that already has a warm ramp for strike age and another for
 * rainfall. Hail in particular is the one worth naming: it is a claim about the
 * storm, not a rendering choice.
 */
function nowcastGroup() {
  if (!lightning.nowcast) return null;
  const swatch = (colour) => el('span', {
    class: 'legend-swatch',
    style: { background: 'transparent', border: `3px solid ${colour}`, boxShadow: '0 0 0 1px rgba(2,6,23,.9)' },
  });
  return el('div', { class: 'legend-group' }, [
    el('div', { class: 'legend-group__title' }, 'Storm projection'),
    el('div', { class: 'legend-item' }, [swatch('#22d3ee'), el('span', { class: 'dim' }, 'Tracked storm')]),
    el('div', { class: 'legend-item' }, [swatch('#f8fafc'), el('span', { class: 'dim' }, 'High impact')]),
    el('div', { class: 'legend-item' }, [swatch('#fbbf24'), el('span', { class: 'dim' }, 'Hail possible')]),
    el('p', { class: 'tiny dim' }, 'Solid is where it is now, dashed where it is heading.'),
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
    nowcastGroup(),
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
