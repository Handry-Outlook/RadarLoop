/**
 * Small UI builders shared by every panel.
 *
 * The legacy markup repeated the same ~15-line block for each of the eleven layer
 * controls, with inline `onchange="toggleLayer('radar', this.checked)"` handlers.
 * Building them from data means one definition and no chance of the eleventh copy
 * drifting from the first.
 */

import { el } from '../core/util.js';

let idCounter = 0;
const uid = (prefix) => `${prefix}-${++idCounter}`;

/** A labelled on/off switch. */
export function switchRow({ label, hint, checked = false, onChange, id = uid('sw') }) {
  const input = el('input', { type: 'checkbox', id, checked: checked || null });
  input.addEventListener('change', () => onChange?.(input.checked));

  return {
    input,
    node: el('div', { class: 'switch-row' }, [
      el('div', {}, [
        el('label', { class: 'switch-row__label', for: id }, label),
        hint ? el('div', { class: 'switch-row__hint' }, hint) : null,
      ]),
      el('span', { class: 'switch' }, [input, el('span', { class: 'switch__track' })]),
    ]),
  };
}

/** A `<select>` built from `{ value, label }` entries and `{ header }` separators. */
export function selectField({ label, options, value, onChange, id = uid('sel') }) {
  const select = el('select', { class: 'select', id });

  let group = null;
  for (const option of options) {
    if (option.header) {
      group = el('optgroup', { label: option.header });
      select.append(group);
      continue;
    }
    const node = el('option', { value: option.value }, option.label);
    (group || select).append(node);
  }
  if (value !== undefined && value !== null) select.value = value;
  select.addEventListener('change', () => onChange?.(select.value));

  return {
    select,
    node: label
      ? el('div', { class: 'field' }, [el('label', { class: 'field__label', for: id }, label), select])
      : select,
  };
}

/** A percentage slider with a live readout. */
export function opacityRow({ label = 'Opacity', value = 0.8, min = 0, max = 1, step = 0.05, format, onInput }) {
  const input = el('input', { type: 'range', class: 'range', min, max, step, value });
  const output = el('output', {}, (format || ((v) => `${Math.round(v * 100)}%`))(value));

  input.addEventListener('input', () => {
    const next = Number(input.value);
    output.textContent = (format || ((v) => `${Math.round(v * 100)}%`))(next);
    onInput?.(next);
  });

  return {
    input,
    output,
    node: el('div', { class: 'opacity-row' }, [el('span', {}, label), input, output]),
  };
}

/** A number input with an optional unit suffix. */
export function numberField({ label, value, min, max, step = 1, unit, onChange, id = uid('num') }) {
  const input = el('input', { type: 'number', class: 'input', value, min, max, step, id });
  input.addEventListener('change', () => onChange?.(Number(input.value)));

  return {
    input,
    node: el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id }, unit ? `${label} (${unit})` : label),
      input,
    ]),
  };
}

export function dateTimeField({ label, value, onChange, id = uid('dt') }) {
  const input = el('input', { type: 'datetime-local', class: 'input', value: value || '', id });
  input.addEventListener('change', () => onChange?.(input.value ? new Date(input.value) : null));

  return {
    input,
    node: el('div', { class: 'field' }, [el('label', { class: 'field__label', for: id }, label), input]),
  };
}

/** A collapsible advanced block. */
export function disclosure(summary, children, { open = false } = {}) {
  return el('details', { class: 'disclosure', open: open || null }, [
    el('summary', {}, summary),
    el('div', { class: 'disclosure__body' }, children),
  ]);
}

export const sectionTitle = (text) => el('h4', { class: 'section-title' }, text);

/**
 * The standard layer card: a toggle, a product picker and an opacity slider,
 * plus any extra content a specific layer needs.
 */
export function layerCard({ group, title, accent, options, value, enabled, opacity, onToggle, onSelect, onOpacity, extras = [] }) {
  const body = el('div', { class: 'card__body', hidden: !enabled || null });

  const picker = selectField({ options, value, onChange: onSelect });
  const opacityControl = opacityRow({ value: opacity, onInput: onOpacity });

  body.append(picker.node, opacityControl.node, ...extras);

  const toggle = el('input', { type: 'checkbox', checked: enabled || null, id: `toggle-${group}` });
  const card = el('div', { class: 'card', dataset: { group, active: String(!!enabled) } }, [
    el('div', { class: 'card__head' }, [
      el('span', { class: 'card__accent', style: { '--card-accent': accent } }),
      el('div', { class: 'card__title' }, title),
      el('span', { class: 'switch' }, [toggle, el('span', { class: 'switch__track' })]),
    ]),
    body,
  ]);
  card.style.setProperty('--card-accent', accent);

  toggle.addEventListener('change', () => {
    body.hidden = !toggle.checked;
    card.dataset.active = String(toggle.checked);
    onToggle?.(toggle.checked);
  });

  return { node: card, toggle, select: picker.select, opacity: opacityControl.input, body };
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

let toastHost = null;

/**
 * Shows a transient message.
 * `action` adds an inline button — use it when the message tells the user
 * something is wrong that they could fix in one click.
 */
export function toast(message, { tone = 'info', duration = 3200, action = null } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts' });
    document.body.append(toastHost);
  }

  const dismiss = () => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  };

  const node = el('div', { class: 'toast', dataset: { tone } }, [
    el('span', {}, message),
    action
      ? el('button', {
          class: 'toast__action',
          onClick: () => {
            action.onClick?.();
            dismiss();
          },
        }, action.label)
      : null,
  ]);

  toastHost.append(node);
  setTimeout(dismiss, duration);
  return node;
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

export function modal({ title, body, actions = [], onClose }) {
  const scrim = el('div', { class: 'scrim' });

  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('header', { class: 'modal__head' }, [
      el('h3', { class: 'modal__title' }, title),
      el('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Close', onClick: close }, '✕'),
    ]),
    el('div', { class: 'modal__body scroll-thin' }, body),
    actions.length
      ? el('footer', { class: 'modal__foot' }, actions.map((action) =>
          el('button', {
            class: `btn ${action.primary ? 'btn--primary' : ''}`,
            onClick: () => {
              if (action.onClick?.() !== false) close();
            },
          }, action.label)))
      : null,
  ]);

  scrim.append(dialog);
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);

  return { close, node: dialog };
}
