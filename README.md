# North Wildwood Floodmapper 2.1

## Compact physics response atlas

The live dashboard preserves its existing pull-one-PNG browser contract. It
does not run a new hydraulic simulation for every tide. Instead, it chooses one
of seven precomputed history families from the scalar hydrograph, floors the
level to a 0.1-foot NAVD88 stage, and downloads one depth or stage PNG.

The v26 atlas underneath that unchanged browser behavior is a mass-conserving
subgrid finite-volume model. It applies time, storage, one-foot interface
width, distance, water-surface gradient, Manning friction, wetting/drying, and
a free-overflow capacity limit. A connected depression is no longer promoted
instantaneously to the tide elevation.

The two complete four-neighbour tidal fields at or below **2.0 ft NAVD88**,
including valid DEM pockets wholly enclosed by those fields, are an internal
fixed-head forcing boundary. They are never painted as flood impact. A
component must contain at least one acre and either
touch the exterior DEM boundary or intersect a supplied tidal marker. Markers
qualify the complete DEM component but never paint their own circles or shapes.
Exterior routed volume is exactly zero at 2.0 ft. Above 2.0 ft, water can leave
the full source perimeter only through measured
one-foot source–terrain faces and only for the time represented by the selected
history family. On recession, previously routed water can drain back toward a
lower boundary.

This repository is the complete North Wildwood counterpart to Stone Harbor
Floodmapper 2.0. It uses the Great Channel at Stone Harbor gauge as the live and
historical water-level forcing source, then applies North Wildwood's datum
conversion, flood thresholds, terrain, DEM-integrated bulkheads, parcels, and
a phase-aware finite-volume overland-flow model.

## Water-level contract

| Category | NAVD88 | MLLW |
| --- | ---: | ---: |
| Minor | 3.25 ft | 6.00 ft |
| Moderate | 4.25 ft | 7.00 ft |
| Major | 5.25 ft | 8.00 ft |

`NAVD88 = MLLW - 2.75 ft`. Forecast and observed water levels come from the
Stone Harbor gauge. Hurricane Sandy's Stone Harbor gauge outage is filled only
for event replay with NOAA Lewes verified tide shape, time-aligned and scaled
to the official 6.73 ft NAVD88 / 9.48 ft MLLW crest. Winter Storm Jonas is
calibrated to the documented North Wildwood crest of 6.69 ft NAVD88 / 9.44 ft
MLLW while preserving the Stone Harbor 15-minute tide shape. Both events expose
complete 15-minute replays and derived hourly values.

## Return-interval storms

The **Return Intervals** data source supplies synthetic 24-hour storms at every
2015 NACCS station 11283 annual recurrence interval through 10,000 years. All
frequency calculations are performed in feet NAVD88; MLLW is only a display
conversion using the mapper's existing `+2.75 ft` contract.

| Return interval | NACCS 11283 | Stone Harbor USGS fit | Mapper target | Target method |
| ---: | ---: | ---: | ---: | :--- |
| 1 year | 4.2165 ft | 4.3793 ft | 4.3250 ft | 2:1 USGS-weighted blend |
| 2 years | 5.4460 ft | 4.8525 ft | 5.0503 ft | 2:1 USGS-weighted blend |
| 5 years | 6.6425 ft | 5.3869 ft | 5.8054 ft | 2:1 USGS-weighted blend |
| 10 years | 7.3436 ft | 5.7320 ft | 6.2692 ft | 2:1 USGS-weighted blend |
| 20 years | 8.0468 ft | 6.0331 ft | 6.7043 ft | 2:1 USGS-weighted blend |
| 50 years | 9.5326 ft | 6.3731 ft | 7.4263 ft | 2:1 USGS-weighted blend |
| 100 years | 10.7608 ft | 6.5927 ft | 7.9821 ft | 2:1 USGS-weighted blend |
| 200 years | 11.9254 ft | — | 11.9254 ft | NACCS only |
| 500 years | 13.4856 ft | — | 13.4856 ft | NACCS only |
| 1,000 years | 14.7033 ft | — | 14.7033 ft | NACCS only |
| 2,000 years | 15.9218 ft | — | 15.9218 ft | NACCS only |
| 5,000 years | 17.5026 ft | — | 17.5026 ft | NACCS only |
| 10,000 years | 18.6306 ft | — | 18.6306 ft | NACCS only |

The Stone Harbor estimate is a GEV distribution fitted by L-moments to one
maximum per available complete water year from USGS site `01411360`. The
combined crest-stage and continuous record contains 60 water years from
1965–2025; water year 1981 is unavailable. The fit uses the point-process
return-level convention `F = exp(-1/T)`, which gives a finite one-year level.
The raw 6.22-ft NAVD88 USGS Jonas crest is used in this statistical series,
not the mapper's separate 6.69-ft North Wildwood replay calibration.

The 1–100-year targets use two parts local USGS gauge history to one part
NACCS. The 200–10,000-year targets use the published NACCS station values
directly. NOAA station
`8535581` Stone Harbor harmonic predictions provide the astronomical tide. The
user-supplied asymmetric Cape May surge-ratio curve is digitized,
shape-preserving interpolated, compressed from its pictured 100-hour axis to
24 hours, and scaled so the selected target occurs at the first high tide
in the window. The resulting series contains 97
15-minute frames and retains the sharp central peak, post-peak shoulder, and
long recession tail in the supplied profile.

The planning flood-depth catalog still extends through 22.00 ft NAVD88. The
history-aware operational catalog covers 0.0–10.0 ft under the retained
`assets/hydraulic-v20/` public fallback path; that directory name is kept to
avoid a second large GitHub deployment copy, while its manifest identifies the
v26 render contract, the v14 asset schema, and the v13 hydraulic-state schema. The
operational atlas still
contains only 1,414 PNGs; it does not enumerate tide-cycle permutations.
Levels above 10 ft retain the volume-routed v19 PNGs as a planning-only
fallback. No equilibrium/bathtub images are used.

These are stationary screening scenarios: no future sea-level-rise increment
or trend detrending is applied. Rebuild the committed payload from the official
NACCS, USGS, and NOAA endpoints with:

```bash
python3 tools/build_return_intervals.py
python3 tools/test_return_intervals.py
```

## One-foot hydraulic model

The source DEM is resampled bilinearly to a one-foot grid in EPSG:6527, with
vertical units in NAVD88 feet. The model then:

1. Rasterizes the user-drawn bulkhead centerline with GDAL, expands it ten
   one-foot cells on both sides (21 cells nominal width), and stitches that
   wall into a new DEM at 7.5 ft NAVD88 before graph construction.
2. Uses four-neighbour components at or below 2.0 ft NAVD88 to build the source
   footprint. A component qualifies only when it contains at least 43,560 cells
   (one acre) and either touches the exterior DEM boundary or intersects a
   supplied tidal marker; corner-only contact does not count. Every cell in the
   two qualified components becomes fixed-head source. Valid higher DEM pockets
   enclosed by those components remain finite-storage terrain in the hydraulic
   graph, but are filled in the public source-field image so raster artifacts do
   not appear as offshore circles or triangles. The exterior-connected city
   landmass remains terrain. The polygons mark whole tidal components but have
   no hydraulic-shape or display role.
3. Groups the one-foot terrain into 10-foot finite-volume nodes while retaining
   the exact one-foot elevation histogram and the shared one-foot flow width at
   every edge. Boundary cells are placed in separate fixed-head nodes, so a
   source and interior terrain can never share a storage node. Each complete
   source component is represented by one fixed-head node, while every
   one-foot perimeter face is retained. Storm drains are disabled: they are
   neither connectivity seeds nor underground exchange paths.
4. Uses 2.0 ft NAVD88 to define source geometry, not an invented activation
   sill. The fixed-head field follows the tide continuously; both inflow and
   recession cross the actual one-foot shared-face crests.
5. Routes ordinary terrain flow with a Manning diffusive-wave face flux in
   60-second substeps. True dry/free overflow is capped by broad-crested-weir
   capacity. Every transfer is capped by donor storage, receiver capacity, and
   the two-basin equalization volume. A cell first wetted in one substep cannot
   donate until the next substep.
6. Builds seven history families: rising at 0.55, 0.79, and 0.90 ft/hour; a
   15-minute crest hold; and continuous recessions from absolute 4.0, 5.5, and
   8.5 ft NAVD88 crests. The rise rates are the lower, median, and upper
   representative rates measured across 940 observed high tides. An entire
   rising limb uses one stable rate family. Falling frames use the nearest
   preceding absolute crest, eliminating v19's moving `stage + 2.5 ft` history
   and its one-foot band resets.
7. Matches Stone Harbor's source-field contract: from 2.0 ft upward, every
   qualified source cell is visible boundary water. Enclosed raster artifacts
   are filled for display only. Beyond that immutable field, every five-foot
   output pixel area-aggregates only finite-storage terrain that actually
   received routed volume and encodes fractional wet coverage in alpha. Low
   terrain that is merely equilibrium-connected remains transparent.

The operational solve produces 101 stages per family from 0.0–10.0 ft NAVD88
at 0.1-foot increments: 707 depth PNGs plus 707 stage-class PNGs. Forecast and
observed updates inspect the scalar hydrograph, choose a history family, floor
the level to the nearest 0.1-foot asset, and pull one PNG. They never rerun
hydraulics.

This is a compact physics response atlas, not an event-exact hydrodynamic
forecast. The hydraulic source is two tidal components containing 18,230,034
qualified one-foot cells. The continuous public source field also fills
1,326,836 enclosed display artifacts, without turning them into forcing. At
2.0 ft every five-foot display bin in that complete field is present; water
beyond it still requires finite perimeter routing. See
`tools/benchmark_north_wildwood_methods.py` and
`docs/north-wildwood-hydraulic-v26.md`.

The main builders are:

```bash
python3 tools/prepare_north_wildwood_hydraulic_features.py \
  --zip /path/to/north_wildwood_features_shp.zip \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --output /path/to/feature-inputs

g++ -O3 -std=c++17 \
  $(gdal-config --cflags) tools/north_wildwood_hydraulic_graph.cpp \
  $(gdal-config --libs) -o north_wildwood_hydraulic_graph

./north_wildwood_hydraulic_graph \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --source /path/to/source_blocks_1ft.tif \
  --hard /path/to/bulkheads_21cell_1ft.tif \
  --output /path/to/graph \
  --control-volume-size-ft 10 \
  --connection-bin-tenths-ft 20

python3 tools/simulate_north_wildwood_hydraulics.py \
  --graph /path/to/graph \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --output /path/to/assets

python3 tools/validate_north_wildwood_hydraulic_features.py \
  --graph /path/to/graph \
  --centerline /path/to/bulkheads_centerline_1ft.tif \
  --states /path/to/assets/COGs/North\ Wildwood/NorthWildwoodHydraulicStates.json.png

python3 tools/validate_north_wildwood_render_connectivity.py \
  --graph /path/to/graph \
  --assets /path/to/assets

python3 tools/build_north_wildwood_contact_sheets.py \
  --assets /path/to/assets \
  --output /path/to/contact-sheets
```

The feature validator fails if the centerline is not expanded by at least ten
cells in all four cardinal directions, any bulkhead cell is below 7.5 ft
NAVD88, any supplied bulkhead cell is mixed into a terrain node, any edge
crosses a bulkhead below 7.5 ft NAVD88, a storm-drain cell enters the graph, or
the history-family arrays do not differ, finite-volume conservation fails, or the
declared front-propagation rule is missing.

The feature-preparation step records the source ZIP hash, validates the
one-foot grid, and requires the expected 1 hard-structure feature, 6 ignored
drain points, 6 source polygons, 11,200 centerline pixels, and 254,212
manual-source pixels. It records the expanded wall pixel count and conditioned
DEM provenance in the generated manifest. In the current graph, 19,556,870
complete source-footprint pixels form exactly two fixed-head source nodes, with
no node containing both source and terrain. The complete source perimeter
retains 66,088 one-foot terrain exchange faces.

The renderer uses a cyan-to-navy depth key and leaves dry low terrain
transparent. Surface values are smoothed over roughly five feet only inside
the immutable finite-volume wet mask, so smoothing cannot create new water.
Four alpha levels represent subpixel wet coverage; all 25 one-foot subcells are
examined instead of choosing the center cell.
Falling-tide puddles may remain after their visible five-foot connection to the
source has dried. The render validator checks all 1,414 depth/stage PNGs,
requires matching masks, rejects the former green potential codes, and confirms
that the history catalogs differ. It measures the farthest new-water arrival
against the physical per-frame travel envelope; the v26 maximum is 32 five-foot
pixels (160 ft) against a 46-pixel (230-ft) limit. The largest connected
adjacent-stage terrain addition is 215 five-foot pixels.

## Clickable depth

`NorthWildwoodHydraulicQueryWGS84.cog.tif` is a six-band, one-foot COG carrying:

1. conditioned ground elevation;
2. hydraulic zone ID;
3. first equilibrium connection stage;
4. complete qualified <=2.0-ft tidal-source-footprint flag;
5. 21-cell, 7.5-foot bulkhead flag;
6. disabled storm-drain flag (always zero).

The history-aware state package is a gzip-compressed, two-byte centifeet audit
lookup. `NorthWildwoodHydraulicQuery5ft.png` carries conditioned elevation and
the legacy connection threshold, while `NorthWildwoodHydraulicZone5ft.png`
carries the 24-bit finite-volume zone ID. Both align pixel-for-pixel with the
displayed five-foot flood PNGs, so ordinary PNG downloads avoid fragile large
COG range requests. A click reads the family/stage node surface and reports only
its depth above the conditioned ground.

## Forecast and observed archives

- `.github/workflows/update-forecast.yml` retrieves hourly PETSS/NOAA guidance,
  applies the -2.75 ft offset, and assigns the matching static stage asset.
- `.github/workflows/update-observed.yml` maintains USGS site `01411360`,
  parameter `72279`, on exact 15-minute anchors plus the hourly calendar
  archive and official historic crest list. It also rebuilds lightweight daily
  indexes and source/year shards in `observed_archive/`, so the browser renders
  the calendar first and downloads only the selected year.
- `.github/workflows/update-lewes-archive.yml` maintains the verified pre-2007
  Lewes surrogate used only when the Stone Harbor continuous record does not
  exist.

The interface includes 15-minute, hourly, and daily playback; top-ten historic
tides; guided help; address lookup; map and GIF export; mobile controls; parcel
boundaries; House Alerts; and clickable depth.

To rebuild and verify the browser-optimized tide archive:

```bash
python3 tools/build_observed_archive_shards.py
python3 tools/test_observed_archive_shards.py
```

## Parcel House Alerts

`tools/build_parcel_alerts.py` uses the official NJ composite MOD-IV layer for
North Wildwood municipality `0507`. Each parcel uses the highest center of an
intersecting cell from the original five-foot DEM grid. The historical count
comes from independent Stone Harbor high-tide peaks separated by at least six
hours. A parcel is counted as flooded only when water depth is strictly greater
than 0.10 ft at that highest parcel cell; a depth equal to 0.10 ft is excluded.

The same Stone Harbor series is fitted from equally weighted monthly means and
rebased to January 1, 2026. The projection model includes that existing local
trend plus NOAA's 2022 Low, Intermediate Low, Intermediate, Intermediate High,
and High Cape May relative sea-level scenarios. Every NOAA median curve is
fitted quadratically and rebased to zero in 2026. A continuous Gaussian-kernel
exceedance CDF and two-sided 95% calendar-year block-bootstrap interval are
evaluated for every curve, year from 2026–2100, and 0.1-foot elevation step
from 0.0–14.0 ft NAVD88.

```bash
python3 tools/build_parcel_alerts.py \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --observed observed15min.json \
  --output /path/to/parcel-assets
```

To refresh only the projection file using a cached NOAA 2022 response:

```bash
python3 tools/build_parcel_alerts.py \
  --observed observed15min.json \
  --slr /path/to/slr_projections_2022.json \
  --output assets/parcel-history-v2 \
  --cdf-only \
  --refresh-existing-parcels
```

Parcel results are screening estimates, not surveys, insurance
determinations, legal boundaries, or structure-specific engineering analyses.

The Buildings switch repeats the exact Esri OSM vector-tile building geometry
from the basemap in a transparent foreground pane above the floodwater. A
building click or matched address opens the parcel prompt and loads the
projection dataset only after the user chooses **See Flood History And
Projections**. Initial startup similarly renders the forecast hour nearest the
current time first; observed archives, historical tides, boundary data, and
other secondary data warm in the background.

## Bunny layout

```text
DepthPNGs/North Wildwood/v26/<seven history families>/
StagePNGs/North Wildwood/v26/<seven history families>/
COGs/North Wildwood/v26/NorthWildwoodHydraulicQuery5ft.png
COGs/North Wildwood/v26/NorthWildwoodHydraulicZone5ft.png
COGs/North Wildwood/v26/NorthWildwoodHydraulicStates.json.png
Parcels/North Wildwood/
```

The dashboard tries the Bunny v26 family first and retains the bundled GitHub
copy as a fail-safe. The `.json.png` and `.geojson.png` transport aliases retain
their compressed binary, JSON, and GeoJSON bytes because this Bunny pull
zone's cross-origin allowlist is extension-based.
