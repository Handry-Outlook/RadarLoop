/**
 * Bundles the modular source into one standalone `dist/radarloop.html`.
 *
 * Zero dependencies by design — this is a small, explicit ES-module bundler that
 * does exactly what this project needs:
 *   - resolves the import graph from src/main.js,
 *   - orders modules by dependency (post-order depth-first),
 *   - rewrites import/export statements into assignments against a module table,
 *   - inlines the CSS and the accumulation worker.
 *
 * The output opens from `file://`, which the ES-module version cannot.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/* ------------------------------------------------------------------ *
 * Module graph
 * ------------------------------------------------------------------ */

const IMPORT_RE = /^\s*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_FROM_RE = /^\s*export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

const moduleId = (file) => relative(srcDir, file).replace(/\\/g, '/');

function readModule(file) {
  return readFileSync(file, 'utf8');
}

function resolveImport(spec, fromFile) {
  if (!spec.startsWith('.')) return null; // bare specifier — a global library
  const target = resolve(dirname(fromFile), spec);
  return existsSync(target) ? target : `${target}.js`;
}

/** Depth-first post-order so a module is emitted after everything it imports. */
function collect(entry) {
  const order = [];
  const seen = new Set();

  const visit = (file) => {
    const id = moduleId(file);
    if (seen.has(id)) return;
    seen.add(id);

    const source = readModule(file);
    const specs = new Set();
    for (const match of source.matchAll(IMPORT_RE)) specs.add(match[2]);
    for (const match of source.matchAll(EXPORT_FROM_RE)) specs.add(match[2]);

    for (const spec of specs) {
      const target = resolveImport(spec, file);
      if (target && existsSync(target)) visit(target);
    }
    order.push({ id, file, source });
  };

  visit(entry);
  return order;
}

/* ------------------------------------------------------------------ *
 * Transform
 * ------------------------------------------------------------------ */

/** Splits `a, b as c` into `[{ imported, local }]`. */
function parseBindings(clause) {
  return clause.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
    return { imported, local: local || imported };
  });
}

/**
 * Rewrites one module into a factory body.
 *
 * Imports become destructuring from the module table; exports become properties
 * on the module's own export object. Live bindings are preserved for the cases
 * this codebase relies on (mutable `export let map` in core/map.js) by exporting
 * getters.
 */
function transform(mod) {
  let code = mod.source;

  // The bundle is a classic script, where `import.meta` is a syntax error even on
  // a branch that never executes. Modules use it only to locate the worker, and
  // the bundled build takes the Blob-URL path instead.
  code = code.replace(/import\.meta\.url/g, 'location.href');
  const exports = [];       // { exported, local }
  const reexports = [];     // { from, imported, exported }
  const liveBindings = new Set();

  // import ... from '...'
  code = code.replace(IMPORT_RE, (full, clause, spec) => {
    if (!spec.startsWith('.')) return ''; // globals stay global
    const target = `__mod('${normaliseSpec(spec, mod)}')`;
    if (!clause) return '';

    const trimmed = clause.trim();
    const namespace = trimmed.match(/^\*\s+as\s+(\w+)$/);
    if (namespace) return `const ${namespace[1]} = ${target};`;

    const named = trimmed.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const bindings = parseBindings(named[1]);
      return `const { ${bindings.map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`)).join(', ')} } = ${target};`;
    }

    // default or mixed — unused in this codebase, but handled for completeness
    const mixed = trimmed.match(/^(\w+)\s*,\s*\{([\s\S]*)\}$/);
    if (mixed) {
      const bindings = parseBindings(mixed[2]);
      return `const ${mixed[1]} = ${target}.default; const { ${bindings.map((b) => `${b.imported}: ${b.local}`).join(', ')} } = ${target};`;
    }
    return `const ${trimmed} = ${target}.default;`;
  });

  // export { a, b as c } from './x.js'
  code = code.replace(EXPORT_FROM_RE, (full, clause, spec) => {
    for (const binding of parseBindings(clause)) {
      reexports.push({ from: normaliseSpec(spec, mod), imported: binding.imported, exported: binding.local });
    }
    return '';
  });

  // export { a, b as c }
  code = code.replace(/^\s*export\s+\{([^}]*)\}\s*;?\s*$/gm, (full, clause) => {
    for (const binding of parseBindings(clause)) {
      exports.push({ exported: binding.local, local: binding.imported });
    }
    return '';
  });

  // export const/let/var/function/class/async function
  code = code.replace(
    /^(\s*)export\s+(async\s+function\s*\*?|function\s*\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm,
    (full, indent, kind, name) => {
      exports.push({ exported: name, local: name });
      if (kind === 'let' || kind === 'var') liveBindings.add(name);
      return `${indent}${kind} ${name}`;
    },
  );

  // export default
  code = code.replace(/^\s*export\s+default\s+/gm, 'const __default = ');
  if (/const __default =/.test(code)) exports.push({ exported: 'default', local: '__default' });

  // A mutable export is a *live binding* under native ES modules. This bundler
  // resolves imports by destructuring, which snapshots the value at module-init
  // time, so a binding reassigned later would leave every importer holding the
  // initial value. Rather than emit something subtly wrong, refuse to build.
  // (See core/map.js: `map` is a const created at module init for this reason.)
  if (liveBindings.size) {
    throw new Error(
      `${mod.id} exports mutable binding(s) [${[...liveBindings].join(', ')}]. ` +
      'Export a const, or expose the value through an accessor function.',
    );
  }

  const assignments = exports.map(({ exported, local }) => `__exports.${exported} = ${local};`);

  for (const { from, imported, exported } of reexports) {
    assignments.push(
      `Object.defineProperty(__exports, '${exported}', { get: () => __mod('${from}').${imported}, enumerable: true });`,
    );
  }

  return `__define('${mod.id}', (__exports, __mod) => {\n${code}\n${assignments.join('\n')}\n});`;
}

function normaliseSpec(spec, mod) {
  const target = resolveImport(spec, mod.file);
  return moduleId(target);
}

/* ------------------------------------------------------------------ *
 * Assemble
 * ------------------------------------------------------------------ */

function build() {
  const entry = join(srcDir, 'main.js');
  const all = collect(entry);
  const modules = all.filter((m) => !m.id.endsWith('.worker.js'));

  // Workers are inlined as strings and started from Blob URLs, because a
  // single-file build has no separate worker script to fetch.
  //
  // They are found by scanning rather than by following imports: a worker is
  // referenced through `new Worker(new URL(...))`, which the module graph never
  // sees. Keying them by basename means adding one needs no change here.
  const workerEntries = readdirSync(srcDir, { recursive: true })
    .map((name) => String(name).split(sep).join('/'))
    .filter((name) => name.endsWith('.worker.js'))
    .map((name) => [name.split('/').pop(), readFileSync(join(srcDir, name), 'utf8')]);

  if (!workerEntries.length) throw new Error('no *.worker.js sources found under src/');

  const bodies = modules.map(transform).join('\n\n');

  const runtime = `
(() => {
  'use strict';
  const __factories = new Map();
  const __cache = new Map();
  const __define = (id, factory) => __factories.set(id, factory);
  const __mod = (id) => {
    if (__cache.has(id)) return __cache.get(id);
    const factory = __factories.get(id);
    if (!factory) throw new Error('Module not bundled: ' + id);
    const exports = {};
    __cache.set(id, exports);
    factory(exports, __mod);
    return exports;
  };

  // Worker sources, inlined for the single-file build.
  const __workerSources = ${JSON.stringify(Object.fromEntries(workerEntries))};
  window.__RADARLOOP_WORKERS__ = Object.fromEntries(
    Object.entries(__workerSources).map(([name, source]) => [
      name,
      URL.createObjectURL(new Blob([source], { type: 'application/javascript' })),
    ]),
  );

${bodies}

  __mod('main.js');
})();`;

  const css = ['tokens.css', 'base.css', 'app.css']
    .map((name) => readFileSync(join(srcDir, 'styles', name), 'utf8'))
    .join('\n\n');

  let html = readFileSync(join(root, 'index.html'), 'utf8');

  // Function replacements are mandatory here: a *string* replacement treats `$$`,
  // `$&` and `$1` as substitution patterns, which silently corrupts identifiers
  // such as `$$` in core/util.js and any `$&` inside the CSS or worker source.
  html = html
    .replace(/\s*<link rel="stylesheet" href="src\/styles\/[^"]+">/g, () => '')
    .replace('</head>', () => `  <style>\n${css}\n  </style>\n</head>`)
    .replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${runtime}\n  </script>`);

  mkdirSync(distDir, { recursive: true });
  const out = join(distDir, 'radarloop.html');
  writeFileSync(out, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`Bundled ${modules.length} modules -> dist/radarloop.html (${kb} KB)`);
  return out;
}

build();
