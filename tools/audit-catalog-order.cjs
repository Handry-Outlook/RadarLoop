/**
 * What the layer catalog holds against what its drop-lists offer.
 *
 * `__order` is written by hand, so removing a product leaves a name in it that
 * no longer resolves and adding one leaves a product nothing lists. This prints
 * both, per group, alongside the provider each product comes from — which is
 * what the drop-list ordering is meant to follow.
 */
const { readFileSync } = require('node:fs');

const src = readFileSync('src/data/layers.js', 'utf8');

/** The object literal that follows a marker, to its matching brace. */
function literalAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found`);
  let i = text.indexOf('{', start);
  const from = i;
  let depth = 0;
  let quote = null;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c.charCodeAt(0) === 92) i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

// The file is generated data: evaluating it is how to read it faithfully.
const catalog = eval(`(${literalAfter(src, 'export const LAYER_CATALOG =')})`);

const PROVIDERS = [
  ['windy', /windy\.com/],
  ['dtn', /dtn\.com/],
  ['xweather', /aerisapi\.com|aerisweather\.com/],
  ['eumetsat', /eumetsat\.int/],
  ['metoffice', /metoffice/i],
  ['rainviewer', /rainviewer/],
  ['esri', /arcgis\.com/],
];

function providerOf(def) {
  if (!def) return 'missing';
  if (def.kind === 'mapsgl') return 'xweather';
  const url = String(def.url || def.tiles || '');
  for (const [name, re] of PROVIDERS) if (re.test(url)) return name;
  return 'other';
}

let problems = 0;
for (const [group, entries] of Object.entries(catalog)) {
  const keys = Object.keys(entries).filter((k) => k !== '__order');
  const order = entries.__order || [];
  const named = order.filter((e) => typeof e === 'string');
  const headers = order.length - named.length;

  const dangling = named.filter((k) => !keys.includes(k));
  const listed = keys.filter((k) => entries[k].listed);
  const missing = listed.filter((k) => !named.includes(k));

  const byProvider = {};
  for (const k of listed) (byProvider[providerOf(entries[k])] ||= []).push(k);

  problems += dangling.length;
  console.log(`\n${group}  (${keys.length} products, ${listed.length} listed, ${named.length} ordered, ${headers} headers)`);
  console.log(`  ${Object.entries(byProvider).map(([p, v]) => `${p}=${v.length}`).join(' ') || '  (nothing listed)'}`);
  if (dangling.length) console.log(`  ORDER NAMES NOTHING: ${dangling.join(', ')}`);
  // Collected into the trailing section by the ordering pass, not a fault.
  if (missing.length) console.log(`  filed by the ordering pass: ${missing.join(', ')}`);
}
console.log(`\n${problems} problems`);
