/**
 * Layer search.
 *
 * The catalog holds 169 products across eleven groups. In the legacy build the
 * only way to reach one was to know which of eleven `<select>` elements held it
 * and scroll a list of up to 54 options. Search makes the catalog navigable:
 * type any part of a product name and pick it directly.
 */

import { byId, el, debounce } from '../core/util.js';
import { emit, EVENTS } from '../core/bus.js';
import { LAYER_LABELS } from '../core/state.js';
import { LAYER_CATALOG } from '../data/layers.js';
import { selectProduct } from '../layers/control.js';
import { syncCards, syncRail } from './panels.js';
export { selectProduct };

/** Flat, searchable index of every selectable product. */
const INDEX = (() => {
  const entries = [];
  for (const [group, defs] of Object.entries(LAYER_CATALOG)) {
    for (const [value, def] of Object.entries(defs)) {
      if (value === '__order' || !def.listed) continue;
      entries.push({
        group,
        value,
        label: def.label,
        groupLabel: LAYER_LABELS[group] || group,
        haystack: `${def.label} ${LAYER_LABELS[group] || group} ${value}`.toLowerCase(),
      });
    }
  }
  return entries;
})();

/** Subsequence match, so "ukrain" finds "UK High Resolution Rainfall". */
function score(entry, query) {
  const hay = entry.haystack;
  const exact = hay.indexOf(query);
  if (exact === 0) return 1000;
  if (exact > 0) return 500 - exact;

  let cursor = 0;
  let gaps = 0;
  for (const ch of query) {
    const next = hay.indexOf(ch, cursor);
    if (next < 0) return -1;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 200 - gaps;
}

function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return INDEX
    .map((entry) => ({ entry, rank: score(entry, q) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 12)
    .map((row) => row.entry);
}


export function buildSearch() {
  const input = byId('layer-search');
  const results = byId('search-results');
  if (!input || !results) return;

  let items = [];
  let cursor = -1;

  const close = () => {
    results.hidden = true;
    cursor = -1;
  };

  const paint = () => {
    if (!items.length) {
      results.replaceChildren(el('div', { class: 'search__empty' }, 'No matching layers'));
      results.hidden = false;
      return;
    }
    results.replaceChildren(...items.map((entry, index) =>
      el('button', {
        class: 'search__item',
        'aria-selected': String(index === cursor),
        onClick: () => {
          selectProduct(entry.group, entry.value);
          input.value = '';
          close();
        },
      }, [
        el('span', { class: 'truncate' }, entry.label),
        el('span', { class: 'search__item-group' }, entry.groupLabel),
      ])));
    results.hidden = false;
  };

  const run = debounce(() => {
    items = search(input.value);
    cursor = items.length ? 0 : -1;
    if (!input.value.trim()) close();
    else paint();
  }, 90);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => {
    if (input.value.trim()) paint();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
      return;
    }
    if (!items.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = (cursor + 1) % items.length;
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = (cursor - 1 + items.length) % items.length;
      paint();
    } else if (event.key === 'Enter' && cursor >= 0) {
      event.preventDefault();
      selectProduct(items[cursor].group, items[cursor].value);
      input.value = '';
      close();
      input.blur();
    }
  });

  document.addEventListener('click', (event) => {
    if (!results.contains(event.target) && event.target !== input) close();
  });

  // "/" focuses search, the way it works in most tools.
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    event.preventDefault();
    input.focus();
  });
}

export const catalogSize = () => INDEX.length;
