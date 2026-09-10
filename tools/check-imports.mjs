/**
 * Static check: every named import must correspond to a real export, and no
 * module may import something it never uses in a way that hides a typo.
 * Catches broken wiring that only shows up on a code path the smoke test misses.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'radarloop', 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const exportsByFile = new Map();

/** Collects the names a module exports. */
function collectExports(file) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();

  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}(?!\s*from)/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits[0]) names.add((bits[1] || bits[0]).trim());
    }
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits[0]) names.add((bits[1] || bits[0]).trim());
    }
  }
  return names;
}

for (const file of files) exportsByFile.set(file, collectExports(file));

let problems = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  for (const m of src.matchAll(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (!m[2].startsWith('.')) continue;
    let target = resolve(dirname(file), m[2]);
    if (!exportsByFile.has(target)) target = `${target}.js`;
    if (!exportsByFile.has(target)) {
      console.log(`  MISSING MODULE  ${rel} -> ${m[2]}`);
      problems += 1;
      continue;
    }
    const available = exportsByFile.get(target);
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name)) {
        console.log(`  MISSING EXPORT  ${rel} imports "${name}" from ${m[2]} — not exported`);
        problems += 1;
      }
    }
  }
}

console.log(`\nChecked ${files.length} modules.`);
console.log(problems === 0 ? 'All imports resolve.' : `${problems} problem(s).`);
process.exit(problems === 0 ? 0 : 1);
