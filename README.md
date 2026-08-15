# North Wildwood Floodmapper

## Phase-aware conditional connectivity

The dashboard keeps its later gauge archives, return-interval storms, exports,
mobile layout, and parcel tools, but its flood surface has been restored to the
new one-foot conditional-connectivity contract. It floors the selected water
level to a reusable 0.1-ft NAVD88 frame and selects a filling, slack, or
draining PNG; it does not run a new simulation in the browser.

This repository is the complete North Wildwood counterpart to the Stone Harbor
Floodmapper. It uses the Great Channel at Stone Harbor gauge as the live and
historical water-level forcing source, then applies North Wildwood's datum
conversion, flood thresholds, terrain, DEM-integrated bulkheads, parcels, and
a source-connected bathtub model.

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

The flood-depth catalog extends through 20.00 ft NAVD88, covering every
published NACCS station 11283 target in this set without a display cap.
The complete 0.00–20.00 ft catalog uses the established Bunny filename
convention (`NorthWildwoodDepthp0000.png` through
`NorthWildwoodDepthp2000.png`) under versioned v35 filling, three crest-release,
slack, and draining directories.

These are stationary screening scenarios: no future sea-level-rise increment
or trend detrending is applied. Rebuild the committed payload from the official
NACCS, USGS, and NOAA endpoints with:

```bash
python3 tools/build_return_intervals.py
python3 tools/test_return_intervals.py
```

## One-foot hydraulic model

The 2019 South Jersey five-foot LiDAR raster is resampled to a one-foot
computational grid in EPSG:6527 with bounded cubic convolution. Cubic values
are clipped to the finite extrema of their local 5x5 source neighborhood,
preserving curved terrain while preventing interpolation overshoot from
inventing pits or ridges. The one-foot spacing does not imply one-foot source
measurement accuracy. The model then:

1. Rasterizes the user-drawn bulkhead centerline with GDAL, expands it ten
   one-foot cells on both sides (21 cells nominal width), and stitches that
   wall into a new DEM at 7.5 ft NAVD88 before graph construction.
2. Finds every four-neighbour component whose unrounded conditioned DEM cells
   are at or below 2.00 ft NAVD88. Every component with at least 101 cells is a
   source block; hand-drawn polygons cannot add or remove source cells.
3. Computes each cell's minimum equilibrium connection stage through 20.0 ft.
   Storm drains are disabled in this model version: they are neither
   connectivity seeds nor underground exchange paths.
4. Marks a cell connected when its conditioned ground elevation and its exact
   four-neighbour source-connection threshold are both below the full selected
   gauge stage. A corner connection can never make a cell blue.
5. Applies a developed-land-only polynomial offset through the minor
   `(3.25, 0.75)`, moderate `(4.25, 0.25)`, and major `(5.25, 0.00)` NAVD88
   stage/penalty anchors. Connectivity is always evaluated at the full gauge
   stage; on filling frames the negative offset is applied only to local
   developed ground. This prevents one penalized route crest from suppressing
   an entire lower connected basin. During the final hour before a confirmed
   local crest, a transferable nearest-front rule releases 44%, 75%, and 94%
   of the penalty-held connected area, followed by 100% at slack/high tide.
   Shared-side travel distance from existing water controls the front; road
   corridor and lower ground break ties. This spreads a flat connected basin across the approaching high tide
   instead of exposing it in one frame. Terrain below the selected stage
   that has no qualified source connection is also green in every phase. On
   draining frames one quarter of that offset is positive, retaining already
   routed water to represent a shorter recession lag without adding inflow.
   The maximum draining hold is 0.1875 ft and the moderate-stage hold is
   0.0625 ft. The first confirmed falling 15-minute frame enters this reduced
   draining state immediately so the crest transition cannot flash green.
   The NJDEP 2015 `TYPE15 = URBAN` mask prevents
   either adjustment on marshes, beaches, water, forest, and agriculture.

The solve produces 201 stages from 0.0–20.0 ft NAVD88 at 0.1-foot intervals for
`filling`, `crest-release-44`, `crest-release-75`,
`crest-release-94`, `slack`, and `draining`. The three release families
advance the nearest connected front through 44%, 75%, and 94% of the
penalty-held area, using lower ground as the tie-breaker. Hourly and 15-minute
updates floor the selected level to the same stage catalog. Crest release is based on
elapsed time, not array position, so shared hourly and quarter-hour timestamps
select the same hydraulic state. Interpolated 15-minute rows derive phase from
their own neighboring stages rather than copying an hourly phase, so flooding
starts and ends at the same physical time. The visible frame and nearest
neighbors load first; farther frames warm sequentially during browser idle
time.

The main builders are:

```bash
python3 tools/resample_north_wildwood_dem_1ft.py \
  --input /path/to/North_Wildwood_2019_South_Jersey_5ft_NAVD88.tif \
  --output /path/to/NorthWildwoodDEM_1ft_NAVD88.tif

python3 tools/prepare_north_wildwood_hydraulic_features.py \
  --zip /path/to/north_wildwood_features_shp.zip \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --developed /path/to/NorthWildwoodNJDEPLandUse2015Urban.geojson \
  --output /path/to/feature-inputs

g++ -O3 -std=c++17 \
  $(gdal-config --cflags) tools/north_wildwood_hydraulic_graph.cpp \
  $(gdal-config --libs) -o north_wildwood_hydraulic_graph

./north_wildwood_hydraulic_graph \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --hard /path/to/bulkheads_21cell_1ft.tif \
  --developed /path/to/developed_urban_1ft.tif \
  --output /path/to/graph

python3 tools/prepare_north_wildwood_road_mask.py \
  --overpass model/data/reference/north_wildwood_osm_highways_20260815.json \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --output /path/to/graph/NorthWildwoodRoadCorridor5ft.tif

python3 tools/simulate_north_wildwood_hydraulics.py \
  --graph /path/to/graph \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --road-mask /path/to/graph/NorthWildwoodRoadCorridor5ft.tif \
  --output /path/to/assets

python3 tools/validate_north_wildwood_hydraulic_features.py \
  --graph /path/to/graph \
  --dem /path/to/NorthWildwoodDEM_Bulkhead21Cell_1ft_NAVD88.tif \
  --centerline /path/to/bulkheads_centerline_1ft.tif \
  --states /path/to/assets/COGs/North\ Wildwood/NorthWildwoodHydraulicStates.json.png

python3 tools/validate_north_wildwood_render_connectivity.py \
  --graph /path/to/graph \
  --road-mask /path/to/graph/NorthWildwoodRoadCorridor5ft.tif \
  --assets /path/to/assets
```

The feature validator fails if the centerline is not expanded by at least ten
cells in all four cardinal directions, any bulkhead cell is below 7.5 ft
NAVD88, any supplied bulkhead cell is mixed into a terrain node, any edge
crosses a bulkhead below 7.5 ft NAVD88, a storm-drain cell enters the graph, or
the source raster differs from the literal 2.00-ft/101-cell rule, or the
declared developed-only polynomial penalty is wrong.

The feature-preparation step records the source ZIP hash, validates the
one-foot grid, and requires the expected 1 hard-structure feature, 6 ignored
drain points, 11,200 centerline pixels, and the official developed-land layer.
The six legacy source polygons and their 254,212 cells remain recorded only as
input provenance. The generated source field is entirely terrain-derived.

The renderer uses the new depth key: shallow water is bright cyan and deeper
water grades to dark navy. Green identifies either terrain below the selected
stage that is disconnected from a qualified tidal source or the developed-land
connected band excluded by the local rising polynomial offset. Each five-foot
display pixel pools all 25 underlying one-foot cells instead of sampling only
its center. Where the rising penalty visually separates a connected low basin,
the renderer may preserve a feeder up to 15 feet wide, but every synthetic
feeder pixel is clipped to an aligned public motor-vehicle road corridor and
the unadjusted hydraulic mask. The road mask is derived from OpenStreetMap
centerlines and excludes footways, paths, tracks, parking aisles, driveways,
and private ways. Routes begin only at the already-qualified terrain source
(2.00 ft NAVD88 and 101 cells for North Wildwood), minimize the highest road
elevation encountered, and then minimize length among equally low routes. A
basin without a continuous eligible road route remains green uncertainty; the
renderer never draws a cross-parcel substitute. The routing function accepts
aligned arrays and is reusable without town-specific dimensions, CRS, source
threshold, or penalty coefficients.
The renderer labels each phase-adjusted mask from the original shared-side
connection stage. It smooths
depth values over roughly ten feet only
inside that immutable water mask, so lidar noise cannot create stippled colors
or new water. The render validator checks all 1,206 PNGs and rejects any
mismatched depth/stage mask, corner-only filling/slack connection, blue
filling/slack component without a source, misplaced green
disconnected/penalty state, or incorrect drainage-retention pixel. Isolated
draining water is permitted only where the developed-land recession lag
explicitly predicts it. The same validator rejects any feeder pixel outside
the public-road corridor.

## Clickable depth

`NorthWildwoodHydraulicQueryWGS84.cog.tif` is an optional seven-band audit COG carrying:

1. conditioned ground elevation;
2. hydraulic zone ID;
3. first equilibrium connection stage;
4. source-block flag;
5. 21-cell, 7.5-foot bulkhead flag;
6. disabled storm-drain flag (always zero).
7. NJDEP 2015 `TYPE15 = URBAN` developed-land flag.

The state package is a gzip-compressed, two-byte centifeet unadjusted
connectivity audit. `NorthWildwoodHydraulicQuery5ft.png` is the routine browser lookup. Its
red/green channels carry the conditioned elevation in tenths of a foot and its
blue channel carries the first four-neighbour connection stage. It is aligned
pixel-for-pixel with the displayed five-foot flood PNGs, so one ordinary PNG
download replaces the large range requests that could make COG clicks fail
intermittently. `NorthWildwoodDevelopedMask5ft.png` is aligned with that query
so browser clicks apply the phase offset only in developed cells. A positive
modeled depth at or below 0.10 ft is shown as `0.0-0.1ft`.

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
DepthPNGs/North Wildwood/                         # slack depth
DepthPNGs/North Wildwood/filling/
DepthPNGs/North Wildwood/draining/
StagePNGs/North Wildwood/                         # slack stage
StagePNGs/North Wildwood/filling/
StagePNGs/North Wildwood/draining/
COGs/North Wildwood/NorthWildwoodHydraulicQueryWGS84.cog.tif.png
COGs/North Wildwood/NorthWildwoodHydraulicStates.json.png
Parcels/North Wildwood/
```

The `.tif.png`, `.json.png`, and `.geojson.png` transport aliases retain their
actual COG, compressed binary, JSON, and GeoJSON bytes. The aliases exist
because this Bunny pull zone's cross-origin allowlist is extension-based.
