/**
 * The Layers panel: what is currently on the map, and in what order.
 *
 * Reads top-down like the map draws it — the first row is the topmost layer.
 * Rows can be dragged to restack, which rewrites the pane z-indexes (and the GL
 * layer order in 3D) rather than re-fetching anything, so reordering is instant.
 *
 * Both pointer dragging and keyboard reordering are supported: a drag-only
 * control is unusable without a mouse, and this is the only way to reach the
 * stacking order.
 */

import { el, byId } from '../core/util.js';
import { emit, on, EVENTS } from '../core/bus.js';
import { slots, LAYER_LABELS } from '../core/state.js';
import { getLayerDef } from '../data/layers.js';
import {
  activeInOrder, describeLayer, layerView, moveLayer, resetLayerOrder,
  setLayerEnabled, setLayerOpacity, setLayerOrder,
} from '../layers/control.js';
import { opacityRow, toast } from './components.js';

/** Accent per group, matching the layer cards. */
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

let listHost = null;
let emptyHost = null;

/* ------------------------------------------------------------------ *
 * Drag reordering
 * ------------------------------------------------------------------ */

/**
 * Installs pointer dragging on the list.
 *
 * Implemented with pointer events and an explicit placeholder rather than HTML5
 * drag-and-drop, which does not fire on touch devices — this panel has to work
 * on the phone layout too.
 */
function installDragging(list) {
  let dragging = null;
  let placeholder = null;
  let offsetY = 0;

  const rowsExcept = (node) => [...list.querySelectorAll('.layer-row')].filter((r) => r !== node);

  const onPointerDown = (event) => {
    const handle = event.target.closest('.layer-row__handle');
    if (!handle) return;
    const row = handle.closest('.layer-row');
    if (!row) return;

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const rect = row.getBoundingClientRect();
    offsetY = event.clientY - rect.top;

    placeholder = el('div', { class: 'layer-row layer-row--placeholder' });
    placeholder.style.height = `${rect.height}px`;

    dragging = row;
    row.classList.add('layer-row--dragging');
    row.style.width = `${rect.width}px`;
    row.style.top = `${rect.top}px`;
    list.insertBefore(placeholder, row);
    list.append(row); // lift out of flow; position: fixed takes over
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    dragging.style.top = `${event.clientY - offsetY}px`;

    // Drop before the first row whose midpoint is below the pointer.
    const target = rowsExcept(dragging).find((row) => {
      const r = row.getBoundingClientRect();
      return event.clientY < r.top + r.height / 2;
    });
    if (target) list.insertBefore(placeholder, target);
    else list.append(placeholder);
  };

  const onPointerUp = () => {
    if (!dragging) return;
    list.insertBefore(dragging, placeholder);
    placeholder.remove();
    dragging.classList.remove('layer-row--dragging');
    dragging.style.width = '';
    dragging.style.top = '';
    dragging = null;
    placeholder = null;

    const order = [...list.querySelectorAll('.layer-row')].map((r) => r.dataset.group);
    setLayerOrder(order);
  };

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('pointercancel', onPointerUp);
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function buildRow(group, index, total) {
  // One accessor for both kinds of entry: catalog slots and the registered
  // overlays (outlooks, drawings) that have no product behind them.
  const view = layerView(group);
  const accent = view.accent || ACCENTS[group] || 'var(--accent)';

  const handle = el('button', {
    class: 'layer-row__handle',
    'aria-label': `Reorder ${view.title}`,
    title: 'Drag to restack — or use the arrow keys',
    onKeyDown: (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (moveLayer(group, event.key === 'ArrowUp' ? -1 : 1)) render();
      }
    },
  }, '⠿');

  const opacity = opacityRow({
    label: '',
    value: view.opacity,
    onInput: (value) => setLayerOpacity(group, value),
  });

  return el('div', {
    class: 'layer-row',
    dataset: { group },
    style: { '--row-accent': accent },
  }, [
    handle,
    el('div', { class: 'layer-row__body' }, [
      el('div', { class: 'layer-row__title truncate' }, view.title),
      el('div', { class: 'layer-row__meta truncate' },
        `${view.meta} · ${index === 0 ? 'top' : (index === total - 1 ? 'bottom' : `#${index + 1}`)}`),
      opacity.node,
    ]),
    el('div', { class: 'layer-row__actions' }, [
      el('button', {
        class: 'btn btn--ghost btn--icon',
        'aria-label': 'Move up',
        disabled: index === 0 || null,
        onClick: () => { if (moveLayer(group, -1)) render(); },
      }, '↑'),
      el('button', {
        class: 'btn btn--ghost btn--icon',
        'aria-label': 'Move down',
        disabled: index === total - 1 || null,
        onClick: () => { if (moveLayer(group, 1)) render(); },
      }, '↓'),
      el('button', {
        class: 'btn btn--ghost btn--icon btn--danger',
        'aria-label': 'Turn off',
        title: 'Turn this layer off',
        onClick: () => setLayerEnabled(group, false),
      }, '✕'),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function render() {
  if (!listHost) return;
  const active = activeInOrder();

  listHost.replaceChildren(...active.map((g, i) => buildRow(g, i, active.length)));
  listHost.hidden = active.length === 0;
  if (emptyHost) emptyHost.hidden = active.length > 0;
}

export function buildLayerManagerPanel() {
  listHost = el('div', { class: 'layer-list' });
  emptyHost = el('p', { class: 'tiny dim' },
    'No layers are switched on. Turn one on from another panel, or search with /.');

  installDragging(listHost);
  render();

  return el('div', { class: 'stack' }, [
    el('p', { class: 'tiny dim' },
      'Everything currently drawn, topmost first. Drag the handle — or use ↑ ↓ — to restack.'),
    emptyHost,
    listHost,
    el('button', {
      class: 'btn btn--block',
      onClick: () => {
        resetLayerOrder();
        render();
        toast('Layer order reset');
      },
    }, 'Reset order'),
  ]);
}

/** Keeps the list in step with changes made anywhere else. */
export function initLayerManager() {
  for (const event of [EVENTS.LAYER_TOGGLED, EVENTS.LAYER_SELECTED, EVENTS.LAYER_ORDER]) {
    on(event, () => render());
  }
}
