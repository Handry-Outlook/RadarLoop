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
    worker.js              starts a worker from either build (module URL or Blob)
  data/
    layers.js              GENERATED — 186 weather product definitions
    sourceNames.js         keeps weather-provider names out of the interface
    palettes.js            GENERATED — 12 rainfall colour presets
    basemaps.js            base map catalog (built lazily)
  layers/
    renderer.js            double-buffered renderer for all 11 layer groups
    resolver.js            frame resolution, caching and learned publish lag
    urlTemplate.js         one time-token table for every provider URL format
    radarScale.js          shared mm/h colour scale + encoded-value LUT
    opera.js               OPERA binary grid, reprojected to canvas
    windy.js               Windy composite: recolouring + live/archive endpoints
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


## Known limitations

- **`windy-live-lightning` draws nothing, in either view.** The catalog lists
  "Live + past 24 hours Global Lightning" with its own kind, but no ingestion was
  ported for it, so selecting it is a no-op — a 2D gap that the 3D audit
  surfaced, not a 3D one. The original polled Windy's blitz service: a binary
  five-minute archive at `ims.windy.com/blitz/v3/5mins/<frameMs>` (no auth)
  alongside a `node.windy.com/blitz/v3/hot` poll carrying a JWT. Both still
  answer 200. Reviving it needs the binary decoder, the localStorage archive and
  the marker renderer porting; the rest of the strike machinery — age colouring,
  lifespan, the 3D circle layer — already exists and would be reused.

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
