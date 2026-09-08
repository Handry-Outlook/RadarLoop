/**
 * Tools panel: polygon drawing and KML export, file overlays, strike export and
 * the rainfall accumulation calculator.
 */

import { RISK_LEVELS } from '../config.js';
import { el, toDateTimeLocal } from '../core/util.js';
import { lightning, time } from '../core/state.js';
import { map } from '../core/map.js';
import * as draw from '../tools/draw.js';
import * as files from '../tools/overlayFiles.js';
import * as accumulation from '../tools/accumulation.js';
import { dateTimeField, disclosure, opacityRow, sectionTitle, switchRow, toast } from './components.js';
import { selectField } from './components.js';

function buildDrawingSection() {
  const riskPicker = selectField({
    label: 'Risk category',
    options: RISK_LEVELS.map((r) => ({ value: r.id, label: r.id })),
    value: draw.currentRisk.value,
    onChange: (value) => draw.setRisk(value),
  });

  const drawButton = el('button', {
    class: 'btn btn--primary btn--block',
    onClick: () => {
      const on = draw.toggleDrawing();
      drawButton.textContent = on ? 'Stop drawing' : 'Start drawing';
      if (!on && !draw.isDrawing()) toast('Drawing disabled');
    },
  }, 'Start drawing');

  return el('div', { class: 'stack' }, [
    sectionTitle('Polygon drawing'),
    riskPicker.node,
    drawButton,
    opacityRow({
      label: 'Fill opacity',
      value: draw.polygonStyle().opacity,
      onInput: (value) => draw.setPolygonOpacity(value),
    }).node,
    opacityRow({
      label: 'Outline',
      value: draw.polygonStyle().weight,
      min: 1,
      max: 10,
      step: 1,
      format: (v) => `${Math.round(v)}px`,
      onInput: (value) => draw.setPolygonWeight(value),
    }).node,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn',
        onClick: () => {
          if (!draw.exportKML()) toast('Draw at least one polygon first', { tone: 'error' });
          else toast('KML exported', { tone: 'success' });
        },
      }, 'Export KML'),
      el('button', {
        class: 'btn btn--danger',
        onClick: () => {
          draw.clearDrawn();
          toast('Drawn polygons cleared');
        },
      }, 'Clear'),
    ]),
  ]);
}

function buildImportSection() {
  const kmlInput = el('input', { type: 'file', class: 'input', accept: '.kml' });
  const kmlToggle = switchRow({
    label: 'Show KML overlay',
    checked: false,
    onChange: (checked) => draw.setKmlVisible(checked),
  });

  kmlInput.addEventListener('change', async () => {
    const file = kmlInput.files?.[0];
    if (!file) return;
    try {
      await draw.importKML(file);
      kmlToggle.input.checked = true;
      draw.setKmlVisible(true);
      toast(`Imported ${file.name}`, { tone: 'success' });
    } catch (error) {
      toast(error.message || 'Could not read that KML', { tone: 'error' });
    }
  });

  const pngInput = el('input', { type: 'file', class: 'input', accept: '.png,.jpg,.jpeg' });
  const pngToggle = switchRow({
    label: 'Show image overlay',
    checked: false,
    onChange: (checked) => files.setPngVisible(checked),
  });

  pngInput.addEventListener('change', async () => {
    const file = pngInput.files?.[0];
    if (!file) return;
    try {
      const result = await files.importPNG(file);
      pngToggle.input.checked = true;
      files.setPngVisible(true);
      toast(result.matchedRegion
        ? `Placed ${file.name} over its named region`
        : `Placed ${file.name} over the current view`, { tone: 'success' });
    } catch (error) {
      toast(error.message || 'Could not read that image', { tone: 'error' });
    }
  });

  return el('div', { class: 'stack' }, [
    sectionTitle('File overlays'),
    el('div', { class: 'field' }, [el('span', { class: 'field__label' }, 'KML file'), kmlInput]),
    kmlToggle.node,
    el('div', { class: 'field' }, [el('span', { class: 'field__label' }, 'Image overlay'), pngInput]),
    pngToggle.node,
    opacityRow({
      label: 'Image opacity',
      value: 0.8,
      onInput: (value) => files.setPngOpacity(value),
    }).node,
    el('p', { class: 'tiny dim' },
      'Images whose filename names a region (England, Scotland, Wales, UK…) are georeferenced to it automatically.'),
  ]);
}

function buildExportSection() {
  return el('div', { class: 'stack' }, [
    sectionTitle('Export'),
    el('button', {
      class: 'btn btn--block',
      onClick: async () => {
        toast('Drag a rectangle on the map — Escape to cancel');
        const bounds = await files.pickRectangle();
        if (!bounds) return;
        const ok = await files.exportStrikesPng(lightning.filtered, bounds);
        toast(ok ? 'Strike image exported' : 'Nothing to export in that area', { tone: ok ? 'success' : 'error' });
      },
    }, 'Export strikes as PNG'),
    el('p', { class: 'tiny dim' },
      'Renders the strikes currently in the time window for an area you select.'),
  ]);
}

function buildAccumulationSection() {
  const start = dateTimeField({ label: 'Start', value: toDateTimeLocal(time.current - 3600 * 1000) });
  const end = dateTimeField({ label: 'End', value: toDateTimeLocal(time.current) });

  const status = el('p', { class: 'tiny dim' }, 'Generates a total-rainfall map for the current view.');
  const dial = el('div', { class: 'progress__dial', 'data-pct': '0%' });
  const progressText = el('div', { class: 'progress__text' }, 'Preparing…');
  const progress = el('div', { class: 'progress', hidden: true }, [dial, progressText]);

  const setProgress = (percent, text) => {
    progress.hidden = false;
    dial.style.setProperty('--pct', `${percent}%`);
    dial.dataset.pct = `${Math.round(percent)}%`;
    progressText.textContent = text;
  };

  const action = el('button', { class: 'btn btn--primary btn--block' }, 'Calculate accumulation');

  action.addEventListener('click', async () => {
    if (accumulation.isPlotted()) {
      accumulation.unplot();
      action.textContent = 'Calculate accumulation';
      status.textContent = 'Accumulation removed.';
      progress.hidden = true;
      return;
    }

    action.disabled = true;
    action.textContent = 'Calculating…';
    const from = start.input.value ? new Date(start.input.value) : null;
    const to = end.input.value ? new Date(end.input.value) : null;

    const result = await accumulation.calculate(from, to, setProgress);
    action.disabled = false;

    if (!result.ok) {
      status.textContent = result.reason;
      action.textContent = 'Calculate accumulation';
      progress.hidden = true;
      toast(result.reason, { tone: 'error' });
      return;
    }

    action.textContent = 'Remove accumulation';
    status.textContent = `${result.validFrames} of ${result.frames} frames contributed. Click the map for a point total.`;
    setTimeout(() => { progress.hidden = true; }, 1600);
  });

  const legend = el('div', { class: 'legend-scale' },
    accumulation.legendStops().map((stop) =>
      el('span', { class: 'legend-scale__step', style: { background: stop.colour } })));

  return el('div', { class: 'stack' }, [
    sectionTitle('Rainfall accumulation'),
    el('p', { class: 'tiny dim' },
      'Integrates the Global High Resolution radar composite over a window for the current viewport.'),
    start.node,
    end.node,
    action,
    progress,
    status,
    el('div', { class: 'legend-group' }, [
      el('div', { class: 'legend-group__title' }, 'Accumulated rainfall'),
      legend,
      el('div', { class: 'legend-scale__labels' }, [
        el('span', {}, '0.5 mm'), el('span', {}, '20 mm'), el('span', {}, '200 mm'),
      ]),
    ]),
  ]);
}

export function buildToolsPanel() {
  return el('div', { class: 'stack' }, [
    buildDrawingSection(),
    buildImportSection(),
    buildExportSection(),
    buildAccumulationSection(),
    disclosure('Useful links', [
      el('a', {
        class: 'btn btn--block',
        href: 'https://handry-outlook.github.io/Convective-Outlook/lightning_strikes_chart.html',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'Strikes chart ↗'),
      el('a', {
        class: 'btn btn--block',
        href: 'https://handry-outlook.github.io/HOCO-V2.0/index.html',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'ADV-HOCO thunderstorm forecast ↗'),
    ]),
  ]);
}
