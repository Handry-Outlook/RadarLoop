/**
 * The card behind a station model.
 *
 * Clicking a plot opens the current reading in full, and a day of history as a
 * chart. The station plot is a summary by design — six values in a dozen strokes
 * — so the card is where the rest of the observation lives.
 *
 * ## One chart at a time
 *
 * Temperature, pressure, wind, rain and snow share nothing but a time axis. A
 * single plot would need five value scales, and a chart with two y-axes is the
 * most reliable way to make unrelated series look related; stacking five panels
 * instead is honest but turns the card into a page nobody scrolls to the end of.
 * A picker names them and shows one, which also means the visible chart can be
 * tall enough to read.
 *
 * Only the charts a station actually reports are offered. Most airfields send no
 * snow and many send no rain, and an empty axis is worse than a shorter menu.
 *
 * ## Colour
 *
 * Two series per chart, from the validated categorical pair — blue and orange,
 * assigned by meaning rather than by order: the warm hue is the warm variable in
 * every panel (temperature over dew point, gust over mean wind). Checked with
 * the palette validator against both surfaces, all pairs: worst CVD ΔE 26.8
 * dark / 24.7 light, worst normal-vision ΔE 31.8 / 33.6, both above 3:1 contrast.
 */

import { el } from '../core/util.js';
import * as synoptic from '../layers/synoptic.js';

const SVG = 'http://www.w3.org/2000/svg';

const node = (name, attrs = {}) => {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) element.setAttribute(key, String(value));
  }
  return element;
};

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const UNITS = {
  F: '°F', C: '°C', kts: 'kt', mph: 'mph', ms: 'm/s',
};

const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

function clockOf(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Compass point for a bearing, which reads faster than three digits. */
function compass(degrees) {
  if (degrees === null || degrees === undefined) return null;
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(degrees / 22.5) % 16];
}

/** A bearing as both, which is what a forecaster reads out loud. */
const bearing = (v) => (v === null || v === undefined ? null : `${compass(v)} ${Math.round(v)}°`);

/**
 * Times to label the axis with.
 *
 * Aligned to round local hours rather than to the first reading: an axis reading
 * 06:00 09:00 12:00 is a clock, one reading 06:47 09:47 12:47 is a puzzle. About
 * four labels across 320px is as many as fit without them touching.
 */
export function axisTicks(t0, t1) {
  const minute = 60000;
  const steps = [15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * minute);
  const target = (t1 - t0) / 4;
  const step = steps.find((s) => s >= target) ?? steps[steps.length - 1];
  // Local, not UTC: a six-hour step aligned to UTC lands on 01:00 and 07:00
  // through a British summer.
  const offset = new Date(t0).getTimezoneOffset() * minute;
  const out = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) out.push(t);
  return out;
}

/* ------------------------------------------------------------------ *
 * One chart
 * ------------------------------------------------------------------ */

const CHART = {
  width: 320, plotH: 104, padLeft: 38, padRight: 10, padTop: 12, axisH: 20, arrowH: 18,
};

/**
 * Builds one panel: a value axis, a time axis, a hairline grid, and either 2px
 * lines or bars.
 *
 * A series marked `arrows` is not plotted against the value scale at all — wind
 * direction is a bearing, and a bearing on a speed axis is the dual-axis mistake
 * wearing a disguise. It becomes a row of arrows under the plot instead, sharing
 * the time axis, and still reports itself to the crosshair and the table.
 *
 * Returns the element plus a `readAt` the crosshair calls.
 */
function buildChart({ title, series, unit, format = round1, type = 'line', zeroBased = false }) {
  const { width, plotH, padLeft, padRight, padTop, axisH, arrowH } = CHART;
  const plotW = width - padLeft - padRight;

  const lines = series.filter((s) => !s.arrows);
  const arrows = series.find((s) => s.arrows) || null;
  const height = padTop + plotH + (arrows ? arrowH : 0) + axisH;

  const points = lines.flatMap((s) => s.values.filter((v) => v !== null));
  if (!points.length) return null;

  const times = series[0].times;
  const t0 = times[0];
  const t1 = times[times.length - 1];

  let lo = zeroBased ? 0 : Math.min(...points);
  let hi = Math.max(...points);
  if (hi - lo < 1e-6) hi = lo + 1;
  if (!zeroBased) {
    // A little air above and below so the line never rides the frame.
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  } else {
    hi *= 1.12;
  }

  const xOf = (t) => padLeft + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const yOf = (v) => padTop + (1 - (v - lo) / (hi - lo)) * plotH;
  const baseY = padTop + plotH;

  const svg = node('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    class: 'wxchart', role: 'img', 'aria-label': title,
  });

  // Grid: hairline, solid, recessive — three lines is enough to read against.
  for (const frac of [0, 0.5, 1]) {
    const y = padTop + frac * plotH;
    svg.append(node('line', { x1: padLeft, x2: width - padRight, y1: y, y2: y, class: 'wxchart__grid' }));
  }

  // Value ticks at the extremes, where the data actually reaches, with as many
  // decimals as the range needs: an hour of drizzle spans a few hundredths of a
  // millimetre, and rounding that to whole numbers labelled both ends "0".
  const range = hi - lo;
  const digits = range >= 10 ? 0 : range >= 1 ? 1 : range >= 0.1 ? 2 : 3;
  const inset = zeroBased ? 0 : range * 0.12 / 1.24;
  for (const value of [hi - inset, lo + inset]) {
    svg.append(Object.assign(node('text', {
      x: padLeft - 6, y: yOf(value) + 3, class: 'wxchart__tick', 'text-anchor': 'end',
    }), { textContent: value.toFixed(digits) }));
  }

  // Time axis: the reader needs to know whether a rise happened overnight.
  svg.append(node('line', {
    x1: padLeft, x2: width - padRight, y1: height - axisH + 2, y2: height - axisH + 2,
    class: 'wxchart__axis',
  }));
  for (const t of axisTicks(t0, t1)) {
    const x = xOf(t);
    svg.append(node('line', {
      x1: x, x2: x, y1: height - axisH + 2, y2: height - axisH + 5, class: 'wxchart__axis',
    }));
    svg.append(Object.assign(node('text', {
      x, y: height - 4, class: 'wxchart__tick', 'text-anchor': 'middle',
    }), { textContent: clockOf(t) }));
  }

  for (const s of lines) {
    if (type === 'bar') {
      // Magnitude per interval, so bars from a zero baseline, with the 4px
      // rounded top the mark spec asks for and a 2px gap between neighbours.
      const w = Math.max(1.5, (plotW / Math.max(1, s.values.length)) - 2);
      s.values.forEach((v, i) => {
        if (!v) return;
        const h = baseY - yOf(v);
        if (h <= 0) return;
        const r = Math.min(4, w / 2, h);
        const x = xOf(s.times[i]) - w / 2;
        svg.append(node('path', {
          d: `M${x} ${baseY}V${baseY - h + r}q0 ${-r} ${r} ${-r}h${w - 2 * r}q${r} 0 ${r} ${r}V${baseY}z`,
          class: 'wxchart__bar', style: `fill:${s.colour}`,
        }));
      });
      continue;
    }

    // Gaps break the line rather than being bridged: a missing report is not a
    // straight-line hour of weather.
    let d = '';
    let open = false;
    s.values.forEach((v, i) => {
      if (v === null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${xOf(s.times[i]).toFixed(1)} ${yOf(v).toFixed(1)}`;
      open = true;
    });
    if (d) svg.append(node('path', { d, class: 'wxchart__line', style: `stroke:${s.colour}` }));

    // The latest value, marked once — never a number on every point.
    const lastIndex = s.values.reduce((acc, v, i) => (v === null ? acc : i), -1);
    if (lastIndex >= 0) {
      svg.append(node('circle', {
        cx: xOf(s.times[lastIndex]), cy: yOf(s.values[lastIndex]), r: 3.5,
        class: 'wxchart__end', style: `fill:${s.colour}`,
      }));
    }
  }

  if (arrows) {
    // Eight or so along the axis: one per reading would be a smear at this width.
    const rowY = padTop + plotH + arrowH / 2 + 2;
    const wanted = Math.min(9, arrows.values.length);
    for (let n = 0; n < wanted; n += 1) {
      const i = Math.round((n / Math.max(1, wanted - 1)) * (arrows.values.length - 1));
      const v = arrows.values[i];
      if (v === null) continue;
      // Meteorological bearing is where the wind comes from; the arrow flies the
      // way the air is going, so it is turned through half a circle.
      svg.append(node('path', {
        d: 'M0 -5L0 5M0 5L-2.6 1.4M0 5L2.6 1.4',
        class: 'wxchart__arrow',
        transform: `translate(${xOf(arrows.times[i]).toFixed(1)} ${rowY}) rotate(${(v + 180) % 360})`,
      }));
    }
  }

  const hair = node('line', { y1: padTop, y2: padTop + plotH, class: 'wxchart__hair', visibility: 'hidden' });
  svg.append(hair);

  const readAt = (index) => {
    if (index === null) {
      hair.setAttribute('visibility', 'hidden');
      return null;
    }
    hair.setAttribute('visibility', 'visible');
    hair.setAttribute('x1', xOf(times[index]));
    hair.setAttribute('x2', xOf(times[index]));
    return series
      .map((s) => ({
        label: s.label,
        colour: s.arrows ? null : s.colour,
        value: (s.format || format)(s.values[index]),
        unit: s.arrows ? '' : unit,
      }))
      .filter((r) => r.value !== null && r.value !== undefined);
  };

  return { svg, readAt, unit, title, series, times, xOf };
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

function readingRow(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return el('div', { class: 'wxcard__reading' }, [
    el('span', { class: 'wxcard__reading-label' }, label),
    el('span', { class: 'wxcard__reading-value' }, String(value)),
  ]);
}

/** The current observation, spelled out. */
function buildReadings(station) {
  const t = UNITS[synoptic.options.tempUnit] || '';
  const w = UNITS[synoptic.options.windUnit] || '';
  const wind = station.speed === null ? null
    : `${Math.round(station.speed)} ${w}${station.direction === null ? '' : ` ${compass(station.direction)}`}`;

  return el('div', { class: 'wxcard__readings' }, [
    readingRow('Temperature', station.temp === null ? null : `${round1(station.temp)} ${t}`),
    readingRow('Dew point', station.dew === null ? null : `${round1(station.dew)} ${t}`),
    readingRow('Humidity', station.humidity === null ? null : `${Math.round(station.humidity)} %`),
    readingRow('Wind', wind),
    readingRow('Gust', station.gust === null ? null : `${Math.round(station.gust)} ${w}`),
    readingRow('Pressure', synoptic.pressureHpa(station.mslp) ? `${synoptic.pressureHpa(station.mslp)} hPa` : null),
    readingRow('Rain, 1 h', station.rain1h === null ? null : `${round1(station.rain1h)} mm`),
    readingRow('Rain, 24 h', station.rain24h === null ? null : `${round1(station.rain24h)} mm`),
    readingRow('Snow depth', station.snowDepth === null ? null : `${round1(station.snowDepth)} mm`),
    readingRow('Visibility', station.visibility === null ? null : `${round1(station.visibility)} mi`),
    readingRow('Elevation', station.elevation === null ? null : `${Math.round(station.elevation)} ft`),
  ].filter(Boolean));
}

/** A legend row: a short stroke of the series colour, then its name. */
function legend(series) {
  return el('div', { class: 'wxchart__legend' }, series.map((s) => el('span', { class: 'wxchart__legend-item' }, [
    el('span', { class: 'wxchart__legend-key', style: { background: s.colour } }),
    el('span', {}, s.label),
  ])));
}

/** The reachable-without-hovering copy of whichever chart is showing. */
function buildTable(panel) {
  const columns = panel.series;
  const head = el('tr', {}, [el('th', {}, 'Time'), ...columns.map((s) => el('th', {}, s.label))]);
  const rows = panel.times.map((t, i) => el('tr', {}, [
    el('td', {}, clockOf(t)),
    ...columns.map((s) => {
      const value = (s.format || round1)(s.values[i]);
      return el('td', {}, value === null || value === undefined ? '—' : String(value));
    }),
  ]));
  return el('table', { class: 'wxcard__table' }, [el('thead', {}, head), el('tbody', {}, rows)]);
}

/**
 * Every chart this station can support, in the order the picker offers them.
 *
 * `buildChart` returns null when a series is entirely empty, so the filter at
 * the end is what keeps a station that reports no rain from being offered a
 * rain chart.
 */
function buildPanels(history) {
  const t = UNITS[synoptic.options.tempUnit] || '';
  const w = UNITS[synoptic.options.windUnit] || '';
  const times = history.times;
  const rain = history.rainHourly;
  const snow = history.snowHourly;

  return [
    buildChart({
      title: `Temperature and dew point (${t})`,
      unit: t,
      series: [
        { label: 'Temperature', colour: 'var(--viz-warm)', values: history.temp, times },
        { label: 'Dew point', colour: 'var(--viz-cool)', values: history.dew, times },
      ],
    }),
    buildChart({
      title: `Wind (${w})`,
      unit: w,
      series: [
        { label: 'Gust', colour: 'var(--viz-warm)', values: history.gust, times },
        { label: 'Mean', colour: 'var(--viz-cool)', values: history.speed, times },
        { label: 'Direction', values: history.direction, times, arrows: true, format: bearing },
      ],
    }),
    buildChart({
      title: 'Pressure (hPa)',
      unit: 'hPa',
      series: [{ label: 'Pressure', colour: 'var(--viz-cool)', values: history.mslp, times }],
    }),
    buildChart({
      title: 'Humidity (%)',
      unit: '%',
      format: (v) => (v === null ? null : Math.round(v)),
      series: [{ label: 'Humidity', colour: 'var(--viz-cool)', values: history.humidity, times }],
    }),
    rain && buildChart({
      title: 'Rainfall each hour (mm)',
      unit: 'mm',
      type: 'bar',
      zeroBased: true,
      format: round2,
      series: [{ label: 'Rainfall', colour: 'var(--viz-cool)', values: rain.values, times: rain.times }],
    }),
    history.rainTotal && buildChart({
      title: 'Rainfall accumulated (mm)',
      unit: 'mm',
      zeroBased: true,
      format: round2,
      series: [{ label: 'Total rainfall', colour: 'var(--viz-cool)', values: history.rainTotal, times }],
    }),
    snow && buildChart({
      title: 'Snowfall each hour (mm)',
      unit: 'mm',
      type: 'bar',
      zeroBased: true,
      format: round2,
      series: [{ label: 'Snowfall', colour: 'var(--viz-cool)', values: snow.values, times: snow.times }],
    }),
    history.snowTotal && buildChart({
      title: 'Snowfall accumulated (mm)',
      unit: 'mm',
      zeroBased: true,
      format: round2,
      series: [{ label: 'Total snowfall', colour: 'var(--viz-cool)', values: history.snowTotal, times }],
    }),
    buildChart({
      title: 'Snow depth (mm)',
      unit: 'mm',
      zeroBased: true,
      series: [{ label: 'Snow depth', colour: 'var(--viz-cool)', values: history.snowDepth, times }],
    }),
  ].filter(Boolean);
}

/**
 * Builds the card for one station.
 *
 * The charts arrive after the history does; the card renders immediately with
 * the current reading so a click always produces something.
 *
 * @param {object} station
 * @param {object} options
 * @param {() => void} options.onReady
 *   Called once the charts are in. The card opens small — a line of loading
 *   text — so whatever positions it does so against that size and never sees it
 *   grow by four hundred pixels when the history lands; in a popup anchored
 *   above its marker that pushed the header off the top of the map.
 */
export function buildStationCard(station, { onReady } = {}) {
  const charts = el('div', { class: 'wxcard__charts wxcard__charts--pending' }, [
    el('div', { class: 'wxcard__loading' }, 'Loading the last 24 hours…'),
  ]);

  const card = el('div', { class: 'wxcard' }, [
    el('header', { class: 'wxcard__head' }, [
      el('div', { class: 'wxcard__name truncate' }, station.name || station.id),
      el('div', { class: 'wxcard__sub' }, [
        el('span', { class: 'wxcard__id' }, station.id || ''),
        station.weather ? el('span', { class: 'wxcard__wx' }, String(station.weather)) : null,
        station.at ? el('span', {}, `observed ${clockOf(station.at)}`) : null,
      ].filter(Boolean)),
    ]),
    buildReadings(station),
    charts,
  ]);

  synoptic.fetchTimeseries(station.id)
    .then((history) => {
      const panels = buildPanels(history);
      if (!panels.length) {
        charts.classList.remove('wxcard__charts--pending');
        charts.replaceChildren(el('div', { class: 'wxcard__loading' }, 'No history for this station.'));
        onReady?.();
        return;
      }

      const readout = el('div', { class: 'wxchart__readout' });
      const plot = el('div', { class: 'wxcard__panels' });
      const table = el('div', { class: 'wxcard__table-host', hidden: true });
      const toggle = el('button', {
        class: 'btn btn--ghost wxcard__table-toggle',
        onClick: () => {
          table.hidden = !table.hidden;
          toggle.textContent = table.hidden ? 'Show readings as a table' : 'Hide table';
        },
      }, 'Show readings as a table');

      let current = panels[0];

      const clear = () => {
        current.readAt(null);
        readout.replaceChildren();
        return undefined;
      };

      // The crosshair aims at a moment and reports every series at it. The
      // nearest reading rather than the one under the pointer: readings are
      // minutes apart and the pointer is not.
      const track = (event) => {
        const rect = current.svg.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * CHART.width;
        if (x < CHART.padLeft || x > CHART.width - CHART.padRight) return clear();
        const times = current.times;
        const span = CHART.width - CHART.padLeft - CHART.padRight;
        const at = times[0] + ((x - CHART.padLeft) / span) * (times[times.length - 1] - times[0]);
        let index = 0;
        for (let i = 1; i < times.length; i += 1) {
          if (Math.abs(times[i] - at) < Math.abs(times[index] - at)) index = i;
        }
        readout.replaceChildren(
          el('span', { class: 'wxchart__readout-time' }, clockOf(times[index])),
          ...(current.readAt(index) || []).map((r) => el('span', { class: 'wxchart__readout-item' }, [
            r.colour ? el('span', { class: 'wxchart__legend-key', style: { background: r.colour } }) : null,
            // Value leads, label follows: the reader has the series and wants the number.
            el('strong', {}, `${r.value}${r.unit ? ` ${r.unit}` : ''}`),
            el('span', { class: 'dim' }, r.label),
          ].filter(Boolean))),
        );
        return undefined;
      };

      const show = (panel) => {
        current = panel;
        const drawn = panel.series.filter((s) => !s.arrows);
        plot.replaceChildren(...[
          // A single series needs no legend: the title already names it.
          drawn.length > 1 ? legend(drawn) : null,
          panel.svg,
          panel.series.some((s) => s.arrows)
            ? el('div', { class: 'wxchart__note' }, 'Arrows fly the way the wind is blowing')
            : null,
        ].filter(Boolean));
        readout.replaceChildren();
        table.replaceChildren(buildTable(panel));
      };

      const picker = el('select', {
        class: 'wxcard__pick',
        'aria-label': 'Which chart to show',
        onChange: (event) => show(panels[Number(event.target.value)]),
      }, panels.map((panel, i) => el('option', { value: String(i) }, panel.title)));

      plot.addEventListener('pointermove', track);
      plot.addEventListener('pointerleave', clear);

      show(panels[0]);
      charts.classList.remove('wxcard__charts--pending');
      charts.replaceChildren(picker, plot, readout, toggle, table);
      onReady?.();
    })
    .catch((error) => {
      charts.classList.remove('wxcard__charts--pending');
      charts.replaceChildren(el('div', { class: 'wxcard__loading' },
        `History unavailable — ${String(error.message || error)}`));
      onReady?.();
    });

  return card;
}
