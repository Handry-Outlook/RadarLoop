/**
 * Base map catalog.
 *
 * Declared as data rather than as pre-instantiated Leaflet layers: the legacy file
 * built all eighteen `L.tileLayer` objects at start-up (including four MapTiler GL
 * layers, each of which allocates a WebGL context) even though only one is ever
 * shown. They are now created lazily on first selection.
 */

import { CREDENTIALS } from '../config.js';

const mapboxStyle = (style) => ({
  kind: 'xyz',
  url: `https://api.mapbox.com/styles/v1/mapbox/${style}/tiles/256/{z}/{x}/{y}@2x?access_token=${CREDENTIALS.mapbox}`,
  options: { tileSize: 256, attribution: '© Mapbox © OpenStreetMap' },
  // 3D renders the same style natively rather than as raster tiles, so the base
  // map choice carries across instead of being ignored there.
  glStyle: `mapbox://styles/mapbox/${style}`,
});

export const BASEMAPS = {
  'mapbox-traffic-night': { label: 'Traffic Night', group: 'Mapbox', dark: true, ...mapboxStyle('traffic-night-v2') },
  'mapbox-traffic-day': { label: 'Traffic Day', group: 'Mapbox', ...mapboxStyle('traffic-day-v2') },
  'mapbox-dark': { label: 'Dark', group: 'Mapbox', dark: true, ...mapboxStyle('dark-v11') },
  'mapbox-light': { label: 'Light', group: 'Mapbox', ...mapboxStyle('light-v11') },
  'mapbox-navigation': { label: 'Navigation Day', group: 'Mapbox', ...mapboxStyle('navigation-day-v1') },
  'mapbox-navigation-night': { label: 'Navigation Night', group: 'Mapbox', dark: true, ...mapboxStyle('navigation-night-v1') },
  custom: { label: 'Classic Streets', group: 'Mapbox', ...mapboxStyle('streets-v12') },
  'mapbox-satellite': { label: 'Satellite', group: 'Mapbox', dark: true, ...mapboxStyle('satellite-v9') },
  'mapbox-streets-satellite': { label: 'Satellite Streets', group: 'Mapbox', dark: true, ...mapboxStyle('satellite-streets-v12') },
  'mapbox-outdoors': { label: 'Outdoors', group: 'Mapbox', ...mapboxStyle('outdoors-v12') },
  'mapbox-contrast': { label: 'High Contrast', group: 'Mapbox', ...mapboxStyle('high-contrast-v1') },

  opentopo: {
    label: 'OpenTopoMap',
    group: 'Open data',
    kind: 'xyz',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { attribution: 'Map data: © OpenTopoMap (CC-BY-SA)' },
  },
  osm: {
    label: 'OpenStreetMap',
    group: 'Open data',
    kind: 'xyz',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { attribution: '© OpenStreetMap' },
  },
  esri: {
    label: 'Esri World Imagery',
    group: 'Open data',
    dark: true,
    kind: 'xyz',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { attribution: 'Tiles © Esri' },
  },

  'maptiler-streets': { label: 'Streets', group: 'MapTiler', kind: 'maptiler', style: 'STREETS' },
  'maptiler-outdoor': { label: 'Outdoor', group: 'MapTiler', kind: 'maptiler', style: 'OUTDOOR' },
  'maptiler-light': { label: 'Dataviz Light', group: 'MapTiler', kind: 'maptiler', style: 'DATAVIZ.LIGHT' },
  'maptiler-dark': { label: 'Dataviz Dark', group: 'MapTiler', kind: 'maptiler', dark: true, style: 'DATAVIZ.DARK' },
};

/** Transparent boundary + place-label overlay drawn above the weather stack. */
export const REFERENCE_OVERLAY = {
  url: `https://api.mapbox.com/styles/v1/handry20191026/cmkxzwlsx000t01sfe7m81tqm/draft/tiles/{z}/{x}/{y}?access_token=${CREDENTIALS.mapbox}`,
  options: {
    attribution: '© Mapbox',
    pane: 'labelsPane',
    opacity: 1,
    tileSize: 512,
    zoomOffset: -1,
  },
};

/** Basemaps grouped for the picker, preserving declaration order. */
export function groupedBasemaps() {
  const groups = new Map();
  for (const [id, def] of Object.entries(BASEMAPS)) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push({ id, ...def });
  }
  return groups;
}
