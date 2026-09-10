/**
 * Puts the outlooks and hand-drawn shapes into the layer list.
 *
 * These are real overlays with no catalog product behind them, so they had no
 * row in the layer list and no way to change their stacking. Registering them
 * here — rather than inside the outlook and drawing modules — keeps those
 * modules unaware of the layer system, and keeps every descriptor in one place
 * where the preset stacking can be read at a glance.
 *
 * Preset order, bottom to top:
 *
 *     satellite (140) < automated outlook (146) < manual outlook (148) < radar (150)
 *
 * and hand-drawn shapes above the weather stack. Each entry's fill and outline
 * panes move together, one zoom level apart, so an outlook reads as a single
 * layer in the list.
 */

import { registerExternalLayer } from './control.js';
import { map } from '../core/map.js';
import { refreshOverlayMirror } from './mirrorBridge.js';
import * as published from '../hoco/published.js';
import * as auto from '../hoco/auto.js';
import * as draw from '../tools/draw.js';
import * as synoptic from './synoptic.js';

/** Sets a fill pane and its outline pane, keeping the outline just above. */
function stackPanes(fillPane, outlinePane) {
  return (z) => {
    const fill = map.getPane(fillPane);
    const outline = map.getPane(outlinePane);
    if (fill) fill.style.zIndex = String(z);
    if (outline) outline.style.zIndex = String(z + 1);
    refreshOverlayMirror();
  };
}

export function registerOverlayLayers() {
  // Station models sit above everything by default: they are read rather than
  // looked at, and anything drawn over one is a number you cannot take. Like the
  // rest they can be restacked from the layer list.
  registerExternalLayer({
    id: 'observations',
    label: 'Surface observations',
    group: 'Stations',
    accent: 'var(--accent)',
    defaultZ: 196,
    isEnabled: () => synoptic.options.enabled,
    setEnabled: (on) => synoptic.setVisible(on),
    getOpacity: () => synoptic.options.opacity ?? 1,
    setOpacity: (value) => {
      synoptic.options.opacity = value;
      const pane = map.getPane('synopticPane');
      if (pane) pane.style.opacity = String(value);
    },
    applyZ: (z) => {
      const pane = map.getPane('synopticPane');
      if (pane) pane.style.zIndex = String(z);
      refreshOverlayMirror();
    },
  });

  registerExternalLayer({
    id: 'outlookAuto',
    label: 'Automated outlook',
    group: 'Outlooks',
    accent: 'var(--wx-outlook)',
    defaultZ: 146,
    isEnabled: () => auto.autoState().visible,
    setEnabled: (on) => auto.setVisible(on),
    getOpacity: () => auto.autoState().opacity,
    setOpacity: (value) => auto.setOpacity(value),
    applyZ: stackPanes('hocoFillPane', 'hocoOutlinePane'),
  });

  registerExternalLayer({
    id: 'outlookManual',
    label: 'Manual outlook',
    group: 'Outlooks',
    accent: 'var(--wx-outlook)',
    defaultZ: 148,
    isEnabled: () => published.publishedState().visible,
    setEnabled: (on) => published.setVisible(on),
    getOpacity: () => published.publishedState().opacity,
    setOpacity: (value) => published.setOpacity(value),
    applyZ: stackPanes('publishedOutlookFillPane', 'publishedOutlookOutlinePane'),
  });

  registerExternalLayer({
    id: 'drawings',
    label: 'Drawn shapes',
    group: 'Tools',
    accent: 'var(--accent)',
    defaultZ: 192,
    // Only listed once something has been drawn: an always-present empty row
    // would be noise.
    isEnabled: () => draw.hasDrawn() && draw.drawnVisible(),
    setEnabled: (on) => draw.setDrawnVisible(on),
    getOpacity: () => draw.polygonStyle().fillOpacity ?? 0.4,
    setOpacity: (value) => draw.setPolygonOpacity(value),
    applyZ: (z) => {
      const pane = map.getPane('drawPane');
      if (pane) pane.style.zIndex = String(z);
    },
  });
}
