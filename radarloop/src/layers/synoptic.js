/**
 * Surface observations, drawn as station models.
 *
 * The classic plot: a sky-cover circle with a wind barb, temperature above-left,
 * dew point below-left, sea-level pressure coded to three digits above-right.
 * It packs six variables into something the eye reads at a glance, which is why
 * it has outlived every attempt to replace it.
 *
 * ## Why these networks
 *
 * Synoptic carries about 35,000 active stations over the continental US alone —
 * every mesonet, road sensor and hobby gauge — and asking for all of them costs
 * 16 MB a refresh. The three networks used here (ASOS/AWOS, Global METAR and the
 * WMO synoptic feed) are the ones that report a full station model on a regular
 * cycle, come to roughly 13,000 worldwide, and bring a continental view down to
 * under 2 MB. That is the difference between a layer that can auto-update and
 * one that cannot.
 *
 * ## Why a canvas
 *
 * A station model is a dozen strokes, and a busy view holds several hundred of
 * them. As markers that is thousands of DOM nodes rebuilt on every pan; on one
 * canvas it is a single pass, the same reasoning as the strike renderer.
 */

import { CREDENTIALS, DEVICE } from '../config.js';
import { map } from '../core/map.js';
import { emit, EVENTS } from '../core/bus.js';
import { runtime, time } from '../core/state.js';
import { is3D, mirrorMagnification } from '../core/map3d.js';

const LATEST = 'https://api.synopticdata.com/v2/stations/latest';
/**
 * Observations nearest a given time, for when the scrubber is not at the live
 * edge. `latest` ignores the timeline entirely, which made the station models
 * the one layer that did not move with it.
 */
const NEAREST = 'https://api.synopticdata.com/v2/stations/nearesttime';
/** A day of readings for one station, for the popup charts. */
const TIMESERIES = 'https://api.synopticdata.com/v2/stations/timeseries';

/**
 * ASOS/AWOS, Global METAR and the WMO synoptic feed. See the note above: this is
 * the difference between 13,000 stations and 35,000 in the US alone.
 */
const NETWORKS = '1,239,284';

/** Everything a station model needs, and nothing else — each var costs payload. */
const VARS = [
  'air_temp',
  'dew_point_temperature',
  'wind_speed',
  'wind_direction',
  'wind_gust',
  'sea_level_pressure',
  'cloud_layer_1_code',
  'visibility',
  'relative_humidity',
  // Present weather, for the symbol beside the plot. The text form rather than
  // `weather_cond_code`, which packs several conditions into one number — a
  // station reporting light rain with light drizzle sends 1373.
  'weather_condition',
  // Rain and snow, both as a rate and as what has fallen.
  'precip_accum_one_hour',
  'precip_accum_24_hour',
  'precipitation_rate',
  'snow_depth',
  'snow_accum',
].join(',');

/**
 * Widest window that will be requested, in degrees.
 *
 * A whole-world bbox is refused by the service, and even a continental one is
 * megabytes. Past this the plots would be unreadably dense anyway, so the
 * request is clamped to the middle of the view and the panel says so.
 */
const MAX_SPAN = { lon: 46, lat: 30 };

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export const options = {
  // On from the start: it is the layer that says what the weather actually is.
  enabled: true,
  /** 'F' or 'C'. */
  tempUnit: 'C',
  /** 'kts', 'mph' or 'ms'. */
  windUnit: 'mph',
  /** Minimum screen spacing between plots, in pixels. */
  spacing: DEVICE.mobile ? 64 : 52,
  /** Observations older than this are not drawn. */
  maxAgeMinutes: 150,
  /** How often to re-poll, in minutes. */
  refreshMinutes: 5,
  showPressure: true,
  showIdentifier: true,
};

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

let stations = [];
let lastFetch = 0;
let lastKey = '';
let inFlight = null;
let refreshTimer = null;

export const stationCount = () => stations.length;
/** A few temperatures, so a test can tell one moment from another. */
export const sampleTemps = () => stations.slice(0, 4).map((s2) => s2.temp);
export const lastUpdated = () => lastFetch || null;
/** The moment the held observations are for, or null when they are live. */
let observedAt = null;
export const observationTime = () => observedAt;

/** The request window: the view, clamped, and rounded so small pans reuse it. */
function requestBounds() {
  const b = map.getBounds();
  const centre = b.getCenter();
  const lonSpan = Math.min(MAX_SPAN.lon, Math.abs(b.getEast() - b.getWest()) * 1.15);
  const latSpan = Math.min(MAX_SPAN.lat, Math.abs(b.getNorth() - b.getSouth()) * 1.15);
  const round = (v) => Math.round(v * 4) / 4;
  return {
    west: round(Math.max(-180, centre.lng - lonSpan / 2)),
    east: round(Math.min(180, centre.lng + lonSpan / 2)),
    south: round(Math.max(-85, centre.lat - latSpan / 2)),
    north: round(Math.min(85, centre.lat + latSpan / 2)),
    clamped: Math.abs(b.getEast() - b.getWest()) * 1.15 > MAX_SPAN.lon,
  };
}

export const isClamped = () => requestBounds().clamped;

/** Minutes a request is rounded to, so nudging the scrubber reuses one. */
const BUCKET_MINUTES = 10;

/**
 * The moment being asked for, or null at the live edge.
 *
 * Within one bucket of live counts as live: `latest` is cheaper than a
 * nearest-time lookup and is what a live view wants anyway.
 */
function requestTime() {
  const target = time.current;
  if (Date.now() - target < BUCKET_MINUTES * 60000) return null;
  const bucket = Math.round(target / (BUCKET_MINUTES * 60000)) * BUCKET_MINUTES * 60000;
  return new Date(bucket);
}

/** The API wants a bare UTC stamp, YYYYMMDDHHmm. */
function stampFor(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function buildUrl(bounds, at) {
  const params = new URLSearchParams({
    token: CREDENTIALS.synoptic,
    network: NETWORKS,
    vars: VARS,
    status: 'active',
    within: String(options.maxAgeMinutes),
    obtimezone: 'utc',
    // Trimming the metadata halves the payload; none of it is drawn.
    fields: 'stid,name,latitude,longitude,elevation',
    units: `temp|${options.tempUnit},speed|${options.windUnit},precip|mm`,
    bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
  });
  if (at) params.set('attime', stampFor(at));
  return `${at ? NEAREST : LATEST}?${params}`;
}

const num = (entry) => {
  const value = entry?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** Flattens one API station into the handful of numbers the plot needs. */
function toStation(raw) {
  const lat = Number(raw.LATITUDE);
  const lon = Number(raw.LONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const obs = raw.OBSERVATIONS || {};
  // Synoptic suffixes each variable with the sensor index, and appends `d` for a
  // derived value. Preferring the measured one keeps the plot honest.
  const pick = (name) => obs[`${name}_value_1`] ?? obs[`${name}_value_1d`];

  const temp = num(pick('air_temp'));
  const dew = num(pick('dew_point_temperature'));
  const speed = num(pick('wind_speed'));
  const direction = num(pick('wind_direction'));
  const mslp = num(pick('sea_level_pressure'));
  const cloud = num(pick('cloud_layer_1_code'));
  const at = pick('air_temp')?.date_time || pick('wind_speed')?.date_time || null;

  // A station with nothing to draw is just a dot in the way.
  if (temp === null && dew === null && speed === null && mslp === null) return null;

  return {
    id: raw.STID,
    name: raw.NAME,
    lat,
    lon,
    temp,
    dew,
    speed,
    direction,
    gust: num(pick('wind_gust')),
    mslp,
    cloud,
    visibility: num(pick('visibility')),
    weather: pick('weather_condition')?.value ?? null,
    rain1h: num(pick('precip_accum_one_hour')),
    rain24h: num(pick('precip_accum_24_hour')),
    rainRate: num(pick('precipitation_rate')),
    snowDepth: num(pick('snow_depth')),
    snowAccum: num(pick('snow_accum')),
    humidity: num(pick('relative_humidity')),
    elevation: Number(raw.ELEVATION) || null,
    at: at ? Date.parse(at) : null,
  };
}

/**
 * Loads observations for the current view.
 *
 * Repeated calls for the same window inside the refresh interval reuse what is
 * already held: panning a little should not re-download a megabyte.
 */
export async function load({ force = false } = {}) {
  if (!options.enabled) return stations;

  // Dragging must not fire a request per position; the release asks once.
  if (runtime.scrubbing) return stations;

  const bounds = requestBounds();
  const at = requestTime();
  const key = `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`
    + `|${options.tempUnit}|${options.windUnit}|${at ? stampFor(at) : 'live'}`;
  // A historical window does not change, so only a live one goes stale.
  const fresh = at ? true : Date.now() - lastFetch < options.refreshMinutes * 60000;
  if (!force && key === lastKey && fresh && stations.length) return stations;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(buildUrl(bounds, at));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.SUMMARY?.RESPONSE_CODE !== 1) {
        throw new Error(data?.SUMMARY?.RESPONSE_MESSAGE || 'request refused');
      }
      stations = (data.STATION || []).map(toStation).filter(Boolean);
      lastFetch = Date.now();
      lastKey = key;
      observedAt = at;
      emit(EVENTS.OBSERVATIONS_UPDATED, { count: stations.length, at: lastFetch, forTime: at });
      return stations;
    } catch (error) {
      console.warn('[observations] load failed:', error);
      emit(EVENTS.OBSERVATIONS_UPDATED, { count: stations.length, at: lastFetch, error: String(error.message || error) });
      return stations;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * The largest reading in each clock hour.
 *
 * Rainfall is reported as an hourly figure, and a station reporting every twenty
 * minutes repeats it: three samples of 1.2 mm are one millimetre and a bit of
 * rain, not three and a half. Reducing to one value per hour is what makes both
 * the bar chart and the running total count each hour once.
 */
export function hourlyMax(times, values) {
  if (!values?.some((v) => v !== null && v > 0)) return null;
  const out = { times: [], values: [] };
  let bucket = null;
  for (let i = 0; i < times.length; i += 1) {
    const hour = Math.floor(times[i] / 3600000);
    if (hour !== bucket) {
      bucket = hour;
      out.times.push(hour * 3600000);
      out.values.push(0);
    }
    const v = values[i];
    if (v !== null && v > out.values[out.values.length - 1]) out.values[out.values.length - 1] = v;
  }
  return out;
}

/**
 * A running total from interval precipitation reports.
 *
 * The service has no cumulative variable that every network fills in, so the
 * total is built from the hourly reports. The subtlety is that a station
 * reporting every twenty minutes repeats the same hourly figure three times:
 * summing the samples would treble the rainfall. Taking the largest reading
 * within each clock hour and adding hours together counts each one once.
 *
 * Returns null when the station reported nothing, so the caller can leave the
 * chart out rather than draw a flat zero.
 */
function accumulate(times, hourly) {
  if (!hourly?.some((v) => v !== null && v > 0)) return null;
  let total = 0;
  let bucket = null;
  let inBucket = 0;
  return times.map((t, i) => {
    const hour = Math.floor(t / 3600000);
    if (hour !== bucket) {
      total += inBucket;
      bucket = hour;
      inBucket = 0;
    }
    const v = hourly[i];
    if (v !== null && v > inBucket) inBucket = v;
    return total + inBucket;
  });
}

/**
 * Twenty-four hours of readings for one station, for the popup charts.
 *
 * Returned as parallel arrays because that is the shape a chart wants and the
 * shape the API gives; converting to objects and back would only lose the gaps,
 * which matter — a missing report should break the line, not interpolate across.
 */
export async function fetchTimeseries(stid, { hours = 24 } = {}) {
  const params = new URLSearchParams({
    token: CREDENTIALS.synoptic,
    stid,
    recent: String(hours * 60),
    vars: ['air_temp', 'dew_point_temperature', 'wind_speed', 'wind_gust', 'wind_direction',
      'sea_level_pressure', 'relative_humidity', 'precip_accum_one_hour', 'precip_accum_24_hour',
      'precipitation_rate', 'snow_depth', 'snow_accum'].join(','),
    units: `temp|${options.tempUnit},speed|${options.windUnit},precip|mm`,
    obtimezone: 'utc',
  });
  const response = await fetch(`${TIMESERIES}?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data?.SUMMARY?.RESPONSE_CODE !== 1) {
    throw new Error(data?.SUMMARY?.RESPONSE_MESSAGE || 'request refused');
  }
  const obs = data.STATION?.[0]?.OBSERVATIONS;
  if (!obs?.date_time?.length) throw new Error('no readings');

  const finite = (arr) => (arr || []).reduce((n, v) => n + (typeof v === 'number' && Number.isFinite(v) ? 1 : 0), 0);
  /**
   * Whichever of the measured and derived series actually has readings.
   *
   * Preferring `_set_1` outright looked right — a measured value beats a derived
   * one — but plenty of stations carry the key with almost every entry null and
   * put the real readings in `_set_1d`. That drew a chart with no line and a
   * single end dot: dew point and pressure both came out empty at KPHL.
   */
  const pick = (name) => {
    const measured = obs[`${name}_set_1`];
    const derived = obs[`${name}_set_1d`];
    return finite(derived) > finite(measured) ? derived : (measured || derived || []);
  };
  const clean = (arr) => arr.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const times = obs.date_time.map((t) => Date.parse(t));
  return {
    times,
    temp: clean(pick('air_temp')),
    dew: clean(pick('dew_point_temperature')),
    speed: clean(pick('wind_speed')),
    gust: clean(pick('wind_gust')),
    // Pascals from the API; the charts want hectopascals like everything else.
    mslp: clean(pick('sea_level_pressure')).map((v) => (v === null ? null : v / 100)),
    humidity: clean(pick('relative_humidity')),
    direction: clean(pick('wind_direction')),
    rain1h: clean(pick('precip_accum_one_hour')),
    rain24h: clean(pick('precip_accum_24_hour')),
    rainRate: clean(pick('precipitation_rate')),
    snowDepth: clean(pick('snow_depth')),
    snowAccum: clean(pick('snow_accum')),
    rainTotal: accumulate(times, clean(pick('precip_accum_one_hour'))),
    snowTotal: accumulate(times, clean(pick('snow_accum'))),
    rainHourly: hourlyMax(times, clean(pick('precip_accum_one_hour'))),
    snowHourly: hourlyMax(times, clean(pick('snow_accum'))),
  };
}

export function startPolling() {
  stopPolling();
  if (!options.enabled || !options.refreshMinutes) return;
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    load({ force: true }).then(() => draw());
  }, options.refreshMinutes * 60000);
}

export function stopPolling() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

/* ------------------------------------------------------------------ *
 * The station model
 * ------------------------------------------------------------------ */

/**
 * Sky cover, as the fraction of the circle to fill.
 *
 * Synoptic reports a three-digit cloud code whose leading digit is the coverage
 * octa class; the rest is the layer height, which the plot does not show.
 */
function skyCover(code) {
  if (code === null) return null;
  const cover = Math.floor(code / 100);
  if (cover <= 0) return 0;      // clear
  if (cover === 1) return 0.25;  // few
  if (cover === 2) return 0.5;   // scattered
  if (cover === 3) return 0.75;  // broken
  return 1;                      // overcast
}

/** Draws the circle, filled to the reported coverage. */
function drawSky(ctx, x, y, cover, colour, k = 1) {
  const r = 5.5 * k;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(0.6, 1.3 * k);
  ctx.stroke();

  if (cover === null) {
    // No report: the convention is a cross through the circle.
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.stroke();
    return;
  }
  if (cover <= 0) return;

  ctx.fillStyle = colour;
  if (cover >= 1) {
    ctx.beginPath();
    ctx.arc(x, y, r - 0.6 * k, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (cover === 0.5) {
    // Half cover is the right half filled, not a quadrant.
    ctx.beginPath();
    ctx.moveTo(x, y - r + 0.6 * k);
    ctx.arc(x, y, r - 0.6 * k, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, r - 0.6 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cover);
  ctx.closePath();
  ctx.fill();
}

/**
 * The wind barb: a shaft pointing into the wind, with flags for each 50 knots,
 * a full barb for each 10 and a half barb for each 5.
 */
function drawBarb(ctx, x, y, speed, direction, colour, k = 1) {
  if (speed === null || direction === null) return;
  const knots = Math.round(speed / 5) * 5;

  ctx.save();
  ctx.translate(x, y);
  // Meteorological direction is where the wind comes *from*, and the shaft
  // points that way; screen y grows downward, hence the offset.
  ctx.rotate(((direction + 180) % 360) * (Math.PI / 180));
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(0.6, 1.2 * k);
  ctx.lineCap = 'round';

  if (knots < 3) {
    // Calm: a second ring around the sky circle.
    ctx.beginPath();
    ctx.arc(0, 0, 8.5 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const shaft = 26 * k;
  ctx.beginPath();
  ctx.moveTo(0, -5.5 * k);
  ctx.lineTo(0, -5.5 * k - shaft);
  ctx.stroke();

  let remaining = knots;
  let along = -5.5 * k - shaft;
  const step = 5 * k;

  while (remaining >= 50) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(11 * k, along + 4 * k);
    ctx.lineTo(0, along + 8 * k);
    ctx.closePath();
    ctx.fill();
    remaining -= 50;
    along += 9 * k;
  }
  while (remaining >= 10) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(11 * k, along + 4.5 * k);
    ctx.stroke();
    remaining -= 10;
    along += step;
  }
  if (remaining >= 5) {
    ctx.beginPath();
    ctx.moveTo(0, along);
    ctx.lineTo(5.5 * k, along + 2.4 * k);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Sea-level pressure in whole hectopascals.
 *
 * The station model traditionally codes this to three digits — 1013.2 hPa as
 * `132` — which saves two characters and costs a reader who has not met the
 * convention any chance of reading it. Spelled out, it is unambiguous.
 */
export function pressureHpa(pascals) {
  if (pascals === null) return null;
  const hpa = pascals / 100;
  // Values outside this are a sensor fault, not weather.
  if (!(hpa > 800 && hpa < 1100)) return null;
  return String(Math.round(hpa));
}

/* ------------------------------------------------------------------ *
 * Present weather
 * ------------------------------------------------------------------ */

/**
 * Sorts a reported condition into one of the symbol families.
 *
 * The service returns prose — "light rain", "light rain,light drizzle",
 * "thunderstorm in vicinity" — so this reads keywords rather than a code table.
 * Order is priority order: a thunderstorm with rain is drawn as a thunderstorm,
 * and freezing rain is its own thing rather than rain.
 */
export function presentWeather(text) {
  if (typeof text !== 'string' || !text) return null;
  // Only the first condition is drawn; the rest are spelled out in the card.
  const first = text.toLowerCase().split(',')[0];

  const intensity = first.includes('heavy') ? 3 : (first.includes('light') ? 1 : 2);
  const shower = first.includes('shower');

  let family = null;
  if (first.includes('thunder')) family = 'thunder';
  else if (first.includes('freezing') || first.includes('frz')) family = 'freezing';
  else if (first.includes('hail') || first.includes('ice pellet')) family = 'hail';
  else if (first.includes('snow') || first.includes('sleet')) family = 'snow';
  else if (first.includes('drizzle')) family = 'drizzle';
  else if (first.includes('rain')) family = 'rain';
  else if (first.includes('fog')) family = 'fog';
  else if (first.includes('mist') || first.includes('haze') || first.includes('smoke')
    || first.includes('dust') || first.includes('sand')) family = 'haze';

  return family ? { family, intensity, shower } : null;
}

/**
 * Draws the present-weather symbol, left of the sky circle.
 *
 * These are the synoptic glyphs rather than the pictograms a forecast page uses:
 * dots for rain, commas for drizzle, stars for snow, a triangle under a shower,
 * bars for obscuration. They are the notation the rest of the plot is written
 * in, they stay legible at eight pixels, and repeating one is how that notation
 * says "harder".
 */
function drawWeather(ctx, x, y, report, colour, k = 1) {
  const wx = presentWeather(report);
  if (!wx) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(0.6, 1.1 * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  /** Horizontal positions for one, two or three repeated marks. */
  const spread = (n, gap = 2.2) => (n === 1 ? [0]
    : n === 2 ? [-gap * k, gap * k]
      : [-gap * 1.55 * k, 0, gap * 1.55 * k]);
  // A shower carries its precipitation above the triangle rather than over it.
  const lift = wx.shower ? -3.6 * k : 0;

  const dot = (dx, dy) => {
    ctx.beginPath();
    ctx.arc(dx, dy, 1.35 * k, 0, Math.PI * 2);
    ctx.fill();
  };
  const comma = (dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(dx, dy - 1.9 * k);
    ctx.quadraticCurveTo(dx + 1.5 * k, dy - 0.2 * k, dx - 0.6 * k, dy + 2.1 * k);
    ctx.stroke();
  };
  const star = (dx, dy) => {
    for (let i = 0; i < 3; i += 1) {
      const a = (i * 60) * (Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(dx - Math.cos(a) * 2.3 * k, dy - Math.sin(a) * 2.3 * k);
      ctx.lineTo(dx + Math.cos(a) * 2.3 * k, dy + Math.sin(a) * 2.3 * k);
      ctx.stroke();
    }
  };
  const bars = (n) => {
    for (let i = 0; i < n; i += 1) {
      const dy = (i - (n - 1) / 2) * 2.6 * k;
      ctx.beginPath();
      ctx.moveTo(-4.2 * k, dy);
      ctx.lineTo(4.2 * k, dy);
      ctx.stroke();
    }
  };

  if (wx.shower) {
    ctx.beginPath();
    ctx.moveTo(-3.2 * k, 4.4 * k);
    ctx.lineTo(0, -0.6 * k);
    ctx.lineTo(3.2 * k, 4.4 * k);
    ctx.stroke();
  }

  if (wx.family === 'rain') {
    for (const dx of spread(wx.intensity)) dot(dx, lift);
  } else if (wx.family === 'drizzle') {
    for (const dx of spread(wx.intensity)) comma(dx, lift);
  } else if (wx.family === 'snow') {
    for (const dx of spread(wx.intensity, 3.1)) star(dx, lift);
  } else if (wx.family === 'hail') {
    ctx.beginPath();
    ctx.moveTo(-3 * k, 2.6 * k);
    ctx.lineTo(0, -2.8 * k);
    ctx.lineTo(3 * k, 2.6 * k);
    ctx.closePath();
    ctx.fill();
  } else if (wx.family === 'freezing') {
    // The arc the freezing families are marked with, over a drop.
    ctx.beginPath();
    ctx.arc(0, 1.2 * k, 3.2 * k, Math.PI, 0);
    ctx.stroke();
    dot(0, 3.2 * k);
  } else if (wx.family === 'thunder') {
    // A bolt with an arrow foot: the synoptic form, reduced to what survives at
    // this size.
    ctx.beginPath();
    ctx.moveTo(-3.6 * k, -4 * k);
    ctx.lineTo(1.2 * k, -0.6 * k);
    ctx.lineTo(-1.6 * k, 0.8 * k);
    ctx.lineTo(3.2 * k, 4.4 * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0.6 * k, 4.4 * k);
    ctx.lineTo(3.2 * k, 4.4 * k);
    ctx.lineTo(2.6 * k, 1.9 * k);
    ctx.stroke();
  } else if (wx.family === 'fog') {
    bars(3);
  } else if (wx.family === 'haze') {
    bars(2);
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

let layer = null;
/** The scale the last draw used, for the 3D size check. */
let lastScale = 1;
/** Screen positions of the plots from the last draw, for hit-testing. */
let placed = [];

/**
 * The station plotted nearest a point on the map, within reach of a fingertip.
 *
 * The canvas is click-through, so the map delivers the event and the nearest
 * plot is found here — the same nearest-point idea a scatter chart needs, for
 * the same reason: nobody hits a 12px glyph dead centre.
 */
export function stationNear(containerPoint, radius = 22) {
  let best = null;
  let bestDistance = radius;
  for (const entry of placed) {
    const distance = Math.hypot(entry.x - containerPoint.x, entry.y - containerPoint.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = entry.station;
    }
  }
  return best;
}

// Reachable from the harness so the symbol set can be drawn as a contact sheet
// at a size a person can judge; eight-pixel glyphs cannot be reviewed in place.
if (typeof window !== 'undefined') window.__drawWeatherProbe = drawWeather;

/**
 * The stations actually drawn, after thinning.
 *
 * The 3D view needs these: the plots reach it as a captured picture with nothing
 * to hit-test, so the click is resolved by projecting the stations' own
 * positions. Only the drawn ones, because opening a card for a plot that lost
 * the thinning is a card for something nobody can see.
 */
export const plottedStations = () => placed.map((entry) => entry.station);

export const plotScale = () => lastScale;

/** Colour for a temperature, warm through cold, readable on a dark map. */
function tempColour(f) {
  if (f === null) return '#e2e8f0';
  const c = options.tempUnit === 'F' ? (f - 32) / 1.8 : f;
  if (c <= -20) return '#c4b5fd';
  if (c <= -10) return '#a5b4fc';
  if (c <= 0) return '#93c5fd';
  if (c <= 8) return '#7dd3fc';
  if (c <= 16) return '#86efac';
  if (c <= 24) return '#fde047';
  if (c <= 30) return '#fb923c';
  return '#f87171';
}

const ObservationLayer = L.Layer.extend({
  onAdd(target) {
    this._canvas = L.DomUtil.create('canvas', 'synoptic-canvas');
    this._canvas.style.position = 'absolute';
    this._canvas.style.pointerEvents = 'none';
    target.getPane('synopticPane').append(this._canvas);
    target.on('moveend zoomend resize', this._reset, this);
    this._reset();
  },

  onRemove(target) {
    target.off('moveend zoomend resize', this._reset, this);
    this._canvas?.remove();
    this._canvas = null;
  },

  _reset() {
    if (!this._canvas) return;
    const size = map.getSize();
    const dpr = Math.max(1, Math.min(Math.ceil((window.devicePixelRatio || 1) - 1e-3), 2));
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    this._dpr = dpr;
    this.render();
  },

  render() {
    const canvas = this._canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = this._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (!options.enabled || !stations.length) return;

    const size = map.getSize();
    // Staleness is measured against the moment being shown, not against now.
    // Judging a historical observation by how long ago it was taken discarded
    // every one of them the instant the scrubber left the live edge: 473
    // stations held, none drawn.
    const reference = observedAt ? observedAt.getTime() : Date.now();
    const cutoff = reference - options.maxAgeMinutes * 60000;
    // A nearest-time lookup can return a report a little after the requested
    // moment, which is still the right one to show.
    const ceiling = reference + options.maxAgeMinutes * 60000;

    // In 3D this canvas is captured and stretched over the GL scene, by however
    // much lower a zoom the composite was taken at. Anything drawn at a fixed
    // pixel size is stretched with it — measured at twice the intended size at
    // 45 degrees of pitch, four times at 60 and eight times at 70 — so the plot
    // is drawn correspondingly smaller and lands the right size on screen.
    // Spacing goes with it, or the thinning would leave the view half empty.
    const k = is3D() ? 1 / Math.max(1, mirrorMagnification()) : 1;
    lastScale = k;

    // Thinning by screen distance, on a grid rather than by comparing every pair:
    // several hundred plots against each other is quadratic and shows up as a
    // stutter while panning.
    const cell = Math.max(10, options.spacing * k);
    const taken = new Set();
    let drawn = 0;
    // Where each plot ended up, so a click can find the station under it.
    placed = [];

    const bodyFont = `600 ${(11 * k).toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
    const idFont = `500 ${(9 * k).toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.font = bodyFont;
    ctx.textBaseline = 'middle';

    for (const station of stations) {
      if (station.at && (station.at < cutoff || station.at > ceiling)) continue;
      const point = map.latLngToContainerPoint([station.lat, station.lon]);
      if (point.x < -40 || point.y < -40 || point.x > size.x + 40 || point.y > size.y + 40) continue;

      const key = `${Math.round(point.x / cell)}:${Math.round(point.y / cell)}`;
      if (taken.has(key)) continue;
      taken.add(key);

      const x = Math.round(point.x);
      const y = Math.round(point.y);
      const ink = '#e2e8f0';

      drawSky(ctx, x, y, skyCover(station.cloud), ink, k);
      drawBarb(ctx, x, y, station.speed, station.direction, ink, k);
      drawWeather(ctx, x - 14 * k, y, station.weather, '#cbd5e1', k);

      ctx.textAlign = 'right';
      if (station.temp !== null) {
        ctx.fillStyle = tempColour(station.temp);
        ctx.fillText(String(Math.round(station.temp)), x - 9 * k, y - 10 * k);
      }
      if (station.dew !== null) {
        ctx.fillStyle = '#7dd3fc';
        ctx.fillText(String(Math.round(station.dew)), x - 9 * k, y + 11 * k);
      }

      ctx.textAlign = 'left';
      if (options.showPressure) {
        const hpa = pressureHpa(station.mslp);
        if (hpa) {
          ctx.fillStyle = ink;
          ctx.fillText(hpa, x + 9 * k, y - 10 * k);
        }
      }
      if (options.showIdentifier && station.id) {
        ctx.fillStyle = 'rgba(148,163,184,0.85)';
        ctx.font = idFont;
        ctx.fillText(station.id, x + 9 * k, y + 12 * k);
        ctx.font = bodyFont;
      }
      placed.push({ x, y, station });
      drawn += 1;
    }

    this._drawn = drawn;
  },

  drawnCount() {
    return this._drawn || 0;
  },
});

/** Stations currently plotted, after thinning. */
export const plottedCount = () => layer?.drawnCount?.() ?? 0;

export function ensureLayer() {
  if (!layer) layer = new ObservationLayer();
  if (!map.hasLayer(layer)) layer.addTo(map);
  return layer;
}

export function draw() {
  if (!options.enabled) return;
  ensureLayer().render();
}

export function setVisible(visible) {
  options.enabled = visible;
  if (!visible) {
    stopPolling();
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    return;
  }
  ensureLayer();
  load({ force: true }).then(() => draw());
  startPolling();
}

/**
 * Follows the scrubber.
 *
 * Called on every committed time change; the bucketing and the cache key mean a
 * nudge inside ten minutes costs nothing, and a real move re-requests once.
 */
export function onTimeChanged() {
  if (!options.enabled) return;
  load().then(() => draw());
}

/** Re-fetches when the view has moved somewhere the cached window does not cover. */
export function onViewChanged() {
  if (!options.enabled) return;
  load().then(() => draw());
}

/** Applies a settings change: some need new data, all need a redraw. */
export function applyOptions({ refetch = false } = {}) {
  if (refetch) load({ force: true }).then(() => draw());
  else draw();
  startPolling();
}
