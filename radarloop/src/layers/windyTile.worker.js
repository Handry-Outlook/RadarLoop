/**
 * Windy radar tile worker.
 *
 * Windy's radar2 tiles are data, not pictures: R and G encode reflectivity and a
 * pure blue pixel is the no-data mask. Turning one into something drawable means
 * touching every pixel, and a viewport holds around forty tiles.
 *
 * Doing that on the main thread is what made scrubbing heavy — at a 2x device
 * pixel ratio a single frame is ten million pixels of JavaScript, competing with
 * Leaflet in 2D and with GL rendering in 3D. Fetch, decode, crop and recolour all
 * happen here instead, and the main thread receives a finished ImageBitmap it can
 * blit in one call.
 *
 * The colour scale arrives as a lookup table so no palette logic is duplicated:
 * the table is indexed by `r + g` directly, which is exact rather than a rounding
 * of the `(r + g) / 2` encoded value.
 *
 * In the bundled single-file build this source is inlined and started from a Blob
 * URL; in the modular build it is loaded as a normal module worker.
 */

/* eslint-env worker */

/** Colour tables held by id so a table is transferred once, not once per tile. */
const luts = new Map();

/**
 * Recolours decoded tile pixels in place through the active scale.
 *
 * @param {ImageData} imageData
 * @param {Uint8ClampedArray} lut 511 RGBA entries indexed by `r + g`
 */
function recolour(imageData, lut) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 2) continue;

    const r = data[i];
    const g = data[i + 1];

    // A near-pure blue pixel is the provider's no-data mask, not weak echo.
    if (data[i + 2] > 200 && r < 8 && g < 8) {
      data[i + 3] = 0;
      continue;
    }

    // `encoded` is (r + g) / 2, so `r + g` indexes the table without rounding.
    const sum = r + g;
    const o = sum << 2;
    const alpha = sum > 1 ? lut[o + 3] : 0;
    if (!alpha) {
      data[i + 3] = 0;
      continue;
    }

    data[i] = lut[o];
    data[i + 1] = lut[o + 1];
    data[i + 2] = lut[o + 2];
    data[i + 3] = alpha;
  }
  return imageData;
}

/**
 * Tries each URL in order and returns the first that decodes.
 *
 * The order matters: frames older than about two hours are only served from the
 * archive endpoint, and the caller reports back which one worked so the cutoff
 * can be learned.
 */
async function fetchBitmap(urls, signal) {
  let lastError = null;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      const response = await fetch(urls[i], { mode: 'cors', credentials: 'omit', signal });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const blob = await response.blob();
      return { bitmap: await createImageBitmap(blob), usedIndex: i };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('no tile URL succeeded');
}

/** One reusable canvas per worker — tiles in a frame share a size. */
let canvas = null;
let ctx = null;

function surface(width, height) {
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
  } else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/**
 * A second reusable canvas, holding a tile at its own source size.
 *
 * The satellite product needs one: its source is 256x512 and its output is
 * 256x256, and the decode has to happen at source resolution before anything is
 * scaled — the checkerboard inversion is defined on the source pixel grid, so
 * resampling first would smear block edges into each other.
 */
let scratch = null;
let sctx = null;

function scratchSurface(width, height) {
  if (!scratch) {
    scratch = new OffscreenCanvas(width, height);
    sctx = scratch.getContext('2d', { willReadFrequently: true, alpha: true });
  } else if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  sctx.imageSmoothingEnabled = false;
  sctx.clearRect(0, 0, width, height);
  return sctx;
}

/* ------------------------------------------------------------------ *
 * Satellite: visible + infrared
 * ------------------------------------------------------------------ */

/**
 * Side of the satellite product's inverted-block checkerboard, in source pixels.
 * Kept in step with layers/windySat.js, which documents how it was found; a
 * worker cannot import, so the constants live in both places.
 */
const SAT_BLOCK = 16;
const SAT_ALPHA_LO = 40;
const SAT_ALPHA_HI = 120;

/**
 * Undoes the checkerboard inversion the provider applies to alternate blocks.
 *
 * The two halves do not share a parity: the visible channel carries `255 - v` in
 * the blocks where the infrared channel carries `v`. Both candidate decodes are
 * exact negatives of one another, so nothing in the pixels distinguishes them —
 * the seams are equally smooth either way. What settles it is the ground: over
 * the Atlantic coast of the western Sahara the desert is the brightest thing a
 * visible channel sees and the open ocean nearly the darkest, while in the
 * infrared the baking sand is darkest and the cold cloud tops brightest. Only
 * one assignment puts both the right way up, and it is this one.
 */
function deinvertBlocks(imageData) {
  const { data, width, height } = imageData;
  const half = height / 2;
  for (let y = 0; y < height; y += 1) {
    // The channel index enters the parity, which is what makes the halves differ.
    const rowParity = (((y / SAT_BLOCK) | 0) + (y >= half ? 1 : 0)) % 2;
    for (let x = 0; x < width; x += 1) {
      if ((((x / SAT_BLOCK) | 0) + rowParity) % 2 !== 0) continue;
      const i = (y * width + x) * 4;
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
  }
  return imageData;
}

/**
 * Collapses the source's two stacked channels into one drawable half-height tile.
 *
 * `weights` is the caller's coarse daylight grid, `grid` cells across, sampled
 * bilinearly: one where the visible channel is trustworthy, zero where the sun is
 * down. It is null when the tile needs no blend at all.
 */
function composeChannels(source, out, channel, weights, grid) {
  const w = source.width;
  const half = source.height / 2;
  const src = source.data;
  const dst = out.data;
  const span = SAT_ALPHA_HI - SAT_ALPHA_LO;

  for (let y = 0; y < half; y += 1) {
    const gy = weights ? (y / half) * grid : 0;
    const y0 = weights ? Math.min(grid - 1, gy | 0) : 0;
    const fy = gy - y0;

    for (let x = 0; x < w; x += 1) {
      const vis = src[(y * w + x) * 4];
      const ir = src[((y + half) * w + x) * 4];

      let v;
      if (channel === 'ir') {
        v = ir;
      } else if (channel === 'vis') {
        v = vis;
      } else if (vis <= 1) {
        // The visible channel's empty value, which covers the unlit hemisphere
        // and everything else the sun is not reaching.
        v = ir;
      } else if (!weights) {
        v = vis;
      } else {
        const gx = (x / w) * grid;
        const x0 = Math.min(grid - 1, gx | 0);
        const fx = gx - x0;
        const r0 = y0 * (grid + 1) + x0;
        const r1 = r0 + grid + 1;
        const day = (weights[r0] * (1 - fx) + weights[r0 + 1] * fx) * (1 - fy)
          + (weights[r1] * (1 - fx) + weights[r1 + 1] * fx) * fy;
        v = ir + (vis - ir) * day;
      }

      const o = (y * w + x) * 4;
      dst[o] = v;
      dst[o + 1] = v;
      dst[o + 2] = v;
      dst[o + 3] = v <= SAT_ALPHA_LO ? 0 : (v >= SAT_ALPHA_HI ? 255 : ((v - SAT_ALPHA_LO) / span) * 255);
    }
  }
  return out;
}

/** Decodes one satellite tile and draws it into the destination surface. */
function drawSatellite(bitmap, job) {
  const w = bitmap.width;
  const h = bitmap.height;
  const half = h / 2;

  const context = scratchSurface(w, h);
  context.drawImage(bitmap, 0, 0);
  const source = deinvertBlocks(context.getImageData(0, 0, w, h));
  const composed = composeChannels(source, new ImageData(w, half), job.channel, job.weights, job.grid);
  // Written back into the same scratch canvas so the scale-and-crop below is a
  // single drawImage rather than another allocation.
  context.putImageData(composed, 0, 0);

  const out = surface(job.dw, job.dh);
  if (job.crop) {
    const sw = w / job.crop.scale;
    const sh = half / job.crop.scale;
    out.drawImage(scratch,
      Math.round(job.crop.ix * sw), Math.round(job.crop.iy * sh),
      Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)),
      0, 0, job.dw, job.dh);
  } else {
    out.drawImage(scratch, 0, 0, w, half, 0, 0, job.dw, job.dh);
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

self.onmessage = async (event) => {
  const job = event.data;

  if (job.type === 'lut') {
    luts.set(job.lutId, job.lut);
    // Only the newest table is ever asked for; the rest are dead weight.
    if (luts.size > 3) luts.delete(luts.keys().next().value);
    return;
  }

  const { id, urls, dw, dh, crop, lutId } = job;

  try {
    if (job.mode === 'visir') {
      const { bitmap, usedIndex } = await fetchBitmap(urls);
      drawSatellite(bitmap, job);
      bitmap.close();
      const image = canvas.transferToImageBitmap();
      // Which URL answered matters: falling through to the second one is how the
      // caller learns where the live endpoint stops.
      self.postMessage({ id, ok: true, bitmap: image, usedIndex }, [image]);
      return;
    }

    const lut = luts.get(lutId);
    if (!lut) {
      self.postMessage({ id, ok: false, error: 'colour table not registered' });
      return;
    }

    const { bitmap, usedIndex } = await fetchBitmap(urls);
    const context = surface(dw, dh);

    if (crop) {
      const sw = bitmap.width / crop.scale;
      const sh = bitmap.height / crop.scale;
      context.drawImage(
        bitmap,
        Math.round(crop.ix * sw), Math.round(crop.iy * sh),
        Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)),
        0, 0, dw, dh,
      );
    } else {
      context.drawImage(bitmap, 0, 0, dw, dh);
    }
    bitmap.close();

    const pixels = context.getImageData(0, 0, dw, dh);
    context.putImageData(recolour(pixels, lut), 0, 0);

    const out = canvas.transferToImageBitmap();
    self.postMessage({ id, ok: true, bitmap: out, usedIndex }, [out]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
};
