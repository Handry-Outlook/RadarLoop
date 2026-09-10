/**
 * Where the sun is.
 *
 * The visible/infrared satellite composite needs this: the visible channel is a
 * photograph, so it carries nothing on the night side of the terminator and has
 * to give way to infrared there. Deciding that from the imagery itself is
 * unreliable — a fully lit cumulonimbus top and an unlit ocean are both flat
 * fields — whereas the solar elevation at a pixel is simply calculable.
 *
 * The accuracy needed is low. An error of a tenth of a degree in the sun's
 * position moves the terminator by a few kilometres, well inside the band the
 * composite blends across anyway, so the low-precision series below is ample and
 * the expensive terms are left out.
 */

/** 2000-01-01T12:00Z, the epoch the series below are written against. */
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
const RAD = Math.PI / 180;

/**
 * The sun's declination and right ascension, plus Greenwich sidereal time.
 *
 * Computed once per frame rather than per pixel — none of it varies across a
 * tile.
 *
 * @param {number} atMs
 * @returns {{sinDec: number, cosDec: number, raDeg: number, gmstDeg: number}}
 */
export function sunPosition(atMs) {
  const n = (atMs - J2000) / 86400000;

  const meanLongitude = (280.460 + 0.9856474 * n) * RAD;
  const meanAnomaly = (357.528 + 0.9856003 * n) * RAD;
  // Equation of the centre, to two terms.
  const lambda = meanLongitude
    + (1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;

  const sinDec = Math.sin(obliquity) * Math.sin(lambda);
  const gmstHours = (18.697374558 + 24.06570982441908 * n) % 24;

  return {
    sinDec,
    cosDec: Math.sqrt(Math.max(0, 1 - sinDec * sinDec)),
    raDeg: Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda)) / RAD,
    gmstDeg: (gmstHours < 0 ? gmstHours + 24 : gmstHours) * 15,
  };
}

/**
 * Sine of the sun's elevation above the horizon at a point.
 *
 * The sine rather than the angle: every caller compares it against a threshold,
 * and comparing sines avoids an arcsine per pixel.
 *
 * @param {ReturnType<typeof sunPosition>} sun
 * @param {number} latDeg
 * @param {number} lonDeg
 */
export function sinSolarElevation(sun, latDeg, lonDeg) {
  const hourAngle = (sun.gmstDeg + lonDeg - sun.raDeg) * RAD;
  const lat = latDeg * RAD;
  return Math.sin(lat) * sun.sinDec + Math.cos(lat) * sun.cosDec * Math.cos(hourAngle);
}

/** Sine of 0° and of 10° — the elevations the composite fades between. */
export const NIGHT_SIN = 0;
export const DAY_SIN = Math.sin(10 * RAD);

/**
 * How much of the visible channel to trust at a given solar elevation.
 *
 * Zero at and below the horizon, one once the sun is 10° up, smoothly in
 * between. The band is generous on purpose: visible imagery is dim and noisy for
 * a while after sunrise, and a hard edge at the terminator would read as a seam
 * drawn across the map.
 */
export function daylightWeight(sinElevation) {
  const t = (sinElevation - NIGHT_SIN) / (DAY_SIN - NIGHT_SIN);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
