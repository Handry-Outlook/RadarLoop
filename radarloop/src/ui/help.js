/** The help / tutorial modal. */

import { el } from '../core/util.js';
import { modal } from './components.js';

const section = (title, body) => el('section', {}, [el('h4', {}, title), ...[].concat(body)]);
const list = (items) => el('ul', {}, items.map((item) => el('li', { html: item })));

export function showHelp() {
  modal({
    title: 'RadarLoop guide',
    actions: [{ label: 'Close', primary: true }],
    body: [
      section('Getting around', [
        el('p', {}, 'The icon rail on the left opens one panel group at a time. Click the same icon again to close it. A green dot on an icon means that group has a layer switched on.'),
        list([
          'Press <kbd>/</kbd> to search all 169 weather products by name.',
          'Press <kbd>Space</kbd> to play or pause the animation.',
          'Press <kbd>←</kbd> and <kbd>→</kbd> to step one frame.',
          'Press <kbd>L</kbd> to jump back to the latest frame.',
        ]),
      ]),

      section('The timeline', [
        el('p', {}, 'The scrubber spans the history window set in Settings, with the newest frame at the right. The chip beside the clock shows whether you are at the live edge or how far back you are.'),
        el('p', {}, 'Weather layers keep the previous frame on screen while the next one loads, so scrubbing does not flash through to the base map.'),
      ]),

      section('Weather layers', [
        list([
          '<strong>Radar &amp; satellite</strong> — precipitation composites and cloud imagery from several providers, global and regional.',
          '<strong>Pressure &amp; wind</strong> — isobars, surface fronts and wind fields.',
          '<strong>Severe &amp; warnings</strong> — storm and hail threats, rotation tracks, tropical systems and official alerts.',
          '<strong>Observations</strong> — surface fields, marine data and accumulated precipitation.',
        ]),
        el('p', {}, 'The Global High Resolution composite and the European reflectivity grid share one editable rainfall colour scale, found under the radar card. Changing a preset updates both layers and the legend together.'),
      ]),

      section('Lightning', [
        el('p', {}, 'UK strikes are live, backfilled from seasonal archives. They are drawn on a single canvas, so tens of thousands render without slowing the map.'),
        list([
          '<strong>Colour by age</strong> shades newest strikes gold through to oldest indigo.',
          '<strong>Heatmap</strong> and <strong>cell counter</strong> show density instead of individual strikes.',
          '<strong>Storm projections</strong> cluster recent strikes, fit a motion vector and project each cell forward. Confidence is shown in the popup; raise the minimum to show only well-established cells.',
        ]),
      ]),

      section('Outlooks', [
        el('p', {}, 'Manual HOCO shows published Handry Outlook forecasts by risk category; Auto HOCO shows automated runs coloured by lightning probability. Days with an outlook are marked in each calendar.'),
      ]),

      section('Tools', [
        list([
          '<strong>Drawing</strong> — draw risk polygons and export them as KML. Severe is drawn outline-only.',
          '<strong>File overlays</strong> — import a KML, or an image that is georeferenced automatically when its filename names a region.',
          '<strong>Export</strong> — drag an area to save the strikes in the current window as a PNG.',
          '<strong>Accumulation</strong> — integrate radar over a time window into a total-rainfall map, then click for a point total.',
        ]),
      ]),

      section('Performance', [
        el('p', {}, 'Settings offers Auto, Quality and Fast rendering modes. Fast reduces the nowcast cluster count, the strike ceiling and network concurrency, which helps on older phones. The diagnostics block there shows how many frames were rendered, skipped and served from cache.'),
      ]),
    ],
  });
}
