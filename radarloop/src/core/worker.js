/**
 * Starting a worker from either build.
 *
 * The modular build loads `*.worker.js` as an ordinary module worker. The
 * single-file build has no separate script to fetch, so the bundler inlines
 * every worker source and exposes it as a Blob URL keyed by basename; this
 * picks whichever is available.
 *
 * The dev URL is passed in rather than built here because `import.meta.url` has
 * to resolve relative to the *importing* module, and the bundler rewrites it to
 * `location.href` (a classic script has no `import.meta`).
 *
 * @param {string} name basename, e.g. 'accumulation.worker.js'
 * @param {URL|string} devUrl module URL used when running unbundled
 */
export function spawnWorker(name, devUrl) {
  const bundled = typeof window !== 'undefined' && window.__RADARLOOP_WORKERS__?.[name];
  return bundled ? new Worker(bundled) : new Worker(devUrl, { type: 'module' });
}
