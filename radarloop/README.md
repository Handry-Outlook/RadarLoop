# RadarLoop

Multi-source weather radar, satellite and lightning viewer. A rewrite of the
single-file original (18,598 lines) into modular ES modules, with a single-file
build for drop-in deployment.

## Running it

```bash
# Modular (needs an http origin — ES modules will not load from file://)
npx serve .          # or any static server, then open the printed URL

# Single-file build — opens by double-clicking, deploys as one file
node scripts/build.js
# -> dist/radarloop.html
```

There is no dependency install and no build toolchain. `scripts/build.js` is a
~200-line zero-dependency bundler written for this project.

It inlines the stylesheets, and every `*.worker.js` under `src/` as a Blob URL
keyed by basename (`core/worker.js` picks the Blob in the bundled build and a
module URL in the dev build). Workers are found by scanning rather than by
following imports, because a worker is referenced through
`new Worker(new URL(...))`, which the module graph never sees.

## Layout

```
index.html                 dev entry (loads src/main.js as a module)
scripts/build.js           bundles src/ -> dist/radarloop.html
src/
  config.js                credentials, tuning constants, pane stack, device profile
  main.js                  boot sequence and cross-cutting wiring
  core/
    bus.js                 event bus; subsystems announce, they do not call each other
    state.js               single state store — layer slots, time, lightning, runtime
    map.js                 Leaflet lifecycle, panes, base maps, MapsGL engine
    map3d.js               Mapbox GL 3D view: terrain, buildings, lifecycle
    mirror3d.js            per-kind GL representations for every layer type
    util.js                timing, geometry, colour, DOM, storage, formatting
    deps.js                third-party libraries, fetched at the point of use
    worker.js              starts a worker from either build (module URL or Blob)
  data/
    layers.js              GENERATED — 186 weather product definitions
    sourceNames.js         keeps weather-provider names out of the interface
    mapsglLayers.js        the MapsGL catalogue, merged into the generated one
    palettes.js            GENERATED — 12 rainfall colour presets
    basemaps.js            base map catalog (built lazily)
  layers/
    renderer.js            double-buffered renderer for all 11 layer groups
    resolver.js            frame resolution, caching and learned publish lag
    urlTemplate.js         one time-token table for every provider URL format
    radarScale.js          shared mm/h colour scale + encoded-value LUT
    opera.js               OPERA binary grid, reprojected to canvas
    windy.js               Windy composite: recolouring + live/archive endpoints
    synoptic.js            surface observations, drawn as station models
    windyPool.js           worker pool: colour table, dispatch, fallback
    windyTile.worker.js    fetch, decode, crop and recolour, off the main thread
    control.js             single entry point: enable, select, opacity, order
    registerOverlays.js    outlooks and drawings, registered as orderable layers
    mapsgl.js              Aeris MapsGL GPU layers (readiness-gated)
    mirrorBridge.js        hands rendered 2D layers to the 3D view
    xweather.js            Xweather point/polygon feeds
    geojson.js             generic GeoJSON products
    wms.js                 WMS-as-XYZ with per-tile bbox and publication retries
  lightning/
    source.js              Met Office live + chunked + archive ingestion
    render.js              single-canvas strike renderer
    overlays.js            heatmap, cell counter, thunder cue
    audio.js               strike cue: gesture unlock, element pool, rate limit
    nowcast.js             clustering, RANSAC motion fit, confidence
    nowcastLayer.js        cone and footprint drawing
    index.js               coordinator: time/data change -> redraw
  hoco/
    firebase.js            lazy init for both Firebase apps
    published.js           manual outlooks
    auto.js                automated runs
    risk.js                the two risk ladders (percentage vs category)
    focus.js               pointing the timeline at an outlook window
  time/controller.js       one authoritative timestamp; scrubbing and playback
  tools/
    draw.js                polygon drawing, KML import/export
    overlayFiles.js        image overlays, strike PNG export, area picker
    accumulation.js        rainfall accumulation (geometry + presentation)
    accumulation.worker.js the off-thread integration
    draw3d.js              collects polygon vertices from the GL canvas
  ui/
    icons.js               the drawn icon set, replacing the old text glyphs
    stationPopup.js        the station card: readings, three charts, a table view
    layout.js              measures the docked chrome so the phone sheet clears it
    panels.js              rail + slide-over panel, built from a group declaration
    components.js          shared control builders
    outlookPanel.js        outlook calendars and pickers
    toolsPanel.js          tools
    timeline.js            scrubber, transport, status
    legend.js              legend, rebuilt from state
    search.js              catalog search across the whole catalog
    layerManager.js        active layers, drag/keyboard restacking
    help.js                guide modal
  styles/
    tokens.css             every colour, space, radius and shadow
    base.css               reset and form primitives
    app.css                shell, panels, timeline, Leaflet overrides
```

## What changed and why

### Structure

The original was one file: ~3,200 lines of CSS, ~1,150 of HTML and ~14,000 of JS
across 541 top-level definitions. 33 of those names were declared more than once
at top level, so which implementation ran depended on source order:

| Redefined at top level | Lines in the original |
| --- | --- |
| `updateLegend` | 7387, 14793 |
| `toggleLayer` | 7450, 17843 |
| `updateHistorySliderMax` | 9008, 14188 |
| `warningLayerTypeHandler` | 12111, 18056 |
| `toggleLegend` | 12433, 15427 |
| `toggleWeatherDetails` | 9156, 9171, 9206 |
| `ransacRegression`, `randomSample`, `fitLinearModel`, `calculateDistance` | duplicated nowcast blocks |

Five trailing `<script>` blocks monkey-patched earlier code; one of them replaced
the main render path wholesale via `window.fastRadarSatelliteSliderUpdate`.

Each of the eleven layer groups had its own copy-pasted family of globals
(`lastRadarType`, `isRadarAnimating`, `lastRequestedRadarTimestamp`, …), read
through two eleven-branch `switch (layerKey)` statements. Those are now one
record per group in a `Map`, so the renderer is written once.

### Plotting speed

Four changes, in order of impact:

1. **Double buffering for every layer.** The trailing patch script had the right
   idea but applied it only to radar and satellite. Each group now owns a front
   (visible) and back (loading) layer and promotes only once tiles have loaded —
   no flash to base map, and a superseded frame is discarded rather than drawn.

2. **Learned publish lag** (`layers/resolver.js`). The original probed candidate
   timestamps *sequentially* over the network before issuing any tile request, so
   every scrubber move paid several serial round trips. The resolver now
   remembers the offset that last worked per product and starts there, and treats
   frames comfortably in the past as present — scrubbing through history issues
   zero probes.

3. **Strikes on one canvas** (`lightning/render.js`). Was up to 9,000 individual
   `L.crossMarker` layers, each with a popup binding and a redraw entry; every
   colour change walked all of them calling `setStyle`. Now one canvas, strokes
   batched by colour.

4. **Binary-search filtering** (`lightning/source.js`). The strike array is kept
   sorted, so selecting a time window is O(log n + k) instead of a full scan on
   every scrubber movement.

Also: the heatmap is no longer rebuilt when it is switched off (the common case);
base maps and WebGL contexts are created on first use rather than at start-up;
and URL token expansion is a single regex pass against one table instead of
eleven chained `.replace()` calls rebuilt per call.

### UI

Dark-first operational console. An icon rail replaces the single long scrolling
panel, so one group is visible at a time; a green dot marks groups with an active
layer. Everything resolves to tokens in `styles/tokens.css`, and light mode is a
real variant. New: search across the whole catalog (`/`), keyboard transport
(<kbd>Space</kbd>, <kbd>←</kbd>/<kbd>→</kbd>, <kbd>L</kbd>), a scrubber with time
ticks, and a diagnostics readout in Settings.

## Generated data

`src/data/layers.js` and `src/data/palettes.js` are generated from the original
file by the scripts in `../tools`, so no product definition or colour was
transcribed by hand. Run them from the repository root:

```bash
node tools/extract-options.cjs     # pull option objects out of the original
node tools/extract-labels.cjs      # pull UI labels out of the <select> markup
node tools/generate-catalog.cjs    # -> src/data/layers.js
node tools/generate-palettes.cjs   # -> src/data/palettes.js
```

Two of those maps were mutated by `Object.assign` *after* their literals in the
original (nine MapsGL products in `lightningOptions` and `nowcastOptions`), so the
literal alone is not what ran. The generator applies those overrides.

`tools/audit-duplicates.cjs` and `tools/audit-layer-kinds.cjs` produced the
duplicate-definition table above and the renderer-kind census.

## Verification

```bash
node tools/verify-equivalence.mjs   # behaviour vs the original, headless
node tools/smoke.mjs                # boots dist/radarloop.html in Chromium
node tools/smoke.mjs http://localhost:8080/index.html   # the modular build
node tools/leak.mjs                 # frames are retired, not accumulated
node tools/tiles.mjs                # every pane's tiles actually decoded
node tools/visual.mjs               # screenshots + scrub-continuity check
node tools/check-imports.mjs        # every named import resolves to a real export
node tools/test-timeline.mjs        # domain, filter and outlook-focus rules
node tools/test-merge.mjs           # strike merge, incl. the 1.6M-strike archive case
node tools/test-slider.mjs          # filter/scrubber behaviour in the browser
node tools/test-outlook-focus.mjs   # outlook -> timeline against the live feed
node tools/test-outlook-noclick.mjs # opening the outlook panel changes nothing
node tools/test-features.mjs        # assets, progressive reveal, 3D, phone layout
node tools/test-audio.mjs           # strike cue: gesture unlock, pool, rate limit
node tools/test-layers.mjs          # wind group, MapsGL teardown, layer manager, 3D schemes
node tools/diag-toggle-all.mjs      # every group x kind turns on and off cleanly
node tools/test-3d-fixes.mjs        # 3D coastline + radar follows the scrubber
node tools/test-3d-placement.mjs    # measures 3D radar displacement by cross-correlation
node tools/test-3d-coverage.mjs     # zoom in, switch to 3D, zoom out: coverage and lifespan
node tools/test-3d-layers.mjs       # MapsGL, overlays, stacking, tile addressing, phone sheet
node tools/test-mapsgl-and-cue.mjs  # MapsGL opacity/stacking, strike cue, 3D resize, attribution
node tools/test-overlays-ui.mjs     # outlooks/drawings as layers, 3D drawing, icons, phone scrubber
node tools/test-cue-and-draw3d.mjs  # thunder cue gating and persistence, drawn shapes in 3D
node tools/test-mapsgl-catalog.mjs  # the MapsGL catalogue reaches the picker and renders (SAMPLE=all for every one)
node tools/test-observations.mjs    # station models load, thin, restack, reach 3D; WMS scrub deferral
node tools/shot-observations.mjs    # a look at the station plot at two zooms
node tools/shot-station-card.mjs    # the station card in both themes
node tools/probe-3d-symbol-scale.mjs # station model size against camera pitch
node tools/probe-stack-anim.mjs     # pane stacking, and what a slow layer does to playback
node tools/probe-obs-time.mjs       # station models following the scrubber
node tools/test-wms-slow.mjs        # a slow WMS still resolves instead of reading as a missing frame
node tools/soak.mjs                 # does it get slower the longer it runs? (ROUNDS=14)
node tools/test-animation-phone.mjs # playback pacing, and a phone opening on the map
node tools/probe-animation-3d.mjs   # 2D vs 3D playback, cold context each, CPU-throttled runs
node tools/probe-gl-cost.mjs        # what terrain/fog/buildings cost during playback
node tools/test-3d-plot.mjs         # tile products fetched once in 3D, and 2D restored on exit
node tools/probe-3d-plot-cost.mjs   # time to plot a layer, 2D vs 3D, cold cache each run
node tools/probe-boot-weight.mjs    # what the shell downloads before the first tile
node tools/probe-mapsgl-supported.mjs  # asks the SDK which layer ids it accepts
node tools/diag-3d-layers.mjs       # sweeps every listed product for a 3D representation
node tools/test-3d-perf.mjs         # latest-frame fallback, 3D scrub cost, 3D resolution parity
node tools/probe-scrub-cost.mjs     # attributes a scrubber step: 2D vs 3D, by phase
node tools/probe-workers.mjs        # tile workers, resolution, and that the palette repaints
node tools/test-archive-topup.mjs   # archive ingestion timing and memory

# The two 3D timing tools take HEADED=1 to measure on the real GPU. Headless
# Chromium rasterises WebGL in software, which makes any 3D timing meaningless.
HEADED=1 node tools/test-3d-perf.mjs
```

`verify-equivalence.mjs` re-implements the original's time formatters and colour
lookup verbatim and compares them against the rewrite across every catalog URL:
**648 URL expansions and all rainfall bucketing match exactly.**

Measured on the built app (14 frame steps, radar + satellite active):

| | |
| --- | --- |
| frames rendered | 21 |
| frames skipped (already on screen) | 9 |
| frames failed | 0 |
| network probes | 8 |
| resolver cache hits | 74 |
| layer containers per pane after 14 steps | 1 |

Eight probes for 21 renders is the learned-lag resolver working; the original
would have issued a probe chain per frame per layer.

## The timeline domain

The scrubber spans an explicit **domain** rather than an implicit "now minus
`historyHours`". Normally that is `[now - historyHours, live]`; applying a time
filter or selecting a forecast outlook replaces it with exactly that window, and
a chip appears on the timeline to release it.

This is what makes three otherwise separate behaviours work:

- **Applying a time filter moves the scrubber.** Previously `setTime` clamped to
  `now - historyHours`, so a filter further back than the scrubber span was
  clamped out of reach and the scrubber never moved.
- **Selecting an outlook points the whole app at it.** See below.
- **Playback wraps within whatever window is in view**, rather than always
  running to the live edge.

### Outlook focus

**Selecting** a HOCO outlook re-bases the timeline onto its validity period.
Four rules apply, implemented in `hoco/focus.js`:

1. **Displaying is not selecting.** The panel auto-shows whichever outlook is
   valid now, but that draws the polygons only. Opening the Outlooks panel must
   never re-base the timeline or change the strike lifespan behind the user's
   back. Focus happens on a calendar click, a version/run change, or the
   panel's explicit "Show this outlook's period" button.
2. **An outlook in force right now is shown from its start up to now**, not to
   its end — the remainder is in the future, where there is no observed data to
   scrub through.
3. **Strike lifespan is set to the window length**, so every strike in the
   outlook period is drawn and the age gradient is normalised across it. The
   previous lifespan is restored when the window is released.
4. **Manual outlooks outrank automated runs.** While a manual outlook holds the
   timeline, selecting an automated run leaves it alone and the automated panel
   says why; releasing the manual window (the timeline chip) frees it.

### Progressive reveal

Inside a focused window the strike set accumulates from the window's start up to
the scrubber position, rather than showing the whole period at every position.
Parked at the end you see everything; dragging back plays the period out. See
`activeWindow()` in `time/controller.js`.

## 3D mode

`core/map3d.js` runs a Mapbox GL view with terrain (`mapbox-terrain-dem-v1`,
1.4× exaggeration), atmospheric fog and extruded buildings above zoom 13. Leaflet
stays authoritative: entering 3D copies the camera across and mirrors the active
frames and strikes; leaving carries the camera back and releases the GL context,
because a second live WebGL context is expensive on every device.

**Not every product can be mirrored.** A GL raster source paints whatever the
tile contains, so a product only works in 3D if its tiles are already display
colours:

| Product | 3D | Why |
| --- | --- | --- |
| DTN / Xweather raster tiles | yes | already coloured |
| Global High Resolution (Windy) | no | tiles are reflectivity data, recoloured per-pixel in 2D |
| OPERA | no | binary grid reprojected onto a canvas, not tiles |
| EUMETSAT GeoColour | no | WMS needs per-tile EPSG:4326 bounds |
| Vector, MapsGL and plotted products | no | not raster tiles |

Because the default radar is one of the recoloured products, entering 3D says
which layers are 2D-only and offers a one-click switch to a compatible radar
rather than silently showing an empty globe.

### What 3D can show

`core/mirror3d.js` maps each product kind onto a GL representation. Getting the
tile scheme wrong here is *silently* wrong rather than broken — flipped-Y
imagery simply renders upside down and misplaced.

| Kind | GL representation |
| --- | --- |
| raster | raster source, `scheme` derived from the tile addressing (`tms` for DTN and `{-y}` templates) |
| wms | raster source rewritten to `{bbox-epsg-3857}`, which GL can template |
| pbf | vector source + fill layer driven by the provider's `fill-color` |
| geojson / esri-feature / xweather | geojson source + fill, line and circle layers |
| opera, Global High Resolution | viewport texture: the canvas we already render, pinned to its bounds |
| image | image source at the catalog's bounds |

The canvas-backed products are a still of the current frame rather than a live
tile pipeline — the same trade-off the 2D OPERA layer makes. They are pinned to
the bounds the 2D map had when captured, so the hidden 2D map is driven from the
GL camera and the stills are re-captured when it settles; a pitched camera sees
further than the 2D view can cover at the same scale, so the capture gives up to
three zoom levels to cover it and the far field beyond that falls outside the
still (it is behind fog anyway).

Mirrored canvas products are placed from tile coordinates through the map
projection, never from Leaflet DOM positions — see `tilePlacement` in
`layers/mirrorBridge.js` for why.

The coastline and place-label overlay is mirrored too (`setReferenceMirror`), as
a 512px raster source kept above the weather and below the strikes. It is a
Leaflet layer in 2D and cannot be shared, so without its own GL copy the 3D view
had no coastline at all.

### 3D cost, measured

`tools/probe-scrub-cost.mjs` times a scrubber step in both views and breaks it
into phases; `tools/test-3d-perf.mjs` asserts the result. With the Global High
Resolution radar active, 1500×950:

| | 2D | 3D |
| --- | --- | --- |
| median step | ~490 ms | ~510–860 ms |
| tile requests | 31–39/step | 31–39/step |
| build layer | ~8 ms | ~7 ms |
| tiles load + recolour | ~390 ms | ~430 ms |
| mirror into GL | — | **1–10 ms** |

3D costs roughly 10–20% more than 2D, which is the GL frame itself.

Two things got it there. Canvas sources removed the per-frame PNG encode and
decode, so the mirror is nearly free. The larger win was moving the tile pipeline
off the main thread: `layers/windyPool.js` runs a pool of workers that fetch,
decode, crop and recolour each tile and hand back an `ImageBitmap` the main
thread blits in one call. A viewport is ~40 tiles, which at a 2× device ratio is
ten million pixels of per-pixel work per frame; inline, that competed with
Leaflet in 2D and with GL rendering terrain, fog and stars in 3D.

The colour scale reaches the workers as a 511-entry lookup table indexed by
`r + g`. Windy's encoded value is `(r + g) / 2`, so indexing on the sum
reproduces the main-thread arithmetic exactly instead of quantising the
half-steps away, and no palette logic is duplicated in the worker.

`layers/windy.js` keeps its inline path as a fallback for browsers without
`OffscreenCanvas`, `createImageBitmap` or workers, and falls back to it per tile
if a worker dies or a fetch fails.

### 3D resolution matches 2D

An earlier version of this optimisation bought its margin by rendering tiles at
device ratio 1 in 3D and capping the mirrored composite at 1280px. Both were
visible as a softer radar. Neither is done now:

- tiles render at the same `devicePixelRatioStep()` in both views;
- the capture scale equals that ratio, so each tile's backing store lands 1:1 in
  the composite with no resampling;
- the only ceiling is the GPU's `MAX_TEXTURE_SIZE`, queried once, since a texture
  past that is rejected outright.

On a 2× display the mirrored composite is 3000×1804 rather than 1280 wide.
`tools/test-3d-perf.mjs` asserts tile backing size is identical in both modes and
that the capture is not downscaled.

**Measure 3D on a real GPU.** Headless Chromium rasterises WebGL on the CPU
through SwiftShader, where 3D measures four to ten times 2D no matter what the
application does — that artefact is what earlier "median step 5334 ms" numbers
were. Both tools take `HEADED=1` to run on the actual GPU, and `test-3d-perf.mjs`
detects a software renderer and skips the timing assertion rather than reporting
a number that means nothing.

Timings compare 3D against 2D **within the same run**, never against a fixed
millisecond budget, for the same reason.

**Count only steps that change frame.** Neighbouring slider positions can resolve
to the same 10-minute frame, where there is no work to do. Timing those measured
the harness's own deadline, which is where the multi-second "stalls" in earlier
runs came from; both tools now skip and report them.

**The 2D map is hidden with `visibility: hidden`, never `display: none`.** The
canvas-backed products are mirrored by capturing what Leaflet has already
painted; taking the map out of layout collapses its size and its tiles' box
metrics, so those captures come back empty or stale and the 3D radar stops
following the scrubber.

## What the pickers offer

`data/productOrder.js`, applied to the catalog at load, after the MapsGL merge
and the name scrub. Both membership and order are derived from the entries
themselves rather than kept in step by hand, because the catalog is edited
directly and a parallel array is a thing to forget.

**`listed` decides membership.** It always meant "offer this one", but only the
search box read it: `listLayers` walked `__order` alone, so turning a product
off left it in every drop-list. Forty-two products were retired in one editing
pass and every one of them was still on offer.

**Provider decides order**, matched on the request URL — the one field that
cannot be edited into disagreeing with where the data actually comes from, since
labels are scrubbed of provider names before anything reads them. Global
high-resolution composites first, then the regional model and radar products,
then the wide-coverage commercial feeds, then the rest. Within each of those the
catalog's own order survives, so a deliberate arrangement of related products is
not scrambled.

**Ordering happens inside a heading's section, never across it.** A heading names
what follows it — "Marine Data", "Global Accumulated Precipitation" — and sorting
through one files products under a description that does not fit them.

Three things fall out of doing it this way rather than by hand:

- **A heading with nothing left under it is dropped.** Retiring the last product
  under "Satellite Precipitation Estimation" would otherwise have left the
  heading with an empty list beneath it.
- **Merged products get a section of their own.** `mergeMapsGLLayers` used to
  push its entries onto the end of `__order`, which put them under whatever
  heading happened to be last — a radar layer was filed under "Satellite
  Precipitation Estimation". It now declares them and leaves the filing to the
  ordering pass. The trailing section needs its own heading rather than none,
  because headings become `optgroup`s and a picker cannot get back out of one:
  every option after the first heading joins whichever group is open.
- **A retired product does not survive a session restore.** The remembered
  selection is checked against what the group now offers and replaced if it is
  gone. Doing this only when the panel card is built was not enough — on a phone
  the cards start collapsed, so the layer would render something no picker
  listed.

One provider name was reaching the interface through a route the scrub did not
cover: the section headings inside `__order` are display text like any label,
and one of them read "--- MapsGL Severe Layers ---". `scrubCatalog` cleans them
now.

`tools/test-product-lists.mjs` checks all of it: nothing offered that the catalog
no longer defines, nothing offered that has been retired, no empty headings, no
section whose provider order runs backwards, and no heading naming a provider.

## Layer manager

The **Layers** panel lists everything currently drawn, topmost first, and rows
can be restacked by dragging the handle or with ↑ / ↓. Reordering renumbers the
pane z-indexes (and moves the GL layers in 3D) rather than re-fetching anything.

Dragging is implemented with pointer events and an explicit placeholder rather
than HTML5 drag-and-drop, which does not fire on touch — this panel has to work
in the phone layout too. Keyboard reordering is not a nicety here: it is the only
non-pointer route to the stacking order.

`layers/control.js` is the single entry point for enabling, selecting, opacity
and ordering, so the cards, the search box, the layer manager and the 3D fallback
all behave identically. Previously `selectProduct` lived in the search UI and the
enable path existed only as an inline handler on the card, which is how they
drifted apart.

## Brand assets

Taken from the original build (`config.js` → `ASSETS`): the RadarLoop wordmark in
the top bar, the Handry Outlook icon on the outlook panel, and the same strike
audio file. The wordmark falls back to a text mark if the remote image fails.

The strike cue is more than `audio.play()` — see `lightning/audio.js`. Browsers
block audio until a real user gesture and a rejected `play()` fails silently,
which is why the cue previously worked only sometimes. The pool is now unlocked
on the first gesture of any kind, and a four-element round-robin lets closely
spaced strikes overlap instead of truncating each other. The cue is also gated on
`fromData`: a redraw caused by moving the scrubber produces "fresh" strikes that
are only newly *in view*, and without that gate it fired continuously while
dragging.

## Bugs found and fixed during verification

Four defects were caught by the tests above rather than by reading the code, and
are worth recording because three of them are easy to reintroduce:

1. **Weather rendered under the base map.** Custom panes were numbered 140–155,
   but Leaflet's own `tilePane` is z-index 200, so the entire weather stack was
   hidden. The original avoided this by nesting weather inside `overlayPane`;
   `config.js` now does the same and says why.
2. **`$$` corrupted by the bundler.** `String.replace` with a *string*
   replacement treats `$$` as an escape, so `export const $$` in `core/util.js`
   became a duplicate `$`. The bundler now uses function replacements throughout.
3. **`{bbox}` never expanded.** The EUMETSAT WMS product was being handed to a
   plain `L.tileLayer`, which requested the literal placeholder. `layers/wms.js`
   restores the XYZ→EPSG:4326 conversion and the publication-delay retry.
4. **Mutable exports mis-bundled.** `export let map` is a live binding under
   native ES modules but was snapshotted to `null` by the bundler. The map is now
   a `const` created at module init, and the bundler *fails the build* on any
   mutable export rather than emitting something subtly wrong.
5. **The lightning archives never loaded.** `merge()` used
   `all.push(...fresh)`, which throws `RangeError: Maximum call stack size
   exceeded` once the batch exceeds the engine's argument limit — and the
   archives arrive as one batch of ~1.6 million strikes. The failure was
   swallowed by a `.catch()` that only warned, so the app silently had no history
   beyond the live feed. `merge()` is now a linear two-pointer merge of two
   sorted arrays (129 ms for 1.6M) and de-duplicates on adjacency instead of
   keeping a `Set` of 1.6M string keys. Strike records were also slimmed to
   `{ ms, lat, lon }` — dropping the spread copy and the per-strike `Date`
   reduced heap for the full archive from **595 MB to 202 MB**.
6. **Retention deleted history the scrubber could reach.** Pruning was hardcoded
   to 48 hours, so raising the scrubber span to 300 hours discarded exactly the
   data the extra range existed to show. The cutoff is now derived from the
   reachable domain, and `ensureCoverage()` re-merges the archives if a focused
   window predates what is retained.
7. **`element.hidden` did nothing for several components.** The UA stylesheet's
   `[hidden] { display: none }` is outranked by any author display rule, so
   `.chip { display: inline-flex }` kept the timeline's focus chip permanently
   visible as an empty pill. `base.css` now enforces `[hidden]` with
   `!important`; the panel, which animates out rather than disappearing, opts
   back in explicitly.
8. **3D painted radar data as a blue sheet.** Mirroring the Windy composite into
   a GL raster source showed the raw reflectivity texture — pure blue is its
   no-data mask. Products are now checked with `canMirror()` before mirroring.
9. **The map attribution sat under the docked phone chrome.** Leaflet pins it to
    the bottom of the map container, which on a phone is behind the rail and
    timeline. It moves to the top edge below 720px, so it stays legible.
10. **The entire wind group was empty.** `windOptions` was never added to the
    extractor's list, so the generated catalog had no wind products at all and
    the group silently offered nothing. Found by a sweep that enabled every group
    in turn rather than by reading the code. 14 definitions (9 listed) restored.
11. **MapsGL layers could not be switched off.** The controller initialises
    asynchronously and rejects `addWeatherLayer` until it is ready — so the call
    threw, the layer was never registered, and because nothing tracked it, the
    controller and its full-map canvas were never torn down. It looked like a
    layer that would not turn off. `whenMapsGLReady()` now gates the add, the
    intent is recorded before the await so an early switch-off still tears down,
    removal is verified with `hasWeatherLayer` rather than trusted, and teardown
    calls `dispose()` — the previous `destroy?.()` matched nothing and, being
    optional-chained, failed silently. The orphaned canvas is detached too.
12. **3D mirrored nothing on entry.** `renderAll` skips any slot whose frame is
    already drawn, so entering 3D never reached the mirror. `remirrorAll()` feeds
    the GL view from the layers the 2D map already holds, with no refetching.
13. **DTN products rendered flipped in 3D.** Leaflet is told about flipped-Y
    addressing with `tms: true`; the GL equivalent is the source's `scheme`, and
    omitting it mirrors the imagery vertically. Ten of the seventeen satellite
    products are affected.
14. **No coastline in 3D.** The reference overlay is a Leaflet layer, so the GL
    view needs its own copy — see `setReferenceMirror`.
15. **The 3D radar stopped following the scrubber.** Two causes. `display: none`
    on the 2D map collapsed the layout the canvas capture depends on, and
    `updateImage` starts an asynchronous decode that drops earlier updates when
    called again before it settles — exactly the pattern scrubbing produces.
    Image updates are now coalesced to one per frame with the newest winning.
    Worth noting how this was found: the first test checked the GL source's
    serialised `url`, which does *not* reflect `updateImage`, so it reported a
    failure that was really a measurement error. Comparing rendered frames
    settled it.
16. **The mirrored radar was misplaced in 3D.** The composite was assembled from
    `L.DomUtil.getPosition(tile)`, which is relative to Leaflet's tile *level*
    container — a container with its own translation. Subtracting only the
    map-pane origin left that offset in, shifting the whole image. Tiles are now
    placed from their own coordinates through the map projection
    (`tilePlacement`), which is exact and independent of Leaflet's DOM.
17. **Layers with no data at NOW drew nothing.** The resolver started at the
    current time with a budget of two to four steps back, so any product
    publishing further behind — the hourly marine and forecast grids especially —
    never resolved, and with no earlier frame cached it drew a blank. It now
    searches for the newest frame that exists using a geometric ladder of offsets
    plus a short refinement, then caches the lag per product. Measured: 22 probes
    to bring two previously-blank hourly products up, each resolving to a real
    frame 0.7 h old.
18. **Scrubbing was slow everywhere, and very slow in 3D.** The Windy layer set
    `minNativeZoom` to its maximum, so Leaflet rendered the whole viewport at
    zoom 7 regardless of the map zoom — **392 tile requests per scrubber step
    instead of ~31**, each decoded and recoloured per pixel. Windy serves every
    zoom from 3 upwards, so those requests bought nothing visible. Removing the
    floor (keeping the ceiling, which `createTile` already crops against) took a
    2D step from **6365 ms to ~560 ms**.

19. **3D drew a softer radar than 2D.** The first attempt at the problem above
    also halved the device pixel ratio in 3D and capped the mirrored composite at
    1280px, which bought speed with visible detail. Both are gone: the tile
    pipeline moved into a worker pool (`layers/windyPool.js`), so 3D renders at
    the same ratio as 2D and captures at that ratio, capped only by the GPU's
    `MAX_TEXTURE_SIZE`. A 2× display now mirrors a 3000×1804 composite.

20. **The rainfall colour picker moved the legend and left the radar alone.**
    `refreshWindyColours` and `refreshOperaColours` were written for this and
    never called from anywhere, and the renderer short-circuits on an unchanged
    frame URL — which cannot express that the *scale* changed. The colour-scale
    signature is now part of `frameKey`, so a preset change counts as a new frame
    for the two client-coloured products, and OPERA's rendered-frame cache is
    keyed on it too. Both dead helpers were removed. Found by
    `tools/probe-workers.mjs`, not by reading the code.

21. **3D looked four to ten times slower than it was.** Headless Chromium
    rasterises WebGL on the CPU through SwiftShader, so every 3D timing measured
    the test runner. On the real GPU the same build scrubs within 10–35% of 2D.
    The timing tools now report the renderer, take `HEADED=1`, and compare 3D
    against 2D within one run instead of against a fixed budget. The
    multi-second "stalls" in those runs were also an artefact: neighbouring
    slider positions can resolve to the same 10-minute frame, and the harness
    timed its own deadline waiting for a load that was never going to happen.


22. **In 3D the radar only covered where you were when you entered.** The
    still-image products are captured from the 2D map, and nothing pointed the 2D
    map at the GL camera — so zooming into Bristol, switching to 3D and zooming
    out showed radar over Bristol and nowhere else, with the texture's pixel size
    drifting on every zoom because it stayed pinned at the entry scale. The
    hidden 2D map now follows the camera (`followCamera` in `core/map3d.js`) and
    the stills are re-captured when it settles. `getBoundsZoom` was the wrong
    tool for the fit: it snaps down to a whole level, costing a level of detail
    even when the camera was flat and the two views already agreed, so the fit
    zoom is computed fractionally and Leaflet rounds it.

23. **The strike lifespan came back as 23.98 hours on every load.** Focusing an
    outlook sets the lifespan to that window's length, and `setLightningOption`
    persists everything it is given — so a temporary override became the startup
    default forever. Earlier work stopped the outlook panel from *auto*-focusing,
    which removed one way of triggering it but not the cause. The override is now
    explicitly non-persisting, and because the control steps in tenths of an hour,
    a stored value off that grid is known to have come from the override and is
    discarded on load, clearing the ones already written.


24. **DTN isobars and surface fronts were upside down in 3D.** The two views
    disagreed about tile addressing: `layers/renderer.js` told Leaflet to flip Y
    only for DTN *satellite*, while `core/mirror3d.js` flipped every DTN URL. DTN
    serves flipped-Y for satellite imagery alone, so the isobar and front tiles
    were mirrored vertically in 3D only. Both now call one exported rule,
    `usesFlippedY`, and `tools/test-3d-layers.mjs` asserts the two agree.

25. **Whole categories of product did not exist in 3D.** The renderer returns
    early for products drawn by their own engine, so `mirrorTo3D` was never
    offered them and nine MapsGL products — "Lightning All (Tile)" among them —
    were simply absent. MapsGL renders all its layers into one canvas it owns, so
    that canvas is now captured and mirrored the same way the recoloured radar
    is. It paints asynchronously with no "drawn" event, so the capture is retried
    for a few seconds (`mirrorMapsGLSoon`).

26. **The in-house nowcast and the HOCO outlook polygons were absent from 3D.**
    Neither is a catalog product, so nothing in the slot pipeline ever offered
    them. Both are drawn onto Leaflet canvas panes, so they are mirrored as
    canvas sources like everything else — which keeps their per-feature risk
    colours instead of re-deriving the risk ladders as GL paint properties.

    Two details this needed. Leaflet canvas renderers paint on the *next* frame,
    so capturing straight from a draw call reads the previous picture;
    `refreshOverlayMirror` waits two frames and coalesces. And a renderer keeps
    its canvas element in the pane after its last layer is removed — cleared, but
    present — so "are there canvases?" is not "is anything drawn?", and the
    mirror kept a blank layer alive after an outlook was dismissed. Emptiness is
    now tested on a 128px downscale of the composite, which is cheap and still
    catches a one-pixel outline.

27. **Lightning could not be shown above the radar in 3D.** GL appends each new
    layer on top, so whatever was mirrored last won. Two places tried to prevent
    this and both looked for a layer called `wx-strikes` — that is the *source*
    id; the layer is `wx-strikes-layer`, so the lookup never matched and the
    guard silently did nothing. `restackTop` now reasserts the whole top of the
    stack — coastline, then strikes, then the outlook and nowcast overlays — after
    every add, in the order the 2D pane stack uses.

28. **The base map picker did nothing in 3D.** The GL view used dark or light by
    theme, and the `satellite` branch of `styleFor` was unreachable. Mapbox base
    maps now carry a native `glStyle` that the 3D view adopts. Only an *explicit*
    choice carries over: the shipped default is a night style, so honouring it
    unconditionally opened 3D dark for a light-mode user — the opposite of what
    the theme asks for. On the default, 3D follows the theme.

29. **Restyling the 3D view could kill the renderer.** Terrain refers to a source
    the incoming style is about to discard, and calling `setStyle` with it still
    attached crashed the page — reachable just by changing base map twice.
    `setTerrain(null)` now precedes the restyle, `style.load` re-adds it, and a
    restyle to the style already applied is skipped.

30. **The phone panel was unusable under the rail and the timeline.** All three
    were pinned to `bottom: 0` and separated only by z-index, and the panel had
    the lowest (690 against the rail's 700 and the timeline's 710), so opening it
    slid it underneath both. They are stacked against each other now: timeline at
    the bottom, rail on top of it, sheet on top of that, with the sheet's height
    being whatever is left under the top bar. The heights cannot be hard-coded —
    the timeline wraps to two or three rows and the rail grows with the safe-area
    inset — so `ui/layout.js` measures them and republishes `--timeline-dock` and
    `--rail-dock` on every change. Nothing was hidden to make room; on a 390×844
    phone the sheet still gets 438px.

31. **The lightning rail icon was yellow.** U+26A1 is the one glyph in the rail
    that defaults to *emoji* presentation; the map, thermometer, warning and gear
    glyphs are all text-default, which is why only that one rendered in colour. It
    now carries U+FE0E, with `font-variant-emoji: text` on the button as backup.

32. **Xweather overlays did not refresh in 3D.** The in-place data swap that
    keeps the 2D overlay from flashing returned before re-mirroring, so 3D kept
    showing the previous refresh indefinitely.


33. **Weather-source names are kept out of the interface.** `data/sourceNames.js`
    is the single place that decides what counts as a source name, and
    `data/layers.js` runs `scrubCatalog` over itself at load, so regenerating the
    catalog cannot reintroduce one; the free-text popup fields go through the
    same `cleanLabel`. Acronyms are matched case-sensitively and full names are
    not — `GOES` is also an ordinary English word, and matching it loosely ate
    its way through alert prose.

    Base map credits are exempt on purpose. Mapbox, OpenStreetMap, MapTiler,
    OpenTopoMap and Esri stay in the attribution control: those are
    licence-required and they identify the *map*, not the weather data. Note that
    requests are unchanged either way — hostnames, keys and payloads are all
    still visible in the network tab, so this is a presentation change rather
    than concealment.

34. **MapsGL products ignored the opacity slider.** `controller.setLayerOpacity`
    does not exist in this SDK build, and the call was optional-chained inside a
    swallowing `try`, so a missing method looked exactly like a working one.
    `setPaintProperty`, `getWeatherLayer` and `findLayer` either return nothing
    for a weather layer id or leave the surface untouched. Opacity is applied to
    the render canvas instead, which does work.

35. **MapsGL products always drew underneath everything.** The controller injects
    its canvas as a direct child of Leaflet's overlay pane, where it lands at
    z-index 100 while every weather pane sits at 140 and above. The canvas now
    takes the z-index of the group it is drawing for, so the layer-order tab
    moves it like any other layer. One surface serves every MapsGL layer, so with
    products active in two groups they share one opacity and one position — a
    limit of the SDK's single-canvas design.

36. **The strike cue never fired.** The live window ended at `time.current`, the
    last auto-follow tick, and `filterWindow` cuts at `ms <= end` — so a strike
    arriving between ticks was outside the window at exactly the moment the live
    poll asked "is any of this new?". The answer was no, and by the time the
    clock caught up the redraw was a clock refresh rather than a data one, which
    the cue deliberately ignores. At the live edge the window now runs to *now*,
    with a minute of tolerance for clock skew against the feed. This also means a
    new strike is drawn when it arrives rather than at the next tick.

    `strikeCueState()` records the gate values at the decision point. This cue
    has now broken twice through an upstream gate going false invisibly, and
    inferring it from whether a sound came out does not work: headed Chromium
    enforces an autoplay policy that headless does not.

37. **Resizing the window made the 3D overlays slide around.** Every still is
    captured against the 2D container's size and bounds, and Leaflet only learns
    it has been resized when told — which happened on a shared 150 ms debounce.
    Until then the captured geometry described the old viewport while GL had
    already adopted the new one. 3D now invalidates the 2D size itself on both
    its own `resize` and the window's, then re-follows and re-captures.

38. **Switching a layer off from the layer-order tab left its card switch on.**
    Only `syncRail` was bound to `LAYER_TOGGLED`; `syncCards`, which brings the
    switch, the body and the select back into line, was called at boot and never
    again. Both layer events now run it.


39. **On a phone the clock and the scrubber thumb disagreed mid-drag.** The
    write-back that keeps the thumb in step with the clock was skipped only while
    `document.activeElement === slider` — true when dragging with a mouse, but
    touch does not focus a range input. So on a phone every `TIME_CHANGED` during
    a drag rewrote the thumb from the rounded, clamped timestamp while the
    readout showed the raw one. Pointer and touch events now answer "is the user
    holding this?" directly, and the thumb is settled once on release.

40. **Outlooks and drawn shapes are layers.** Both are real overlays with no
    catalog product behind them, so they had no row in the layer list and no way
    to be restacked. They register through `layers/registerOverlays.js` and take
    part in ordering, visibility and opacity like anything else — without being
    forced through the tile pipeline, which would have meant a slot, a frame
    resolver and a product picker for something that has none of those.

    Preset order, bottom to top: satellite, automated outlook, manual outlook,
    radar, with drawn shapes above the weather. Each outlook's fill and outline
    panes move together, so it reads as one layer; that also means the outlines
    are no longer pinned above the entire map, which is the point of making them
    orderable.

    An overlay that becomes visible on its own — the drawn shapes appear the
    moment the first polygon closes — is brought to the front rather than seated
    by preset. Presets place a layer at registration, before anything has been
    reordered; seating against a list the user has since rearranged puts it
    somewhere arbitrary, which is how the first shape drawn ended up underneath
    the weather.

41. **Polygons could not be drawn in 3D.** leaflet-draw only knows about the
    Leaflet map, which in 3D is behind the GL canvas, so "Start drawing" there
    did nothing visible or clickable. `tools/draw3d.js` collects vertices from
    the GL canvas instead — click to place, click the first vertex or press Enter
    to close, Backspace to undo, Escape to abandon, with a rubber band following
    the pointer because on a pitched camera it is otherwise hard to tell where a
    click landed. The finished ring goes through the same `addPolygon` the 2D
    tool uses, so a shape drawn in 3D is the same object: same style, same popup,
    same feature group, same KML export, same row in the layer list.

42. **The drawing toolbar sat on top of the interface.** leaflet-draw defaults to
    the top-left corner, which is where the rail and the top bar are, and the
    bottom edge of the map container runs underneath the docked timeline. It is
    bottom-right now, lifted clear of the timeline, and on a phone clear of the
    measured rail and timeline docks.

43. **The icons were a rendering lottery.** Every icon was a text glyph — `⚡`,
    `🗺`, `🌡`, `◍`, `≋`. Some have an emoji presentation (the bolt came out
    yellow among monochrome neighbours), some have no glyph at all in certain
    system fonts and fall back to a box, and their weights never matched because
    they come from whatever fonts happen to be installed. `ui/icons.js` draws
    them instead: one 24×24 grid, one stroke weight, `currentColor` throughout,
    so they inherit each button's colour and states.

44. **The location popup was a bare Leaflet default** reading "Your location",
    with none of the application's styling, and it added a fresh marker on every
    press so they piled up. One marker now, the application's popup shell, and an
    accuracy halo drawn in metres — a 3 km fix and a 30 m fix mean very different
    things and the old popup said neither.

45. **The outlook calendar could go stale or drop a tap.** It captured the index
    once when the panel was built, so outlooks published afterwards never
    appeared; it is read on every paint now. Clicking a day repainted the whole
    grid from inside that day's own click handler, replacing the button
    mid-event, which made taps intermittent on touch — the selection is marked in
    place instead. Month navigation also stops at the range that actually holds
    outlooks rather than wandering into empty years.

46. **The latest-frame search stepped over the only available frame.** The ladder
    is geometric — 0, 1, 2, 3, 4, 6, 8, 12 … — so it never asks for offset 5. When
    the marine grids narrowed to a single frame five hours back, they became
    invisible to it and drew nothing, exactly the failure the ladder was added to
    fix. A bounded dense sweep of the near offsets now runs when the ladder finds
    nothing: a dozen probes once per product per TTL, only on the failure path.


47. **The thunder cue never fired, for two separate reasons.**

    `lightning.sound` was the one lightning option `setLightningOption` did not
    persist — `showLayer` and `colorByAge` were in the map, it was not — so the
    switch reset to off on every reload. Turning it on and coming back the next
    day left it silent with no indication why. It now persists like its
    neighbours.

    The gate was also far narrower than the behaviour it was meant to express. It
    required `fromData && atLive && !playing`: only strikes arriving from the live
    poll, which runs every few minutes, so in a quiet spell over the UK it is
    hours between cues, and scrubbing forward through a storm — plotting strike
    after strike — made no sound at all.

    What actually needs guarding is a bulk plot: the archives landing, or a
    window jump putting hundreds on screen at once, where one clap is right and
    two hundred is not. So the cue now fires on any newly plotted strikes, capped
    at `CUE_BULK_LIMIT` (25) per redraw, with a `CUE_MIN_GAP_MS` (400) floor
    between cues on top of the 90 ms redraw throttle — twelve arrivals in 1.2 s
    produce three cues, not twelve. Playback stays excluded: it reveals a frame
    of strikes several times a second, and a rumble on every frame is noise.

    The old gate carried a comment saying the cue had already been broken twice
    by something upstream going false invisibly. It was broken a third time by
    the same shape of problem, which is why `strikeCueState()` now also reports
    `bulk` and `spaced`.

48. **Hand-drawn polygons were invisible in 3D.** Registering them as an
    orderable layer gave them a pane, a row in the layer list and a stacking
    position, but `mirrorBridge`'s `OVERLAY_PANES` — the list of Leaflet panes the
    GL view captures — was never extended to include `drawPane`. They existed
    everywhere except the view the user was looking at. Adding the pane covers
    both shapes drawn in 2D and shapes drawn in 3D, since both end up in the same
    feature group.


49. **A slow WMS was mistaken for a missing frame.** EUMETSAT answers 502 for a
    frame it has not published yet and 200 once it has, which the resolver
    already handled by stepping back a frame. The failure was a different one:
    the service renders on demand and is highly variable — a warm tile comes back
    in about 0.3 s, a cold one in seconds — and the probe deadline was a flat
    4 s. A probe that times out is indistinguishable from a frame that does not
    exist, so the resolver stepped back, paid the same slow probe again,
    exhausted its attempts and drew nothing at all. With every response held back
    six seconds the layer produced `drew: false, tiles: 0`; WMS probes now get
    12 s and it resolves normally. `tools/test-wms-slow.mjs` delays the service
    deliberately, because the real one is too fast and too variable to show it.

    **Do not "optimise" the probe by shrinking the request.** A probe only asks
    whether the service will answer, so asking for 1×1 instead of 256×256 looks
    like free savings — 69 bytes instead of 130 KB — and makes it *slower*.
    EUMETSAT is served with `tiled=true`, so a standard 256px tile request is
    answered from GeoServer's tile cache in ~0.3 s, while a non-standard size
    misses that cache and forces a fresh render: measured at 3 s, and once at
    11 s. A probe is by definition the first request for a frame, so it would pay
    that cold cost every single time. This was tried, measured, and reverted.


50. **Asking playback to go faster made it draw less and download more.** The
    loop scheduled the next step on a bare timer without waiting for the current
    frame to reach the screen — despite a comment claiming the opposite. At 4×
    that requested a frame every 250 ms while frames were taking around 700 ms:
    `renderAll` dropped the requests it could not service, but `time.current` had
    already advanced past them, so tiles were fetched for frames that were
    superseded before they finished.

    | | frames drawn | tiles | per frame |
    | --- | --- | --- | --- |
    | 4×, unpaced | 14–16 | 455–490 | 21–33 |
    | 4×, paced | 22–25 | 175–315 | 12–13 |

    Each step now waits for the frame to land, capped at `FRAME_DEADLINE_MS` so a
    stalled provider degrades playback rather than freezing it. Speed becomes a
    ceiling rather than a demand: it runs as fast as the data allows and no
    faster. The worst-case gap at 1× fell from about 3.0 s to 1.2 s.

    `tools/test-animation-phone.mjs` asserts on **tiles per frame**, not frames
    per second — the frame count swings with the provider run to run, but the
    ratio is stable and is exactly what the unpaced loop got wrong.

    **Raising `fetchConcurrency` during animation was tried and did not help.**
    The theory was that a single frame in flight could use the whole connection
    pool. Run-to-run variance was wide enough that the two settings could not be
    separated, so the conservative value stays.

    **The pacer is injected, not imported.** `whenRenderSettled` lives in the
    renderer, which pulls in the whole map stack; importing it into
    `time/controller.js` made that module impossible to load without a DOM and
    broke the equivalence harness — the same coupling mistake as an earlier one
    where the Windy tile layer imported `is3D`. `main.js` supplies it through
    `setFramePacer`, and the controller simply does not wait without one.

51. **A phone opened onto a panel instead of the map.** A first visit opens the
    radar panel so the controls are discoverable, which on a phone is a bottom
    sheet covering most of the map — the one thing someone opening a weather map
    wants to see. Desktop still opens it; phones get the map, with the rail
    already visible to say what the panels are.


52. **3D playback stalled and showed nothing on a slow device.** Two separate
    causes, and neither is reproducible on a capable GPU — there 3D playback is
    consistently *faster* than 2D (40 frames against 30 at 4×, median 323 ms
    against 425 ms), because the Leaflet map is `visibility: hidden` so the
    browser skips painting it, and the GL upload costs 1–2 ms. Emulating a slow
    device with 6× CPU throttling is what surfaced it.

    **The frame deadline was fixed at 4 s.** A throttled machine takes around
    3.5 s to load a 3D frame, so frames timed out and were skipped just as they
    were about to appear — which reads as nothing being plotted rather than as
    slow playback. The budget now follows the recent frames (median × 3, bounded
    to 4–15 s), so a slow device degrades to a slideshow that still shows every
    frame. Throttled 6×: **1 frame per 14 s → 3–4**.

    **The mirrored composite was captured at full device resolution during
    playback.** On a 2× display that is a 3000×1804 texture uploaded several
    times a second. It is halved while playing and taken again at full resolution
    the moment playback stops, so the frame anyone actually studies is unchanged.
    Throttled, the mirror phase fell from 47 ms to 25–30 ms.

    **Stripping the 3D scenery was measured and rejected.** Terrain, fog and
    extruded buildings draw every GL frame and looked like the obvious suspects.
    `tools/probe-gl-cost.mjs` removes each in turn under the same throttling:
    with everything on, 4 frames at a 2619 ms median; without terrain, 3 frames
    at 5599 ms; without terrain, fog and buildings, 3 frames at 4495 ms. Run-to-run
    variance swamps any difference, so the scenery is not the bottleneck and
    degrading the view would have bought nothing.

    What remains on a slow device is CPU-bound: decoding and recolouring roughly
    24 tiles per frame while GL renders. 3D playback there is still several times
    2D, and that is honest rather than fixed.


53. **Tile products were downloaded twice in 3D, and the wait was for the copy
    nobody could see.** GL is handed a raster source and fetches the tiles by
    URL itself, but the renderer still loaded the same tiles into the hidden
    Leaflet map first — and blocked on them — before mirroring. Leaflet only
    requests tiles once its layer is on a map, so simply not adding it removes
    both the duplicate download and the wait.

    | time to visible | 2D | 3D before | 3D after |
    | --- | --- | --- | --- |
    | radar (plain tiles) | 2409 ms | 6518 ms | **2380 ms** |
    | satellite (plain tiles) | 1982 ms | 2711 ms | **2844 ms** |
    | EUMETSAT WMS | — | ~5965 ms | **~5220 ms** |

    `slot.glDirect` marks a slot whose Leaflet layer was skipped, and
    `exitGlDirect` rebuilds those on the way back to 2D — without it the 2D map
    returns empty, which is most of what `tools/test-3d-plot.mjs` checks.

    **One measurement said to exclude WMS and was wrong.** Skipping the Leaflet
    copy appeared to take EUMETSAT from 2.0 s to 7.2 s, which suggested the 2D
    load was warming GeoServer for that timestamp. Three runs each way said the
    opposite — 5.2 s direct against 6.0 s with the preload — and that service is
    variable enough (0.3 s to 11 s for the same tile) that no single run means
    anything. It is included.

    **This nearly shipped the Windy composite as raw data tiles.**
    `isCanvasBacked` identified the composite by `layer._tiles`, which Leaflet
    does not create until the layer is added to a map — and the new question is
    asked *before* the add, to decide whether the add is needed. It quietly
    answered "not canvas-backed", which would have handed GL the unrecoloured
    tiles, with reflectivity still sitting in the red and green channels. It now
    tests the class the layer was constructed with. `tools/test-3d-perf.mjs`
    caught it: `kind=raster` where `canvas` was expected.


## Load speed

The shell used to pull **4.7 MB of blocking third-party JavaScript** before the
first tile was requested — on every load, whether or not the session ever touched
the feature it belonged to.

| library | KB | reachable only through |
| --- | --- | --- |
| mapbox-gl (+css) | 1263 | the 3D button |
| maptiler-sdk (+leaflet plugin) | 1137 | four of the eighteen base maps |
| aerisweather.mapsgl (+css) | 826 | MapsGL products |
| turf | 590 | storm projections and the area tools |
| firebase ×3 | 399 | the outlook panels |
| proj4 | 89 | the OPERA grid |
| esri-leaflet | 67 | one product |
| leaflet-draw (+css) | 71 | the drawing tool |
| Leaflet.VectorGrid | 40 | `pbf` products |
| togeojson | 18 | KML import |
| leaflet.heat | 5 | the strike heatmap |

`core/deps.js` fetches each of these at the point of use and caches the promise,
so the cost is paid once, by whoever needs it, and never by someone who does not.
Only Leaflet stays in the shell, because the map is the first thing drawn.

| | before | after |
| --- | --- | --- |
| third-party assets at boot | 22, **4675 KB** | 3, **168 KB** |
| DOM content loaded | 1150–1454 ms | **594–798 ms** |
| shell ready | 1224–1540 ms | **658–881 ms** |

**A deferred library must be awaited where it is used, not checked for.** The
outlook panel opened with `if (typeof firebase === 'undefined')` and reported
"Firebase did not load" — which had been true zero times before and was true
every time afterwards. Each section awaits the SDK itself and reports honestly if
it never arrives.

**One library is warmed deliberately.** Deferring everything makes the first
paint fast and moves the wait to the first click. The storage SDK is pre-paid
during an idle callback after boot, because outlooks are the point of this
application; it is off the critical path, so nobody waits for it. The outlook
panel populates in about 1.3 s.

### It does not get slower the longer it runs

`tools/soak.mjs` drives fourteen rounds of scrubbing and layer toggling, sampling
the same counters each round, because "getting slower" and "slow to load" want
opposite fixes and only measurement separates them.

```
round  1  scrub  776ms  heap 118.1MB  nodes 1440  listeners  688  canvases 36  imgs 47
round 14  scrub  420ms  heap 155.7MB  nodes 2753  listeners 1176  canvases 36  imgs 47
```

Scrub cost is flat — round one is warm-up. Canvases, images and pane children are
exactly flat, and heap, nodes and listeners oscillate rather than climb, which is
collection rather than accumulation. The problem was never runtime drift.


## Surface observations

Live station models — the classic plot: a sky-cover circle with a wind barb,
temperature above-left, dew point below-left, sea-level pressure coded to three
digits above-right, station identifier below-right. Six variables in something
the eye reads at a glance, which is why the notation has outlived every attempt
to replace it.

`layers/synoptic.js` draws them; `ui/panels.js` has the Station observations tab.

**Three networks, not all of them.** Synoptic carries about 35,000 active
stations over the continental US alone — every mesonet, road sensor and hobby
gauge — and asking for all of them costs 16 MB a refresh. ASOS/AWOS (1), Global
METAR (239) and the WMO synoptic feed (284) are the ones reporting a full station
model on a regular cycle: roughly 13,000 worldwide, and a continental view under
2 MB. That is the difference between a layer that can auto-update and one that
cannot.

| request | stations | payload |
| --- | --- | --- |
| CONUS, all networks | 35,691 | 16.5 MB |
| CONUS, these three | 2,399 | 1.8 MB |
| 30°×20° window | 886 | 0.7 MB |

`fields` trims the metadata, which halves what is left; none of it is drawn.

**Bounded by window, not by radius.** The service caps `radius` at 300 miles and
refuses a whole-world `bbox`, so the request is the viewport clamped to 46°×30°
about its centre. Past that the plots would be unreadably dense anyway, and the
panel says "zoom in for full coverage" rather than quietly showing less.

**Drawn on a canvas, thinned on a grid.** A station model is a dozen strokes and
a busy view holds several hundred — as markers that is thousands of DOM nodes
rebuilt on every pan. Thinning keeps one plot per cell of a screen-space grid
rather than comparing every pair, which is quadratic and shows up as a stutter
while panning. A regional view holds about 1,100 stations and plots 280 of them.

**It refreshes itself** every five minutes by default, and re-requests when the
view moves somewhere the cached window does not cover. It registers as an
ordinary overlay, so it appears in the layer list, can be restacked and reaches
the 3D view — and it starts at the top of the stack, because a station model is
read rather than looked at and anything drawn over one is a number you cannot
take.


## The MapsGL catalogue

The original file used nine MapsGL products. The SDK offers far more, and
`data/mapsglLayers.js` declares the rest — **211 in total** across ten groups.

| group | products |
| --- | --- |
| roadWeather | 80 |
| observation | 69 |
| warning | 17 |
| lightning | 16 |
| wind | 9 |
| nowcast | 9 |
| satellite | 5 |
| isobar | 3 |
| tropicalStorms | 2 |
| radar | 1 |

**The list was verified against the SDK, not copied from the documentation.**
`tools/probe-mapsgl-supported.mjs` calls `addWeatherLayer` for every candidate id
and records what the controller accepts: 210 of 215 documented ids, the five
rejections being names that turned out not to exist. Acceptance means the SDK
holds a configuration for that layer — whether the account is entitled to the
data is a separate question, and one the renderer already fails softly on.

**Declared by hand, merged into the generated catalog.** `data/layers.js` is
extracted from the original file, so anything added there would be lost on the
next regeneration. `mergeMapsGLLayers` runs at load, before the order table is
derived, and the generator emits the call — so regenerating cannot drop them.
Existing entries win: the nine products carried over from the original keep their
own keys and labels, because changing those would change what a saved session
restores. Duplicates are matched on the MapsGL id rather than the catalog key.

**Labels are derived, not typed.** Two hundred hand-written strings is two
hundred chances to leave a typo somewhere nobody looks. `humanise()` splits the
id, peels trailing qualifiers into a parenthetical (`-accum-text` becomes
"(accumulation, text)"), and applies a table of the genuinely irregular parts —
`pm2p5` to PM2.5, `msl` to Mean Sea Level, `vpd` to Vapour Pressure Deficit.
Road weather also carries a forecast marker and a region, so
`froad-weather-risk-low-viz-fog-europe` reads as
"Road Forecast · Low Visibility Fog Risk — Europe".
`tools/test-mapsgl-catalog.mjs` asserts no two products share a label and none
falls back to a raw id, which is how a broken rule would show up.

**Road weather has its own group.** Eight risk types across five regions, current
and extended forecast, is eighty entries; dropped into observations they would
bury the surface fields already there. The group has its own pane at z-index 165
and appears under the Observations panel alongside them.


54. **A render-on-demand WMS was asked for every position of a drag.** EUMETSAT
    generates each frame on request — a warm tile in 0.3 s, a cold one in
    seconds — so dragging across a hundred scrubber positions asked GeoServer
    for a hundred frames, every one superseded before it arrived, with the frame
    the user actually stopped on queued behind all of them. Kinds in
    `SLOW_TO_RENDER` now defer while `runtime.scrubbing` is set and the release
    flushes them: measured at **0 requests during a fourteen-position drag** and
    25 on release.

55. **Station models were drawn under the satellite they were stacked above.**
    `synopticPane` was a top-level pane, a sibling of `overlayPane`, but the
    layer list assigns z-indexes from the weather stack's range — so it was
    handed 200 while `overlayPane`, holding the satellite, sits at 400. A
    z-index only orders against its own siblings, so the pane the list said was
    on top was underneath everything. It now lives inside `overlayPane` with the
    layers it is ordered against.

56. **One slow layer set the frame rate for all of them.** Playback waits for
    each frame to reach the screen before asking for the next, which is what
    makes speed a ceiling rather than a demand — but it waits for *every* layer,
    so a render-on-demand WMS gated the radar it was sitting on top of. With
    EUMETSAT enabled: **3 radar frames in 14 s, an eight-second gap**. Without
    it: 39 frames at a third of a second.

    Slow kinds now hold their current frame while the timeline is moving —
    during playback as well as during a drag — and catch up when it stops. With
    EUMETSAT enabled that is **41 frames at 327 ms**, indistinguishable from
    having it switched off.

    **The first attempt made it worse, not better.** Marking the deferred layer
    by setting `pending` looked natural — it does mean "there is a render still
    owed" — but `pending` is exactly what the playback pacer waits on, so every
    frame then waited for a layer that had deliberately opted out of it and
    playback stopped dead: 0 frames in 14 s. Deferral is tracked in its own set.

57. **Station models grew with the camera pitch in 3D.** The plot is drawn at a
    fixed pixel size onto the hidden 2D map, and that image is stretched over the
    GL scene by however much lower a zoom it was captured at — and a pitched
    camera sees far more than a flat view holds at the same scale, so the
    composite drops a zoom level for every step of tilt.

    | pitch | capture zoom | symbol size before | after |
    | --- | --- | --- | --- |
    | 0–30° | 7 | 1.0× | 1.0× |
    | 45° | 6 | **2.0×** | 1.0× |
    | 60° | 5 | **4.0×** | 1.0× |
    | 70° | 4 | **8.0×** | 1.0× |

    `mirrorMagnification()` reports the stretch and the plot divides by it, so
    every dimension — circle, barb, glyph sizes, offsets and the thinning grid —
    is drawn correspondingly smaller and lands the right size on screen.


58. **Station models ignored the timeline.** They were fetched from the
    `latest` endpoint, which is exactly what it says, so they were the one layer
    that did not move with the scrubber. Away from the live edge the request now
    goes to `nearesttime` with the moment being shown, bucketed to ten minutes so
    a nudge costs nothing, and the drag deferral applies here too — the release
    asks once.

    Staleness had to move with it. `maxAgeMinutes` was measured against *now*,
    which discarded every historical report the instant the scrubber left live:
    473 stations held, none drawn. It is measured against the moment being shown,
    with the same tolerance either side, because a nearest-time lookup can
    legitimately return a report a little after the time asked for.

59. **A test that could not fail.** The scrub-deferral check counted requests to
    the WMS, which measured two wrong things: the tile layer retries a failed
    frame on a multi-second backoff, so a drag starting soon after a load sees
    dozens of requests that predate it, and a probe for a frame carries the same
    `TIME` as a tile for it. Rewritten to watch the frame the layer holds, it
    passed with the deferral disabled — because `renderAll` already drops a
    request while one is in flight, and a slow WMS is always in flight during a
    drag. The drag case was covered before the change; **playback** was not, and
    that is what the test asserts now: 3 radar frames in 14 s against 39 before,
    39 against 35 after.

60. **A dead product failed the suite.** `test-layers` asserted that the *first*
    listed wind product renders, as a guard against the wind group being empty —
    which it once was. `wind-dir-dk` now answers 400 for every timestamp, so the
    guard fired for a reason it was not built to detect. It tries several
    products and passes if any of them draws.

## The high-resolution satellite composite

`layers/windySat.js`, decoded in the same worker pool as the radar composite.
Three products come off one source: the visible/infrared composite, and each
channel on its own.

The source is not a picture. One 256×512 PNG serves each 256×256 map tile, and
its pixels look like structured noise under a checkerboard until two things are
undone.

**Alternate 16px blocks are stored inverted.** The giveaway was a low-zoom tile
whose western half was empty: the void rendered as pure black squares against
pure white ones, which are the two ways a single value can appear if half the
blocks carry `255 - v`. Undoing it turns the noise into cloud.

**The two halves are two channels, not two rows.** The lower half of a tile
compared against the upper half of its southern neighbour gave a mean difference
of 42.8, where an identical region scores 0 and an unrelated one 84.9. They are
the visible and infrared views of the same ground, as `visir` says: visible on
top (mean neighbour difference 10.5, the sharper picture), infrared below (3.2).

**The two halves do not share a parity.** This is the part that was got wrong
first, and it shipped a visible channel that was a photographic negative —
daylight cloud black, ocean white. Nothing local catches it: the two candidate
decodes are exact negatives of one another, so every measure of smoothness is
identical and every seam between tiles joins equally well either way. Tile-seam
continuity was tested first and answered "consistent" for both, which is true and
useless. It takes ground truth. Over the Atlantic coast of the western Sahara the
desert is the brightest thing a visible channel sees and the open ocean nearly
the darkest, while in the infrared the baking sand is darkest and the cold cloud
tops brightest; only one assignment puts both the right way up, and it puts the
inverted blocks on opposite parities in the two halves.

An earlier round of the same measurement pointed at a Sahara tile and a South
Atlantic tile that disagreed, which looked like the parity varying per tile. It
does not — that was one correct reading and one taken over a tile the sun had
almost left. `tools/test-windy-sat.mjs` keeps both halves of the finding: the
rule as a deterministic check against a synthetic image, and the desert against
the sea as the check that says which way up.

**Night is handled by arithmetic, not by the imagery.** The visible channel is a
photograph and carries nothing on the unlit side, so the composite blends the two
by solar elevation — visible where the sun is more than 10° up, infrared where it
is down, faded across the terminator. Deciding that from the pixels would not
work: a fully lit cumulonimbus top and an unlit ocean are both flat fields.
`layers/solar.js` computes the sun's position once per frame and the elevation is
sampled on a 17×17 grid per tile, which the worker interpolates — it varies
smoothly enough over 256px that this is exact to far better than a pixel. A tile
entirely in the dark skips the blend and takes infrared outright.

Native tiles stop at zoom 7, where the provider answers 400 rather than 404;
deeper zooms crop and scale the z7 parent, as the radar composite does. No
credentials are needed — `mosaic=true` and a `maxt` bound are enough — so none
are embedded for it.

**Old frames come from a second endpoint, at a coarser cadence.** The live path
carries ten-minute frames for roughly the last sixteen hours — measured 200 at
fourteen hours old and 404 at fifteen and a half, with the boundary close enough
to midnight UTC that one afternoon's samples cannot separate a rolling window
from a since-midnight rule. Past that, `/satellite/archive/composite/` serves
frames going back at least thirty days.

The archive is **hourly only**, and that is the part worth knowing. An early
reading of it concluded it held nothing older than a day, because the probe asked
for the same ten-minute stamps the live endpoint uses and five requests in six
were for frames that were never written. `toArchiveUrl` therefore does two
things at once: it inserts the `archive` segment and snaps the frame down to the
hour, moving the `maxt` bound with it. The layer tries live first unless the
frame is already known to be too old, falls back to the archive, and remembers
where the boundary was so later frames skip the wasted request — the same
learned-cutoff arrangement the radar composite uses, kept separate because the
two products differ in window, in path and in whether the fallback re-buckets the
time. Snapping moves the sun by up to half an hour, under four degrees, which is
well inside the ten-degree band the day/night blend fades across.

Scrubbing thirty hours back requests the archive for every tile, gets 200 for
every one, and paints; `tools/shot-sat-archive.mjs` drives that.

**3D takes the decoded canvas.** `isCanvasBacked` recognises the class the layer
is constructed with, so GL mirrors what the workers drew rather than fetching the
source tiles itself and drawing the checkerboard raw.

## The station card

Clicking a station model opens the current observation in full plus a day of
history. `ui/stationPopup.js`.

**One chart at a time, chosen from a picker.** Temperature, pressure, wind, rain
and snow share nothing but a time axis. One plot would need five value scales,
and a chart with two y-axes is the most reliable way to make unrelated series
look related. Stacking five panels is honest but turns the card into a page
nobody scrolls to the end of, so a picker names them and shows one — which also
buys the visible chart enough height to read. Only the charts a station actually
reports are offered: most airfields send no snow and many send no rain, and an
empty axis is worse than a shorter menu.

**A time axis on every chart**, aligned to round local hours rather than to the
first reading, because an axis reading 06:00 09:00 12:00 is a clock and one
reading 06:47 09:47 12:47 is a puzzle.

**Wind direction as arrows, not a second line.** A bearing plotted against a
speed axis is the dual-axis mistake wearing a disguise — and it wraps at 360°, so
a westerly veering by ten degrees would draw a full-height cliff. It becomes a
row of arrows under the plot instead, flying the way the air is going, sharing
the same time axis, and it still reports itself to the crosshair and the table.

**Rainfall as bars, accumulation as a line.** Rain in an hour is a magnitude per
interval, which is what bars are for; the running total is a level, which is what
a line is for. Both come from the hourly reports, and the subtlety is that a
station reporting every twenty minutes repeats the same hourly figure three
times — summing the samples would treble the rainfall. The largest reading in
each clock hour is taken, so each hour is counted once. Snow is handled the same
way, and snow depth is a state rather than an accumulation, so it gets its own
line.

**Celsius and mph**, with precipitation in millimetres, requested from the
service rather than converted here.

**Colour by meaning, and validated.** Two series per panel from the categorical
pair, with the warm hue on the warm variable in every panel — temperature over
dew point, gust over mean wind. Run through the palette validator against both
surfaces, all pairs: worst CVD ΔE 26.8 dark / 24.7 light, worst normal-vision
ΔE 31.8 / 33.6, both above 3:1 contrast. A legend where there is more than one
series; a single-series panel has none, because its title already names it.
Values wear text tokens, never the series colour. A table view carries every
reading without hovering.

**Gaps break the line.** A missing report is not a straight-line hour of weather,
so the path restarts rather than bridging.

**The card opens in both views.** In 3D the plots arrive as a captured picture
with nothing to hit-test and Leaflet never sees the click, so the GL map's own
click is resolved against projected station positions — only the stations that
survived thinning, because a card for a plot nobody can see is a magic trick.
The card itself is the same DOM either way; only the popup around it differs.
Mapbox does not pan for its own popups, so the camera is nudged once the card
fills out.

61. **Pressure is spelled out in hectopascals.** The station model traditionally
    codes sea-level pressure to three digits — 1013.2 hPa as `132` — which saves
    two characters and costs anyone who has not met the convention any chance of
    reading it.

62. **Two chart series were drawn as a single dot.** Synoptic returns both a
    measured series and a derived one, and preferring `_set_1` outright looked
    obviously right. Plenty of stations carry that key with almost every entry
    null and put the real readings in `_set_1d`: dew point and pressure both came
    out empty at KPHL, giving a panel with no line and one end marker. Whichever
    series actually has readings is used.

63. **The card opened, then pushed its own header off the map.** It opens small —
    one line of loading text — so the popup positions itself against that, then
    grows by four hundred pixels when the history lands, and Leaflet does not
    re-pan. The card signals when it is complete and the popup re-measures; the
    pending state also reserves roughly the height the charts will need, so the
    jump is small. Measured: popup top went from y=10 (under the top bar) to y=71.

    This was nearly missed. The first screenshots looked like the header was
    clipped, and the clip was `boundingBox().y - 12`, which clamps to zero and
    shaves the top — so the artefact and the real fault looked identical. The
    geometry had to be printed to tell them apart.

64. **Resetting the layer order deleted layers from the list.** Not from the
    map — which is what made it puzzling to look at: the rows for the station
    models, the outlooks and anything drawn simply stopped being listed, while
    everything carried on being drawn exactly as before.

    `order` holds catalog groups and registered overlays in one list, but the
    default it was reset to, `LAYER_GROUPS`, is only the catalog groups.
    Assigning it wholesale dropped every overlay out of the ordering, and
    `activeInOrder` reads `order`, so they left the list. Nothing had touched
    the layers themselves, hence the map not changing. They are re-seated at
    their presets now, and the record of what the user had positioned by hand is
    cleared, since that is what a reset means.

    Reproduced before fixing: with the old code the run lost "Surface
    observations" and "Manual outlook" and `layerOrder()` fell to
    `["radar","satellite"]`, while the map check still passed.
    `tools/test-layer-reset.mjs`.

## Live global strikes

`layers/windyLightning.js`. The catalog has carried this product since the
rewrite and it never drew anything, in either view. Two endpoints for it sat in
`config.js` unread by any module, and `kind: 'windy-lightning'` was routed to
the Xweather renderer, which has no case for it — so selecting it was a silent
no-op.

**Two endpoints, two formats.** The live one returns JSON: a rolling window of
roughly the last seven minutes worldwide, refreshed continuously, polled every 30
seconds for the minutes since the last archive frame was published. The frame
endpoint wants a five-minute timestamp in its path — without one it answers 404,
which is what made it look dead at first.

**The coordinates took working out.** Each strike is four integers with no
projection stated: centiseconds, then two values on an 18-bit grid, then a flag.
Four readings are possible — linear or Mercator latitude, either sign convention
— and they are separated by where they put the lightning, not by anything in the
data:

| reading | where the strikes land |
|---|---|
| Web Mercator, either sign | 33% poleward of 55°, which does not happen |
| linear, north-origin | the Southern Ocean and the empty South Pacific |
| **linear, south-origin** | the Mediterranean, Sumatra, the Gulf coast, Texas |

The last is a textbook global distribution for the hour it was sampled — 0.4%
poleward of 55°, afternoon convection over the Americas, the maritime continent
overnight. Rendered over the satellite composite it agrees with an entirely
independent dataset: the dense Sahel cluster sits exactly on the bright
convective cloud, which is the check no amount of arithmetic gives you.

The fourth integer is not age. Its classes average about five minutes old
regardless of value, so it is left alone.

**Archive frames, and how the format was got.** Five-minute frames go back 24
hours — served at 24 h old, empty by 26 — which is exactly what the product's
name always claimed. They are binary, and the bytes did not give the format up:
fixed bit-fields at every offset and width from 16 to 20 bits, both byte orders,
both axis assignments and all four latitude conventions scored at chance, as did
cumulative delta decoding. The result that mattered was negative — no byte's
histogram correlated with the real distribution of lightning (max |r| = 0.35),
and the high byte of a packed coordinate has to. That ruled out the whole family
of layouts a search could reach, so the answer came from the provider's client
instead: their radar view loads a script that carries the parser, and reading it
took ten minutes where the analysis had taken an afternoon.

A record is six bytes, occasionally eight:

| bytes | meaning |
|---|---|
| 0–1 | x, big-endian, low 16 bits |
| 2–3 | y, big-endian, low 16 bits |
| 4 | bits 7–6 are x's high bits, 5–4 are y's, 3–0 the intensity |
| 5 | time since the previous strike, in centiseconds |

The two high bits of each coordinate sharing a fifth byte is what defeated every
contiguous-field search. A time byte of 255 is an escape: elapsed time is then
absolute, read as a big-endian pair from bytes 6–7, and that record is eight
bytes long. Frames without an escape divide evenly by six, which is what made
fixed-length records look certain. Coordinates are the same 18-bit grid and the
same linear latitude the live feed uses — so the projection worked out from where
the strikes fell was right all along; only the layout was wrong.

Verified against the live feed over the same five minutes: **1960 of its 2212
strikes appear in the archive frame at identical coordinates**, and 92.6% of the
frame lands in cells the live feed also has.

**Every strike is drawn.** A day of global lightning is about 1.66 million of
them, and the first version sampled that down to 60,000 because assembling the
list at all locked the page. Sampling was the wrong answer; four changes make the
whole set cheap enough that none is needed.

*Typed arrays, not objects.* 1.66 million strike objects is a couple of hundred
megabytes and a garbage collector under permanent load. Three typed arrays —
Float32 x, Float32 y, Uint32 milliseconds-into-the-frame — is sixteen megabytes
and nothing to collect.

*The projection is stored, not computed.* Web Mercator costs a logarithm and a
tangent per point, and doing that 1.66 million times a frame is most of a second.
Positions are projected once, when the strike arrives, so a frame costs one
multiply and one subtract each. The provider's own client stores its strikes the
same way, which is a fair sign it is the right shape rather than a clever idea.
The inlined projection is checked against Leaflet's own every run: worst
disagreement 0.43 px.

*Colour is a run, not a lookup.* Strikes are in time order and the age ramp is a
set of time bands, so each band is a contiguous run — two binary searches per
band per frame replace a comparison chain per strike, and the inner loop draws
one colour with no branching in it.

*Dense views splat pixels.* Above 24,000 strikes on screen the crosses overlap
into solid colour anyway, so each strike becomes a direct write into an
`ImageData` buffer instead of four canvas path operations. Not a cap — every
strike in view is still drawn, and below that threshold they are still crosses.

There is no counting pass to decide between the two modes: the previous frame's
count decides, because it is the same view a sixtieth of a second earlier and
being one frame late to switch is invisible, where walking 1.66 million entries
twice is not.

Measured on a full day at world zoom: **1,657,257 strikes drawn in 45 ms**, down
from 154 ms before the runs and the dropped counting pass. A regional view of the
same set is 50 ms, most of which is culling the off-screen 99%; a spatial index
would fix that if it ever matters. Idle, the layer renders zero times in four
seconds — there is no redraw loop.


**Past the provider's 24 hours.** There is nowhere to ask for more: a frame 24
hours old is served in full, one 25 hours old returns 204, and every hour beyond
stays empty. Their client has no other endpoint and skips lightning entirely in
archive mode. What there is instead is everything already fetched — frames are
immutable once published, so `layers/strikeStore.js` keeps each one that passes
through in IndexedDB and the layer asks the store before the network. History
reaches back 24 hours on a first run and grows from there, up to seven days or
200 MB, oldest dropped first. The raw bytes are stored rather than the parsed
arrays: 40 KB against 80 KB a frame, and re-parsing costs about a millisecond.
Where IndexedDB is unavailable — a private window, storage switched off — every
call is a no-op and the layer simply has the provider's day.

**Dots, not crosses.** The global field is an order of magnitude denser than the
in-house one, and crosses at that density read as texture rather than as
individual strikes. Set per layer, so the two sources differ.

**Each group has a pane of its own.** Five of them — wind, nowcast, tropical
storms, rotation and lightning — had none and fell through to `overlayPane`.
That is Leaflet's own container for every other pane, so they drew into one
another and could not be ordered against each other at all. Worse, restacking
one set a z-index on the container, which moves the entire weather stack rather
than the one layer. `tools/test-lightning-stack.mjs` holds both ends of that: the
layer's own pane changes, and the container's does not.

**Drawn through the existing strike canvas.** Reusing `StrikeCanvasLayer` rather
than writing a second renderer is what makes these look like strikes: the same
age colouring, lifespan, decimation ceiling and arrival flash. 3D takes the
canvas the same way the OPERA composite does — the layer is drawn, not fetched,
so there is no URL for GL to load and only the pixels exist. It re-captures on
every repaint, because polling repaints between renders and a mirrored still
would otherwise sit stale for as long as the view did.

## Known limitations

- **Auto HOCO geometry fails from an unlisted origin.** The Cloud Storage bucket
  allows CORS only for the deployed origin, so `localhost` and `file://` get
  `Failed to fetch` when loading a run's GeoJSON. This matches the original's
  behaviour (it also used `mode: 'cors'`); the panel degrades to a message rather
  than breaking. Add the origin to the bucket's CORS config to test locally.
- `uk-nw-precip-intensity` references `${isoNw1}` / `${isoNw2}` tokens for which
  the original never implemented substitution, so the layer could not resolve. It
  is carried over as an unlisted definition; adding the two formatters to
  `layers/urlTemplate.js` would revive it.
- The Foreca products embed a JWT with an expiry; it will need refreshing.
- 3D mode creates the Mapbox GL context and shares the viewport, but layer parity
  with 2D is limited to what the original supported.
- Credentials are still embedded client-side, exactly as before. Anything served
  publicly exposes them; moving the Xweather and Mapbox keys behind a proxy would
  be the next real hardening step.
