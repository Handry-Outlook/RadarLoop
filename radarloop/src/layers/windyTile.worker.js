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

self.onmessage = async (event) => {
  const job = event.data;

  if (job.type === 'lut') {
    luts.set(job.lutId, job.lut);
    // Only the newest table is ever asked for; the rest are dead weight.
    if (luts.size > 3) luts.delete(luts.keys().next().value);
    return;
  }

  const { id, urls, dw, dh, crop, lutId } = job;
  const lut = luts.get(lutId);
  if (!lut) {
    self.postMessage({ id, ok: false, error: 'colour table not registered' });
    return;
  }

  try {
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
