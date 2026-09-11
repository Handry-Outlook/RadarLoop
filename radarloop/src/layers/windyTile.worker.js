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
 * Parent tiles, held just long enough to be shared.
 *
 * Past native zoom every tile on screen is a crop of one of a handful of parent
 * tiles, and each also reads a strip of its neighbours for the smoothing. Left
 * alone that is the same image decoded dozens of times over; the HTTP cache
 * spares the network but not `createImageBitmap`. The promise goes in rather
 * than the bitmap so that tiles asking for the same parent at the same moment
 * wait on one decode between them.
 */
const bitmapCache = new Map();
const BITMAP_CACHE_LIMIT = 24;

function cachedBitmap(urls) {
  const key = urls[0];
  const hit = bitmapCache.get(key);
  if (hit) {
    // Freshen it: the map's insertion order is the eviction order.
    bitmapCache.delete(key);
    bitmapCache.set(key, hit);
    return hit;
  }

  const entry = fetchBitmap(urls);
  bitmapCache.set(key, entry);
  // A failure must not be remembered, or the tile can never recover.
  entry.catch(() => {
    if (bitmapCache.get(key) === entry) bitmapCache.delete(key);
  });

  while (bitmapCache.size > BITMAP_CACHE_LIMIT) {
    const oldest = bitmapCache.keys().next().value;
    const dropped = bitmapCache.get(oldest);
    bitmapCache.delete(oldest);
    dropped.then((e) => e.bitmap.close()).catch(() => {});
  }
  return entry;
}

/**
 * How wide a grid the smoothing works on, and how wide its kernel is.
 *
 * The blur is measured against the radar's own sample spacing rather than
 * against the output, which is what makes it behave the same at every zoom: the
 * radius comes out at about two thirds of a sample whether that sample ends up
 * three output pixels wide or fifty.
 *
 * What varies is how finely that is resolved. Three pixels per sample is the
 * coarsest grid a radius of two fits on at all, and it is enough when the tile
 * is only stretched a few times over. Stretched further the eye can follow the
 * kernel itself, so the grid is refined — but only until it reaches a couple of
 * hundred pixels, because the cost is the square of it and a tile has to decode
 * in the time a scrubbed frame allows.
 */
const FIELD_WIDTH = 256;
const FIELD_MIN_SCALE = 3;
const FIELD_MAX_SCALE = 6;
/** A little under a sample: enough to take the corners off the grid, not enough
 *  to move a boundary somewhere the data does not put it. */
const FIELD_KERNEL = 0.67;

const fieldScale = (samples) =>
  Math.max(FIELD_MIN_SCALE, Math.min(FIELD_MAX_SCALE, FIELD_WIDTH / samples));

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

    // A blue pixel is the provider's no-data mask, not weak echo. Tested by
    // whether blue dominates rather than against fixed thresholds, because with
    // smoothing on the edge of a coverage gap is a blend of the mask and the
    // data beside it — and a half-blended mask pixel reads as a real echo under
    // a fixed threshold, fringing every coverage boundary with rain that is not
    // there. Unsmoothed the two tests agree on every pixel that occurs.
    if (data[i + 2] > r + g && data[i + 2] > 24) {
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

/**
 * Smooths the reflectivity field in place, before it is coloured.
 *
 * Interpolating during the draw is not enough on its own. Above the provider's
 * native zoom a tile is a small crop of its parent blown up — at four zoom
 * levels past it, thirty-two source pixels stretched across two hundred and
 * fifty-six — and bilinear interpolation of that still carries the source grid
 * plainly enough to read as blocks. Quantising into colour classes afterwards
 * puts a hard edge on every one of those blocks, which is what makes it look
 * pixelated rather than merely soft.
 *
 * So the values get a proper blur first, a little under a sample wide. The
 * classes are applied to the result, so they stay exactly as sharp as they
 * were: what moves is where the boundaries fall, not how crisp they are.
 *
 * Three box passes, which is close enough to a Gaussian for this and costs four
 * additions per pixel per pass rather than a kernel multiply.
 *
 * Coverage gaps are held out of it. The provider masks them in blue, and a blur
 * that averaged them in would pull every boundary inward and invent a soft fringe
 * of drizzle around each one; each pass therefore averages only the samples that
 * carry data and divides by how many it found.
 */
function smoothField(imageData, radius) {
  const { data, width, height } = imageData;
  const n = width * height;
  const value = new Float32Array(n);
  const weight = new Float32Array(n);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    // Nothing was drawn here, or it is the provider's no-data mask (blue
    // dominant) rather than weak echo. Either way it is not a sample.
    if (data[i + 3] < 2) continue;
    if (data[i + 2] > data[i] + data[i + 1] && data[i + 2] > 24) continue;
    value[p] = data[i] + data[i + 1];
    weight[p] = 1;
  }

  const valueTmp = new Float32Array(n);
  const weightTmp = new Float32Array(n);

  for (let pass = 0; pass < 3; pass += 1) {
    blurAxis(value, weight, valueTmp, weightTmp, width, height, radius, true);
    blurAxis(valueTmp, weightTmp, value, weight, width, height, radius, false);
  }

  // Back into the pixels, in the form `recolour` reads: the sum in red and
  // green, and blue carrying the mask.
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    if (weight[p] <= 0.02) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 255;
      continue;
    }
    const sum = Math.max(0, Math.min(510, value[p] / weight[p]));
    data[i] = Math.round(sum / 2);
    data[i + 1] = sum - data[i];
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
}

/** One box pass along a single axis, carrying the weights with the values. */
function blurAxis(value, weight, outValue, outWeight, width, height, radius, horizontal) {
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;

  for (let o = 0; o < outer; o += 1) {
    const base = horizontal ? o * width : o;
    let sumValue = 0;
    let sumWeight = 0;

    // Prime the window on the first cell of the row.
    for (let k = 0; k <= radius && k < inner; k += 1) {
      sumValue += value[base + k * step];
      sumWeight += weight[base + k * step];
    }
    outValue[base] = sumValue;
    outWeight[base] = sumWeight;

    for (let i = 1; i < inner; i += 1) {
      const add = i + radius;
      const drop = i - radius - 1;
      if (add < inner) {
        sumValue += value[base + add * step];
        sumWeight += weight[base + add * step];
      }
      if (drop >= 0) {
        sumValue -= value[base + drop * step];
        sumWeight -= weight[base + drop * step];
      }
      outValue[base + i * step] = sumValue;
      outWeight[base + i * step] = sumWeight;
    }
  }
}

/**
 * The source patch: this tile's piece of the data plus a margin of what
 * surrounds it, at the resolution the provider sent, before anything is scaled.
 *
 * It exists so that the scaling afterwards is a single operation over a
 * continuous field. Assembled straight onto the working canvas instead, each
 * piece is resampled by its own call — and a three-pixel sliver from the tile
 * next door does not come out of that the same way the wide piece beside it
 * does, which put a faint line down every boundary between two provider tiles.
 * Copied one to one there is no resampling to disagree about.
 */
let patch = null;
let patchCtx = null;

function patchSurface(width, height) {
  if (!patch) {
    patch = new OffscreenCanvas(width, height);
    patchCtx = patch.getContext('2d', { alpha: true });
  } else if (patch.width !== width || patch.height !== height) {
    patch.width = width;
    patch.height = height;
  }
  patchCtx.clearRect(0, 0, width, height);
  patchCtx.imageSmoothingEnabled = false;
  return patchCtx;
}

/**
 * A third canvas, holding the tile plus a margin of the data around it.
 *
 * The smoothing is a local average, so a pixel on the tile's edge would
 * otherwise average only the half of its neighbourhood that fell inside the
 * tile — and the tile next to it would do the same from the other side, leaving
 * a visible join down every boundary. Drawing a margin of the surrounding data
 * and discarding it afterwards gives the edge pixels the neighbours they need.
 */
let padded = null;
let pctx = null;

function paddedSurface(width, height) {
  if (!padded) {
    padded = new OffscreenCanvas(width, height);
    pctx = padded.getContext('2d', { willReadFrequently: true, alpha: true });
  } else if (padded.width !== width || padded.height !== height) {
    padded.width = width;
    padded.height = height;
  }
  pctx.clearRect(0, 0, width, height);
  return pctx;
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
  out.imageSmoothingEnabled = false;
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

    // Not closed by this path: the cache owns these and the tile beside this
    // one is about to want the same image.
    const { bitmap, usedIndex } = await cachedBitmap(urls);
    const smooth = job.smooth === true;

    // The source rectangle this tile is cut from. Past the provider's native
    // zoom that is a fraction of the parent tile, which is where the stretch —
    // and the blockiness — comes from.
    const sx = crop ? (crop.ix * bitmap.width) / crop.scale : 0;
    const sy = crop ? (crop.iy * bitmap.height) / crop.scale : 0;
    const sw = crop ? bitmap.width / crop.scale : bitmap.width;
    const sh = crop ? bitmap.height / crop.scale : bitmap.height;

    // How many output pixels one sample covers. At two or less the tile is near
    // enough its own resolution that there is no grid to see, and the blur would
    // only cost detail.
    const up = Math.min(dw / sw, dh / sh);
    const soften = smooth && up >= 3;

    if (soften) {
      // Smooth on a grid a few pixels per sample, not at output resolution.
      // A sample is all the detail the data has, so that is enough to carry the
      // kernel, and the rest of the stretch is then one hardware-interpolated
      // draw of a field that is already smooth. Doing it at output resolution
      // instead cost fifty-nine milliseconds a tile against six, for a result
      // no eye could separate.
      const scale = fieldScale(Math.max(sw, sh));
      const radius = Math.max(1, Math.round(scale * FIELD_KERNEL));
      // Three box passes reach three radii, and one sample wider again,
      // rounded to whole samples so
      // the patch below can be copied without resampling. Canvas scaling
      // flattens the outermost half-sample of whatever rectangle it is given,
      // and without the extra the blur would carry that flattened edge back into
      // the tile's own pixels — differently on each side of a join.
      const padSamples = Math.ceil((radius * 3 + scale) / scale);
      const margin = padSamples * scale;
      const mw = Math.max(1, Math.round(sw * scale));
      const mh = Math.max(1, Math.round(sh * scale));
      const work = paddedSurface(mw + margin * 2, mh + margin * 2);
      work.imageSmoothingEnabled = true;
      work.imageSmoothingQuality = 'high';

      /*
       * The margin, taken from wherever the data actually is.
       *
       * A blur is an average of a neighbourhood, so a tile that can only see
       * itself averages half a neighbourhood along each of its edges and leans
       * inward — and the tile beside it leans the other way, which is a seam.
       * Inside a provider tile there is always more data to read, but a crop on
       * its edge runs out, and that is where the joins showed: measured at two
       * hundred rows of five hundred and twelve changing rainfall class across
       * one, against four for an ordinary step. So the patch is assembled from
       * the provider tile and whichever of its eight neighbours the widened
       * rectangle reaches into.
       */
      const bw = bitmap.width;
      const bh = bitmap.height;
      const px0 = sx - padSamples;
      const py0 = sy - padSamples;
      const pw = sw + padSamples * 2;
      const ph = sh + padSamples * 2;
      const assembled = patchSurface(pw, ph);

      for (let gy = -1; gy <= 1; gy += 1) {
        for (let gx = -1; gx <= 1; gx += 1) {
          const ox = gx * bw;
          const oy = gy * bh;
          const cx0 = Math.max(px0, ox);
          const cy0 = Math.max(py0, oy);
          const cx1 = Math.min(px0 + pw, ox + bw);
          const cy1 = Math.min(py0 + ph, oy + bh);
          if (cx1 <= cx0 || cy1 <= cy0) continue;

          let source = bitmap;
          if (gx || gy) {
            const at = job.neighbours && job.neighbours[`${gx},${gy}`];
            if (!at) continue;
            // A missing neighbour — the edge of the world, or a tile the
            // provider does not have — is left out, and the weighted blur falls
            // back to whatever it can see.
            // eslint-disable-next-line no-await-in-loop
            const got = await cachedBitmap(at).catch(() => null);
            if (!got) continue;
            source = got.bitmap;
          }

          assembled.drawImage(
            source,
            cx0 - ox, cy0 - oy, cx1 - cx0, cy1 - cy0,
            cx0 - px0, cy0 - py0, cx1 - cx0, cy1 - cy0,
          );
        }
      }

      work.drawImage(patch, 0, 0, pw, ph, 0, 0, pw * scale, ph * scale);

      const field = work.getImageData(0, 0, mw + margin * 2, mh + margin * 2);
      smoothField(field, radius);
      work.putImageData(field, 0, 0);

      const context = surface(dw, dh);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      // Drawn wider than the tile and clipped back to it. Asked for exactly
      // the tile's own rectangle, the resampler has nothing beyond its edges to
      // read and flattens the last half pixel — on both sides of a join, which
      // is a faint line down it. Reaching two pixels further puts that flat edge
      // outside the tile, where it is thrown away.
      const bleed = 2;
      const ex = (bleed * dw) / mw;
      const ey = (bleed * dh) / mh;
      context.drawImage(
        padded,
        margin - bleed, margin - bleed, mw + bleed * 2, mh + bleed * 2,
        -ex, -ey, dw + ex * 2, dh + ey * 2,
      );
      const pixels = context.getImageData(0, 0, dw, dh);
      context.putImageData(recolour(pixels, lut), 0, 0);
    } else {
      const context = surface(dw, dh);
      // Interpolating the *channels* interpolates the value they encode, so the
      // colour table still re-quantises the result into the same hard bands.
      // That is what keeps this sharp rather than blurred.
      context.imageSmoothingEnabled = smooth;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        bitmap,
        sx, sy, Math.max(1, sw), Math.max(1, sh),
        0, 0, dw, dh,
      );
      const pixels = context.getImageData(0, 0, dw, dh);
      context.putImageData(recolour(pixels, lut), 0, 0);
    }

    const out = canvas.transferToImageBitmap();
    self.postMessage({ id, ok: true, bitmap: out, usedIndex }, [out]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
};
