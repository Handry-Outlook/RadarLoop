/**
 * Layer catalog — every remote weather product the application can display.
 *
 * GENERATED from the legacy inline option objects; see scripts_catalog.cjs.
 * Hand edits are fine, but keep the shape: the renderer dispatches on `kind`.
 *
 *   kind          renderer
 *   ------------  ------------------------------------------------------------
 *   raster        XYZ image tiles (png / webp / jpg)
 *   pbf           Mapbox vector tiles via L.vectorGrid.protobuf
 *   image         single georeferenced image overlay
 *   opera         EUMETNET OPERA binary scalar grid, reprojected to a canvas
 *   wms           WMS with a {bbox} template
 *   geojson       GeoJSON fetched per frame
 *   esri-feature  Esri FeatureServer layer
 *   mapsgl        Aeris MapsGL GPU layer
 *   xweather      Xweather point/plot data drawn as markers
 *   windy-lightning  bespoke live strike feed
 *
 * `listed` marks the products offered in the layer picker; the rest are
 * internal (for example radar-nowcast-forecast, used for future timestamps).
 */

import { mergeMapsGLLayers } from './mapsglLayers.js';
import { orderProducts } from './productOrder.js';
import { scrubCatalog } from './sourceNames.js';

export const LAYER_CATALOG = {
  radar: {
    "radar-global": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/radar-global/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Low Resolution Satellite Derived Radar",
      listed: false
    },
    radar: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/radar/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Low Resolution Global Radar",
      listed: false
    },
    "uk-precip-intensity": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-intensity-uk-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "DTN Meteoguard",
      label: "UK High Resolution Rainfall Intensity (Smoothed)",
      listed: true
    },
    "windy-radar": {
      kind: "raster",
      url: "https://rdr.windy.com/radar2/composite/${windyRadarYYYY}/${windyRadarMM}/${windyRadarDD}/${windyRadarHHmm}/{z}/{x}/{y}/reflectivity.webp?multichannel=true&maxt=${windyRadarMaxt}",
      interval: 300000,
      attribution: "Global High Resolution Radar",
      label: "Global High Resolution Rainfall Radar Composite",
      listed: true
    },
    "opera-dbzh": {
      kind: "opera",
      url: "https://datavis.daneradarowe.pl/images/polar/opera/OPERA@${operaTime}@0@DBZH.bin",
      interval: 300000,
      attribution: "Data source: EUMETNET",
      width: 3800,
      height: 4400,
      bytesPerPixel: 1,
      projection: "+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +units=m +ellps=WGS84 +no_defs",
      projectedExtent: [
        0,
        -4400000,
        3800000,
        0
      ],
      label: "Europe OPERA Reflectivity Composite",
      listed: true
    },
    "uk-nw-precip-intensity": {
      kind: "pbf",
      url: "https://max.nwstatic.co.uk/tiles3/${isoNw1}/${isoNw2}/{z}/{x}/{y}.pbf",
      interval: 300000,
      attribution: "DTN Meteoguard",
      label: "uk-nw-precip-intensity",
      listed: false
    },
    "uk-precip-intensity-accu": {
      kind: "raster",
      url: "https://api.accuweather.com/maps/v1/radar/globalSIR/zxy/${iso}/{z}/{x}/{y}.png?apikey=34d63eadb3384b4b86e1f5a5741f9820",
      interval: 300000,
      attribution: "DTN Meteoguard",
      label: "Europe High Resolution Precipitation Type 3",
      listed: false
    },
    "europe-precip-type-foreca": {
      kind: "raster",
      url: "https://map-eu.foreca.com/api/v1/image/tile/{z}/{x}/{y}/${iso}/115?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwOlwvXC9wZmEuZm9yZWNhLmNvbVwvYXV0aG9yaXplXC90b2tlbiIsImlhdCI6MTc2OTQzODc0NSwiZXhwIjoxNzY5NDQ5NTQ1LCJuYmYiOjE3Njk0Mzg3NDUsImp0aSI6IjRlNDZjNWMwNDE3MzBmZTgiLCJzdWIiOiJkZXYtZm9yZWNhLWNvbSIsImZtdCI6IlhEY09oakM0MCtBTGpsWVR0amJPaUE9PSJ9.T8MVMxt3x47jD5kCZP_ipUArfzR454yRxU62OmFrQRc&colorscheme=default&analyses=${iso2}%2C${iso2}",
      interval: 300000,
      attribution: "Foreca",
      label: "europe-precip-type-foreca",
      listed: false
    },
    "europe-precip-type-high-foreca": {
      kind: "raster",
      url: "https://map-tile.foreca.net/fca-tile.png?p=2031&u=${iso2},${iso}&up=${iso2}&cid=h9hag3y&c=d5f0a5a900d54d39c8bcad0f35b48fe2&colorscheme=forecacomradusptdbz&t=${iso2}&z={z}&x={x}&y={y}",
      interval: 300000,
      attribution: "Foreca",
      label: "Europe High Resolution Precipitation Type 2",
      listed: false
    },
    "uk-precip-type": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-type-uk-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "DTN Meteoguard",
      label: "UK High Resolution Precipitation Type",
      listed: true
    },
    "europe-precip-intensity": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-intensity-europe-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Europe High Resolution Rainfall Intensity",
      listed: false
    },
    "radar-nowcast-forecast": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-radar-precip-rate-europe-raster/${iso_now}/${iso_future}/{z}/{x}/{-y}.png",
      interval: 300000,
      attribution: "DTN Meteoguard",
      allowFuture: true,
      isNowcast: true,
      label: "radar-nowcast-forecast",
      listed: false
    },
    "radar-precip-intensity-australia-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-intensity-australia-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Australia High Resolution Rainfall Intensity",
      listed: false
    },
    "radar-precip-intensity-us-canada-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-intensity-us-canada-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "North America High Resolution Rainfall Intensity",
      listed: false
    },
    "radar-precip-type-us-canada-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-type-us-canada-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "North America High Resolution Precipitation Type",
      listed: false
    },
    "europe-precip-type": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-type-europe-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Europe High Resolution Precipitation Type 1",
      listed: true
    },
    "radar-precip-intensity-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-intensity-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 1800000,
      attribution: "DTN Meteoguard",
      label: "radar-precip-intensity-global-raster",
      listed: false
    },
    "uk-precip-intensity-pixelated": {
      kind: "image",
      url: "https://maps.consumer-digital.api.metoffice.gov.uk/wms_ob/single/high-res/rainfall_radar/${iso}.png",
      interval: 300000,
      bounds: [
        [
          44.02,
          -25
        ],
        [
          64,
          16
        ]
      ],
      attribution: "Met Office",
      label: "UK High Resolution Rainfall Intensity (Pixelated)",
      listed: true
    },
    "precip-intensity-global-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-intensity-global-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Precipitation - NASA Global Precipitation Intensity",
      listed: false
    },
    "radar-base-ref-precip-type-na-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-base-ref-precip-type-na-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "North America Base Reflectivity Precip - Contour",
      listed: false
    },
    "radar-base-ref-precip-type-europe-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-base-ref-precip-type-europe-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Europe Base Reflectivity Precip - Contour",
      listed: true
    },
    "radar-base-ref-precip-type-australia-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-base-ref-precip-type-australia-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Australia Base Reflectivity Precip - Contour",
      listed: false
    },
    "radar-base-ref-precip-type-westpacific-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-base-ref-precip-type-westpacific-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "West Pacific Base Reflectivity Precip - Contour",
      listed: false
    },
    "radar-max-ref-precip-type-na-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-max-ref-precip-type-na-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "North America Max Reflectivity Precip",
      listed: false
    },
    "radar-max-ref-precip-type-australia-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-max-ref-precip-type-australia-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Australia Max Reflectivity Precip",
      listed: false
    },
    "radar-precip-rate-europe-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-rate-europe-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Radar Precipitation Rate - Grid (Europe)",
      listed: true
    },
    "radar-precip-rate-europe-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-precip-rate-europe-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Radar Precipitation Rate - Contour (Europe)",
      listed: false
    },
    "radar-reflectivity-mosaic-global-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-reflectivity-mosaic-global-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Synthetic Radar - Contour (Global)",
      listed: false
    },
    "radar-reflectivity-mosaic-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/radar-reflectivity-mosaic-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Synthetic Radar - Grid (Global)",
      listed: false
    },
    "precip-qpe-168hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-168hrs-eu-contours",
      listed: false
    },
    "precip-qpe-168hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-168hrs-eu-raster",
      listed: false
    },
    "precip-qpe-72hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-72hrs-eu-contours",
      listed: false
    },
    "precip-qpe-72hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-72hrs-eu-raster",
      listed: false
    },
    "precip-qpe-48hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-48hrs-eu-contours",
      listed: false
    },
    "precip-qpe-48hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-48hrs-eu-raster",
      listed: false
    },
    "precip-qpe-24hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-24hrs-eu-contours",
      listed: false
    },
    "precip-qpe-24hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-24hrs-eu-raster",
      listed: false
    },
    "precip-qpe-1hr-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-1hr-eu-contours",
      listed: false
    },
    "precip-qpe-1hr-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-1hr-eu-raster",
      listed: false
    },
    "precip-qpe-168hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-168hrs-gm-contours",
      listed: false
    },
    "precip-qpe-168hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-168hrs-gm-raster",
      listed: false
    },
    "precip-qpe-72hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-72hrs-gm-contours",
      listed: false
    },
    "precip-qpe-72hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-72hrs-gm-raster",
      listed: false
    },
    "precip-qpe-48hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-48hrs-gm-contours",
      listed: false
    },
    "precip-qpe-48hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-48hrs-gm-raster",
      listed: false
    },
    "precip-qpe-24hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-24hrs-gm-contours",
      listed: false
    },
    "precip-qpe-24hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-24hrs-gm-raster",
      listed: false
    },
    "precip-qpe-1hr-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-1hr-gm-contours",
      listed: false
    },
    "precip-qpe-1hr-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "precip-qpe-1hr-gm-raster",
      listed: false
    },
    "global-current-speed": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-current-speed-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "global-current-speed",
      listed: false
    },
    "global-wave-height": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-significant-wave-height-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "global-wave-height",
      listed: false
    },
    "global-wave-period": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-peak-wave-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "global-wave-period",
      listed: false
    },
    "fcst-sea-wave-height-swell-waves-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-swell-waves-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "fcst-sea-wave-height-swell-waves-contours",
      listed: false
    },
    "fcst-sea-wave-height-swell-waves-period-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-swell-waves-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "fcst-sea-wave-height-swell-waves-period-contours",
      listed: false
    },
    "fcst-sea-wave-height-wind-waves-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-wind-waves-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "fcst-sea-wave-height-wind-waves-contours",
      listed: false
    },
    "fcst-sea-wave-height-wind-waves-period-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-wind-waves-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "fcst-sea-wave-height-wind-waves-period-contours",
      listed: false
    },
    "global-visibility": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-visibility-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "global-visibility",
      listed: false
    },
    "global-wind-speed": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-wind-speed-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "global-wind-speed",
      listed: false
    },
    __order: [
      {
        header: "High Resolution Global Data ↓"
      },
      "windy-radar",
      "opera-dbzh",
      "uk-precip-intensity",
      "uk-precip-type",
      "uk-precip-intensity-pixelated",
      "europe-precip-type",
      "europe-precip-type-high-foreca",
      "uk-precip-intensity-accu",
      "europe-precip-intensity",
      "radar-precip-intensity-us-canada-contours",
      "radar-precip-type-us-canada-contours",
      "radar-precip-intensity-australia-contours",
      "radar",
      "radar-global",
      {
        header: "Low Resolution Worldwide Data ↓"
      },
      "radar-base-ref-precip-type-na-contours",
      "radar-base-ref-precip-type-europe-contours",
      "radar-base-ref-precip-type-australia-contours",
      "radar-base-ref-precip-type-westpacific-contours",
      "radar-max-ref-precip-type-na-contours",
      "radar-max-ref-precip-type-australia-contours",
      "radar-precip-rate-europe-contours",
      "radar-precip-rate-europe-raster",
      "radar-reflectivity-mosaic-global-contours",
      "radar-reflectivity-mosaic-global-raster",
      {
        header: "Satellite Precipitation Estimation ↓"
      },
      "precip-intensity-global-contours"
    ]
  },
  satellite: {
    satellite: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/satellite/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Global infrared (alternative)",
      listed: false
    },
    "windy-optical-flow": {
      kind: "raster",
      url: "https://sat.windy.com/satellite/composite/${windyIso}/{z}/{x}/{y}/opticalflow.jpg?maxt=${windyMaxt}",
      interval: 600000,
      attribution: "Global High Resolution Satellite / EUMETSAT / NOAA / JMA",
      label: "Cloud Motion Vectors",
      listed: false
    },
    "windy-visir": {
      kind: "raster",
      url: "https://sat.windy.com/satellite/composite/${windyIso}/{z}/{x}/{y}/visir.png?mosaic=true&maxt=${windyMaxt}",
      interval: 600000,
      attribution: "Global High Resolution Satellite / EUMETSAT / NOAA / JMA",
      label: "Global High Resolution Satellite",
      listed: true
    },
    "windy-infrared": {
      kind: "raster",
      url: "https://sat.windy.com/satellite/composite/${windyIso}/{z}/{x}/{y}/visir.png?mosaic=true&maxt=${windyMaxt}",
      interval: 600000,
      attribution: "Global High Resolution Satellite / EUMETSAT / NOAA / JMA",
      label: "Global High Resolution Infrared",
      listed: true
    },
    "windy-visible": {
      kind: "raster",
      url: "https://sat.windy.com/satellite/composite/${windyIso}/{z}/{x}/{y}/visir.png?mosaic=true&maxt=${windyMaxt}",
      interval: 600000,
      attribution: "Global High Resolution Satellite / EUMETSAT / NOAA / JMA",
      label: "Global High Resolution Visible (daylight)",
      listed: true
    },
    "eumetsat-geocolor": {
      kind: "wms",
      url: "https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image%2Fpng&TRANSPARENT=true&LAYERS=mtg_fd%3Argb_geocolour&STYLES=&tiled=true&TIME=${isoMs}&WIDTH=256&HEIGHT=256&CRS=EPSG%3A4326&BBOX={bbox}",
      interval: 900000,
      attribution: "© EUMETSAT",
      label: "EUMETSAT MTG GeoColour (Full Disc)",
      listed: false
    },
    "satellite-water-vapor": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/satellite-water-vapor/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Global Water Vapor (alternative)",
      listed: true
    },
    "satellite-infrared-color": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/satellite-infrared-color/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Global Infrared with Cloud Top Temperature",
      listed: false
    },
    "satellite-visible": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/satellite-visible/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "North America Visible Satellite",
      listed: false
    },
    "satellite-geocolor": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/satellite-geocolor/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Geocolor Global Satellite",
      listed: true
    },
    "global-ir": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.mg.global-composite_data_ir.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "Global infrared (GOES)",
      listed: false
    },
    "europe-vis": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.ems.meteosat-0e_europe_proj_hrv.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Europe visible (MeteoSat)",
      listed: false
    },
    "europe-ir": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.ems.meteosat-0e_europe_proj_ir108.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Europe infrared (MeteoSat)",
      listed: false
    },
    "europe-water": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.ems.meteosat-0e_europe_proj_wv062.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 900000,
      attribution: "DTN Meteoguard",
      label: "Europe water vapor (MeteoSat)",
      listed: false
    },
    "us-visible": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.noaa.goes-east-75w.sh.s3.mg_north_america_vis.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "NOAA/GOES",
      label: "North America visible (GOES)",
      listed: false
    },
    "us-ir": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/RASTER.obs-sat.noaa.goes-east-75w.sh.s3.mg_north_america_ir.default/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "NOAA/GOES",
      label: "North America infrared (GOES)",
      listed: false
    },
    "satellite-infrared-enhanced-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/satellite-infrared-enhanced-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "Global Enhanced Infrared",
      listed: true
    },
    "satellite-visible-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/satellite-visible-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "Global Visible",
      listed: false
    },
    "satellite-water-vapor-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/satellite-water-vapor-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "Global Water Vapor",
      listed: true
    },
    "satellite-night-fog-global-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/satellite-night-fog-global-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "DTN Meteoguard",
      label: "Global Night Fog",
      listed: true
    },
    __order: [
      "windy-visir",
      "eumetsat-geocolor",
      "windy-infrared",
      "windy-visible",
      "europe-vis",
      "global-ir",
      "satellite-geocolor",
      "satellite-infrared-enhanced-global-raster",
      "satellite",
      "satellite-infrared-color",
      "satellite-visible-global-raster",
      "satellite-night-fog-global-raster",
      "europe-ir",
      "satellite-water-vapor-global-raster",
      "satellite-water-vapor",
      "europe-water",
      "us-visible",
      "satellite-visible",
      "us-ir"
    ]
  },
  isobar: {
    pressure_two: {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-mean-sea-level-pressure-isolines/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Mean Sea Level Pressure (every 2 hPa)",
      listed: true
    },
    pressure_four: {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-mean-sea-level-pressure-4mb-isolines/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Mean Sea Level Pressure (every 4 hPa)",
      listed: true
    },
    "fcst-geopotential-height-500hpa-isolines": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-geopotential-height-500hpa-isolines-dk-lg/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "fcst-geopotential-height-500hpa-isolines",
      listed: false
    },
    "fpressure-msl-isobars": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/fpressure-msl-isobars/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 1800000,
      attribution: "X weather",
      label: "Mean Sea Level Pressure (every 4 hPa)",
      listed: false
    },
    __order: [
      "pressure_two",
      "pressure_four",
      "fpressure-msl-isobars"
    ]
  },
  wind: {
    "wind-speeds-text": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-speeds-text/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 1800000,
      attribution: "X weather",
      label: "wind-speeds-text",
      listed: false
    },
    "wind-gusts-text": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-gusts-text/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 1800000,
      attribution: "X weather",
      label: "wind-gusts-text",
      listed: false
    },
    "wind-chill-text": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-chill-text-metric/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 1800000,
      attribution: "X weather",
      label: "wind-chill-text",
      listed: false
    },
    "temperatures-text": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/temperatures-text-metric/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "temperatures-text",
      listed: false
    },
    "wind-dir": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-dir-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 1800000,
      attribution: "X weather",
      label: "Observed Wind direction",
      listed: true
    },
    "wind-direction": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-wind-symbol-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Wind direction",
      listed: true
    },
    "fcst-manta-current-direction-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-current-direction-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Current Direction",
      listed: false
    },
    "fcst-manta-mean-wave-direction-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-mean-wave-direction-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Mean Wave Direction",
      listed: false
    },
    "fcst-manta-significant-wave-symbol-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-significant-wave-symbol-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Significant Wave Height Direction",
      listed: false
    },
    "fcst-manta-current-speed-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-current-speed-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "fcst-manta-current-speed-grid",
      listed: false
    },
    "fcst-manta-swell-wave-symbol-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-swell-wave-symbol-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Swell Wave Direction",
      listed: false
    },
    "fcst-sea-wave-height-swell-waves-period-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-swell-waves-period-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Swell Waves Period Direction",
      listed: false
    },
    "fcst-manta-wind-wave-symbol-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-wind-wave-symbol-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Wind Wave Directions",
      listed: false
    },
    "fcst-sea-wave-height-wind-waves-period-grid": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-wind-waves-period-grid/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Wind Waves Period Direction",
      listed: false
    },
    __order: [
      "wind-dir",
      "wind-direction",
      "fcst-manta-current-direction-grid",
      "fcst-manta-mean-wave-direction-grid",
      "fcst-manta-significant-wave-symbol-grid",
      "fcst-manta-swell-wave-symbol-grid",
      "fcst-sea-wave-height-swell-waves-period-grid",
      "fcst-manta-wind-wave-symbol-grid",
      "fcst-sea-wave-height-wind-waves-period-grid"
    ]
  },
  lightning: {
    "windy-live-lightning": {
      kind: "windy-lightning",
      // The archive frames go back exactly this far: served at 24 hours old,
      // empty by 26.
      label: "Live + past 24 hours Global Lightning",
      listed: true
    },
    "xweather-lightning": {
      kind: "geojson",
      url: "https://data.api.xweather.com/lightning",
      label: "Global Live Strikes",
      listed: false
    },
    "sevwx-lightning-global-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-lightning-global-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 60000,
      attribution: "dtn",
      label: "Global Lightning",
      listed: true
    },
    "lightning-flash": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/lightning-all-5m/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Global Lightning (last 5 minutes)",
      listed: false
    },
    "lightning-all": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/lightning-all-15m/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "Global Lightning (last 15 minutes)",
      listed: false
    },
    "lightning-all-tile": {
      kind: "mapsgl",
      id: "lightning-all",
      label: "Current Lightning",
      listed: true
    },
    "lightning-density": {
      kind: "mapsgl",
      id: "lightning-density",
      label: "Lightning Density",
      listed: true
    },
    "lightning-density-accum": {
      kind: "mapsgl",
      id: "lightning-density-accum",
      label: "Lightning Density Accumulation",
      listed: true
    },
    __order: [
      "windy-live-lightning",
      "lightning-all-tile",
      "xweather-lightning",
      "sevwx-lightning-global-plot",
      "lightning-flash",
      "lightning-all",
      "lightning-density",
      "lightning-density-accum"
    ]
  },
  tropicalStorms: {
    "tropical-cyclones": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/tropical-cyclones/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Tropical Cyclones",
      listed: false
    },
    "sevwx-dtn-tropical-cyclones-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-dtn-tropical-cyclones-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Tropical Storms",
      listed: true
    },
    "sevwx-agency-tropical-cyclones-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-agency-tropical-cyclones-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Agency Tropical Storms",
      listed: true
    },
    "sevwx-tropical-cyclone-tracks": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-tropical-cyclone-tracks/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Tropical Storm Model Tracks",
      listed: true
    },
    __order: [
      "sevwx-dtn-tropical-cyclones-plot",
      "sevwx-agency-tropical-cyclones-plot",
      "sevwx-tropical-cyclone-tracks",
      "tropical-cyclones"
    ]
  },
  rotation: {
    "sevwx-rotation-track-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-rotation-track-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Rotation Tracks",
      listed: true
    },
    "avwx-echo-tops-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/avwx-echo-tops-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Echo Tops",
      listed: true
    },
    "avwx-echo-tops-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/avwx-echo-tops-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Echo Top Contours",
      listed: true
    },
    __order: [
      "sevwx-rotation-track-contours",
      "avwx-echo-tops-plot",
      "avwx-echo-tops-contours"
    ]
  },
  surfaceFront: {
    "fcst-surface-fronts-isolines": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-surface-fronts-isolines/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Surface Fronts",
      listed: true
    },
    "fsurface-analysis": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/fsurface-analysis/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 300000,
      attribution: "X weather",
      label: "fsurface-analysis",
      listed: false
    },
    __order: [
      "fcst-surface-fronts-isolines"
    ]
  },
  observation: {
    "wind-chill": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-chill,wind-chill-text-metric-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Wind Chill",
      listed: true
    },
    visibility: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/visibility/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Visibility (US)",
      listed: true
    },
    sst: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/sst/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Sea Surface Temperature",
      listed: true
    },
    "snow-depth": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/snow-depth-global/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Snow Depth",
      listed: true
    },
    "dew-points": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/dew-points,dew-points-text-metric-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Dew Points",
      listed: true
    },
    "feels-like": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/feels-like,feels-like-text-metric-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Feels-like Tempearture",
      listed: true
    },
    humidity: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/humidity,humidity-text-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Relative Humidity",
      listed: true
    },
    "wind-speeds": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-speeds,wind-speeds-text-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Wind Speeds",
      listed: true
    },
    "wind-gusts": {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/wind-gusts,wind-gusts-text-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 3600000,
      attribution: "X weather",
      label: "Observed Wind Gusts",
      listed: true
    },
    temperatures: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/temperatures,temperatures-text-metric-dk/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 60000,
      attribution: "X weather",
      label: "Observed Surface Temperature",
      listed: true
    },
    "precip-qpe-168hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 7 days Contour (Europe)",
      listed: true
    },
    "precip-qpe-168hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 7 days Grid (Europe)",
      listed: true
    },
    "precip-qpe-72hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 3 days Contour (Europe)",
      listed: true
    },
    "precip-qpe-72hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 3 days Grid (Europe)",
      listed: true
    },
    "precip-qpe-48hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 2 days Contour (Europe)",
      listed: true
    },
    "precip-qpe-48hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 2 days Grid (Europe)",
      listed: true
    },
    "precip-qpe-24hrs-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 24h Contour (Europe)",
      listed: true
    },
    "precip-qpe-24hrs-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 24h Grid (Europe)",
      listed: true
    },
    "precip-qpe-1hr-eu-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-eu-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 1h Contour (Europe)",
      listed: true
    },
    "precip-qpe-1hr-eu-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-eu-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 1h Grid (Europe)",
      listed: true
    },
    "precip-qpe-168hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 7 days Contour (Global)",
      listed: true
    },
    "precip-qpe-168hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-168hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 7 days Grid (Global)",
      listed: true
    },
    "precip-qpe-72hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 3 days Contour (Global)",
      listed: true
    },
    "precip-qpe-72hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-72hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 3 days Grid (Global)",
      listed: true
    },
    "precip-qpe-48hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 2 days Contour (Global)",
      listed: true
    },
    "precip-qpe-48hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-48hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 2 days Grid (Global)",
      listed: true
    },
    "precip-qpe-24hrs-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 24h Contour (Global)",
      listed: true
    },
    "precip-qpe-24hrs-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-24hrs-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 24h Grid (Global)",
      listed: true
    },
    "precip-qpe-1hr-gm-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-gm-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 1h Contour (Global)",
      listed: true
    },
    "precip-qpe-1hr-gm-raster": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/precip-qpe-1hr-gm-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Observed Precipitation – Past 1h Grid (Global)",
      listed: true
    },
    "global-current-speed": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-current-speed-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Current Speed",
      listed: true
    },
    "global-wave-height": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-significant-wave-height-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Peak Wave Period",
      listed: true
    },
    "global-wave-period": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-peak-wave-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Peak Wave Period",
      listed: true
    },
    "fcst-sea-wave-height-swell-waves-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-swell-waves-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Swell Waves",
      listed: true
    },
    "fcst-sea-wave-height-swell-waves-period-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-swell-waves-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Swell Waves Period",
      listed: true
    },
    "fcst-sea-wave-height-wind-waves-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-wind-waves-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Wind Waves",
      listed: true
    },
    "fcst-sea-wave-height-wind-waves-period-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-sea-wave-height-wind-waves-period-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Wind Waves Period",
      listed: true
    },
    "global-visibility": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-visibility-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Visibility",
      listed: true
    },
    "global-wind-speed": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-manta-wind-speed-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Wind Speed (Alternative)",
      listed: true
    },
    "sfcanlys-temperature-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-temperature-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Surface Temperature",
      listed: true
    },
    "sfcanlys-wind-speed-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-wind-speed-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Wind Speed",
      listed: true
    },
    "radar-nowcast-europe": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-radar-precip-rate-europe-raster/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "radar-nowcast-europe",
      listed: false
    },
    "sfcanlys-dew-point-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-dew-point-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Dew Point Temperature",
      listed: true
    },
    "sfcanlys-wet-bulb-temperature-globe-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-wet-bulb-temperature-globe-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Wet Bulb Globe Temperature",
      listed: true
    },
    "sfcanlys-relative-humidity-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-relative-humidity-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Relative Humidity",
      listed: true
    },
    "sfcanlys-snow-depth-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-snow-depth-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Snow Depth",
      listed: true
    },
    "sfcanlys-sea-surface-temp-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-sea-surface-temp-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted Sea Surface Temperature",
      listed: true
    },
    "sfcanlys-uv-radiation-index-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sfcanlys-uv-radiation-index-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 3600000,
      attribution: "dtn",
      label: "Forecasted UV Radiation Index",
      listed: true
    },
    "fcst-onefx-freezing-rain-last-24hrs-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-onefx-freezing-rain-last-24hrs-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Freezing Rain Last 24 Hours",
      listed: true
    },
    "fcst-onefx-snowfall-last-24hrs-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-onefx-snowfall-last-24hrs-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Snowfall Last 24 Hours",
      listed: true
    },
    "fcst-onefx-ice-accretion-last-hour-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-onefx-ice-accretion-last-hour-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Ice Accretion Last 1 Hour",
      listed: true
    },
    "fcst-onefx-wet-snow-last-1hr-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/fcst-onefx-wet-snow-last-1hr-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Wet Snow Index",
      listed: true
    },
    "avwx-echo-tops-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/avwx-echo-tops-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "avwx-echo-tops-plot",
      listed: false
    },
    "avwx-echo-tops-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/avwx-echo-tops-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "avwx-echo-tops-contours",
      listed: false
    },
    __order: [
      "temperatures",
      "sfcanlys-temperature-contours",
      "feels-like",
      "dew-points",
      "sst",
      "wind-chill",
      "wind-speeds",
      "sfcanlys-wind-speed-contours",
      "global-wind-speed",
      "wind-gusts",
      "sfcanlys-dew-point-contours",
      "sfcanlys-wet-bulb-temperature-globe-contours",
      "humidity",
      "sfcanlys-relative-humidity-contours",
      "visibility",
      "global-visibility",
      "snow-depth",
      "sfcanlys-snow-depth-contours",
      "sfcanlys-sea-surface-temp-contours",
      "sfcanlys-uv-radiation-index-contours",
      "fcst-onefx-freezing-rain-last-24hrs-contours",
      "fcst-onefx-snowfall-last-24hrs-contours",
      "fcst-onefx-ice-accretion-last-hour-contours",
      "fcst-onefx-wet-snow-last-1hr-contours",
      {
        header: "Europe Accumulated Precipitation ↓"
      },
      "precip-qpe-168hrs-eu-contours",
      "precip-qpe-168hrs-eu-raster",
      "precip-qpe-72hrs-eu-contours",
      "precip-qpe-72hrs-eu-raster",
      "precip-qpe-48hrs-eu-contours",
      "precip-qpe-48hrs-eu-raster",
      "precip-qpe-24hrs-eu-contours",
      "precip-qpe-24hrs-eu-raster",
      "precip-qpe-1hr-eu-contours",
      "precip-qpe-1hr-eu-raster",
      {
        header: "Global Accumulated Precipitation ↓"
      },
      "precip-qpe-168hrs-gm-contours",
      "precip-qpe-168hrs-gm-raster",
      "precip-qpe-72hrs-gm-contours",
      "precip-qpe-72hrs-gm-raster",
      "precip-qpe-48hrs-gm-contours",
      "precip-qpe-48hrs-gm-raster",
      "precip-qpe-24hrs-gm-contours",
      "precip-qpe-24hrs-gm-raster",
      "precip-qpe-1hr-gm-contours",
      "precip-qpe-1hr-gm-raster",
      {
        header: "Marine Data ↓"
      },
      "global-current-speed",
      "global-wave-height",
      "global-wave-period",
      "fcst-sea-wave-height-swell-waves-contours",
      "fcst-sea-wave-height-swell-waves-period-contours",
      "fcst-sea-wave-height-wind-waves-contours",
      "fcst-sea-wave-height-wind-waves-period-contours"
    ]
  },
  nowcast: {
    "hail-severe-probability": {
      kind: "mapsgl",
      id: "hail-severe-probability",
      label: "Hail Severe Probability",
      listed: true
    },
    "hail-severe-probability-max": {
      kind: "mapsgl",
      id: "hail-severe-probability-max",
      label: "Hail Severe Prob. (Max)",
      listed: true
    },
    "hail-size": {
      kind: "mapsgl",
      id: "hail-size",
      label: "Hail Size",
      listed: true
    },
    "hail-size-max": {
      kind: "mapsgl",
      id: "hail-size-max",
      label: "Hail Size (Max)",
      listed: true
    },
    "hail-threats": {
      kind: "mapsgl",
      id: "hail-threats",
      label: "Hail Threats (Tile)",
      listed: true
    },
    "lightning-threats": {
      kind: "mapsgl",
      id: "lightning-threats",
      label: "Lightning Threats (Tile)",
      listed: true
    },
    stormHailThreat: {
      kind: "geojson",
      url: "https://data.api.xweather.com/hail/threats/within?p=-90,-180,90,180&client_id=wgE96YE3scTQLKjnqiMsv&client_secret=1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq",
      attribution: "X Weather",
      label: "Live Storm & Hail Threat",
      listed: true
    },
    "xweather-storm-threats": {
      kind: "geojson",
      url: "https://data.api.xweather.com/lightning/threats",
      label: "Live Storm Threats",
      listed: true
    },
    "xweather-hail-threats": {
      kind: "geojson",
      url: "https://data.api.xweather.com/hail/threats",
      label: "Live Hail Threats",
      listed: true
    },
    "xweather-lightning": {
      kind: "geojson",
      url: "https://data.api.xweather.com/lightning",
      label: "Xweather Live Strikes",
      listed: false
    },
    "xweather-alerts": {
      kind: "geojson",
      url: "https://data.api.xweather.com/alerts",
      label: "Xweather Official Alerts",
      listed: false
    },
    stormcells: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/stormcells/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 180000,
      attribution: "X weather",
      label: "StormCells Nowcast (US)",
      listed: true
    },
    "sevwx-storm-corridors-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-storm-corridors-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Storm Corridors",
      listed: true
    },
    "sevwx-global-storm-corridors-plot": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-global-storm-corridors-plot/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "Storm Nowcasts",
      listed: true
    },
    "sevwx-hail-swath-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-hail-swath-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 300000,
      attribution: "dtn",
      label: "sevwx-hail-swath-contours",
      listed: false
    },
    __order: [
      "stormHailThreat",
      "sevwx-global-storm-corridors-plot",
      "sevwx-storm-corridors-plot",
      "stormcells",
      "xweather-storm-threats",
      "xweather-hail-threats",
      {
        header: "--- MapsGL Severe Layers ---"
      },
      "hail-severe-probability",
      "hail-severe-probability-max",
      "hail-size",
      "hail-size-max",
      "hail-threats",
      "lightning-threats"
    ]
  },
  warning: {
    "xweather-alerts": {
      kind: "geojson",
      url: "https://data.api.xweather.com/alerts/search?client_id=${client_id}&client_secret=${client_secret}&limit=50",
      interval: 300000,
      attribution: "Xweather Alerts",
      coverage: [
        "India",
        "Brazil",
        "South Africa",
        "South Korea",
        "Mexico",
        "US",
        "Canada",
        "Europe",
        "Australia"
      ],
      label: "Global Weather Alerts (Xweather)",
      listed: true
    },
    alerts: {
      kind: "raster",
      url: "https://maps.aerisapi.com/wgE96YE3scTQLKjnqiMsv_1XwHqbCjiTqtzWi8txyN4JtM0ezVNuEfaDXQdkjq/alerts/{z}/{x}/{y}/${iso2}_${iso2}.webp",
      interval: 60000,
      attribution: "X weather",
      label: "Active Alerts (local)",
      listed: true
    },
    "sevwx-agency-bulletin-zones": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-agency-bulletin-zones/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 120000,
      attribution: "dtn",
      label: "Global Weather Bulletins",
      listed: true
    },
    "sevwx-nws-alert-zones": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-nws-alert-zones/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 600000,
      attribution: "dtn",
      label: "NWS Bulletins",
      listed: true
    },
    "nws-severe-tstorm-alerts": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/sevwx-nws-alert-zones/${iso}/${iso}/{z}/{x}/{y}.png?filter=nws-severe-tstorm-alerts",
      interval: 120000,
      attribution: "dtn",
      label: "NWS Bulletins - Severe Thunderstorm Alerts",
      listed: true
    },
    "ukmo-detail-warning": {
      kind: "esri-feature",
      url: "https://services.arcgis.com/Lq3V5RFuTBC9I7kv/arcgis/rest/services/Met_Office_National_Severe_Weather_Warning_Service_Live/FeatureServer/0",
      interval: 300000,
      attribution: "© Met Office",
      label: "UK Met Office Warning",
      listed: true
    },
    "avwx-sigmet-contours": {
      kind: "raster",
      url: "https://tiles.meteoguard.dtn.com/tiles/avwx-sigmet-contours/${iso}/${iso}/{z}/{x}/{y}.png",
      interval: 120000,
      attribution: "dtn",
      label: "Sigmet",
      listed: true
    },
    __order: [
      "ukmo-detail-warning",
      "xweather-alerts",
      "alerts",
      "sevwx-agency-bulletin-zones",
      "sevwx-nws-alert-zones",
      "nws-severe-tstorm-alerts",
      "avwx-sigmet-contours"
    ]
  }
};

/**
 * Provider names are removed from every label, and attribution strings dropped,
 * before anything can read them. Done here rather than at each render point so
 * that regenerating this file cannot reintroduce one.
 */
// The original file used nine MapsGL products; the rest of the SDK catalogue is
// declared by hand in mapsglLayers.js and merged here, before the order table is
// derived, so regenerating this file cannot drop them.
mergeMapsGLLayers(LAYER_CATALOG);

scrubCatalog(LAYER_CATALOG);

// Membership and order are both derived from the entries above rather than kept
// in step by hand: `listed: false` retires a product from every drop-list, and
// what remains is ordered by provider within each header's section. See
// productOrder.js for why that is derived rather than written out.
orderProducts(LAYER_CATALOG);

export const LAYER_ORDER = Object.fromEntries(
  Object.entries(LAYER_CATALOG).map(([group, defs]) => [group, defs.__order || []]),
);

/** Look up one product definition. */
export function getLayerDef(group, type) {
  const defs = LAYER_CATALOG[group];
  return defs && type ? defs[type] || null : null;
}

/** Every selectable product in a group, in picker order, headers included. */
export function listLayers(group) {
  const defs = LAYER_CATALOG[group] || {};
  return (LAYER_ORDER[group] || [])
    .map((entry) => (typeof entry === 'string'
      ? (defs[entry] ? { value: entry, ...defs[entry] } : null)
      : entry))
    .filter(Boolean);
}
