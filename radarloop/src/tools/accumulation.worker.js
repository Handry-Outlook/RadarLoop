/**
 * Rainfall accumulation worker.
 *
 * Decodes Windy radar tiles for a series of frames and integrates rainfall rate
 * over time into a per-output-pixel total, then colours the result.
 *
 * This runs off the main thread because a one-hour accumulation over a wide view
 * decodes dozens of tiles and touches millions of pixels — doing it inline froze
 * the map for seconds at a time.
 *
 * In the bundled single-file build this source is inlined and started from a Blob
 * URL; in the modular build it is loaded as a normal worker script.
 */

/* eslint-env worker */

let currentJob = 0;

/** Reverses the tile encoding: channel value -> rainfall rate in mm/h. */
function buildRateLut(dbzPerUnit, nerf) {
  const lut = new Float32Array(256);
  for (let encoded = 0; encoded < 256; encoded += 1) {
    const dbz = Math.max(0, encoded * dbzPerUnit);
    lut[encoded] = dbz > 0 ? (10 ** (dbz / 10) * 0.005) ** 0.625 * nerf : 0;
  }
  return lut;
}

function colourForMm(mm, stops) {
  for (const [limit, rgba] of stops) if (mm < limit) return rgba;
  return stops[stops.length - 1][1];
}

/** Decodes one tile into a rate grid plus a validity mask. */
async function decodeTile(url, lut) {
  const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  if (!response.ok) throw new Error(`tile HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const count = canvas.width * canvas.height;
  const mmh = new Float32Array(count);
  const valid = new Uint8Array(count);

  for (let i = 0, p = 0; i < count; i += 1, p += 4) {
    if (data[p + 3] < 2) continue;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    // Near-pure blue is the provider's no-data mask, not weak echo.
    if (b > 200 && r < 8 && g < 8) continue;
    const encoded = (r + g) / 2;
    if (encoded <= 0.5) continue;
    mmh[i] = lut[Math.min(255, Math.round(encoded))];
    valid[i] = 1;
  }
  return { width: canvas.width, height: canvas.height, mmh, valid };
}

/** Runs `jobs` with bounded concurrency. */
async function pool(items, limit, worker) {
  let cursor = 0;
  let any = false;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (await worker(item)) any = true;
    }
  });
  await Promise.all(runners);
  return any;
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'calculate') return;

  const { jobId, width, height, frames, groups, colourStops, constants, concurrency = 4 } = message;
  currentJob = jobId;

  try {
    const lut = buildRateLut(constants.dbzPerEncodedUnit, constants.mmhNerf);
    const totals = new Float32Array(width * height);
    const tileCache = new Map();
    let validFrames = 0;
    let missingFrames = 0;

    for (let fi = 0; fi < frames.length; fi += 1) {
      if (jobId !== currentJob) return;
      const frame = frames[fi];

      const hadData = await pool(groups, concurrency, async (group) => {
        if (jobId !== currentJob) return false;
        const url = frame.urls[group.key];
        if (!url) return false;
        try {
          let source = tileCache.get(url);
          if (!source) {
            source = await decodeTile(url, lut);
            // Bounded so a long accumulation cannot exhaust worker memory.
            if (tileCache.size > 64) tileCache.delete(tileCache.keys().next().value);
            tileCache.set(url, source);
          }
          const { idx, px, py } = group;
          for (let i = 0; i < idx.length; i += 1) {
            const sx = Math.max(0, Math.min(source.width - 1, Math.floor((px[i] * source.width) / 256)));
            const sy = Math.max(0, Math.min(source.height - 1, Math.floor((py[i] * source.height) / 256)));
            const off = sy * source.width + sx;
            if (source.valid[off]) totals[idx[i]] += source.mmh[off] * frame.durationHours;
          }
          return true;
        } catch {
          return false;
        }
      });

      if (hadData) validFrames += 1;
      else missingFrames += 1;

      if (fi === 0 || fi === frames.length - 1 || fi % 2 === 0) {
        self.postMessage({
          type: 'progress',
          jobId,
          percent: Math.floor(((fi + 1) / frames.length) * 96),
          text: `Accumulating frame ${fi + 1} of ${frames.length}`,
        });
      }
    }

    if (jobId !== currentJob) return;
    self.postMessage({ type: 'progress', jobId, percent: 97, text: 'Colouring accumulated rainfall' });

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < totals.length; i += 1) {
      const colour = colourForMm(totals[i], colourStops);
      const o = i * 4;
      rgba[o] = colour[0];
      rgba[o + 1] = colour[1];
      rgba[o + 2] = colour[2];
      rgba[o + 3] = colour[3];
    }

    self.postMessage(
      { type: 'done', jobId, width, height, totalsBuffer: totals.buffer, rgbaBuffer: rgba.buffer, validFrames, missingFrames },
      [totals.buffer, rgba.buffer],
    );
  } catch (error) {
    self.postMessage({ type: 'error', jobId, message: error?.message || 'Accumulation failed' });
  }
};
