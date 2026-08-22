# North Wildwood Floodmapper

## Phase-aware conditional connectivity

The dashboard keeps its later gauge archives, return-interval storms, exports,
mobile layout, and parcel tools, but its flood surface has been restored to the
new one-foot conditional-connectivity contract. It floors the selected water
level to a reusable 0.1-ft NAVD88 frame and selects a filling, high-tide,
post-crest release, or normal-draining PNG; it does not run a new simulation
in the browser.

This repository is the complete North Wildwood counterpart to the Stone Harbor
Floodmapper. Its observed archive uses the City of North Wildwood tide gauge
wherever that municipal record is usable, beginning September 1, 2017, with
Great Channel at Stone Harbor retained before then and as a gap fallback. The
mapper applies North Wildwood's datum conversion, flood thresholds,
bulkhead-conditioned bare-earth terrain, NSI 2026 structure-impact thresholds,
parcels, and a source-connected filling and drainage surrogate.

## Water-level contract

| Category | NAVD88 | MLLW |
| --- | ---: | ---: |
| Minor | 3.25 ft | 6.00 ft |
| Moderate | 4.25 ft | 7.00 ft |
| Major | 5.25 ft | 8.00 ft |

`NAVD88 = MLLW - 2.75 ft`. Forecast guidance continues to use Stone Harbor.
Observed playback uses North Wildwood municipal sensor `1005` as the primary
source from its first usable record at 8:58 AM EDT on September 1, 2017
(`2017-09-01T12:58:00Z`); Stone Harbor USGS site `01411360` supplies earlier
anchors and municipal-gauge gaps.
Hurricane Sandy's Stone Harbor gauge outage is filled only for event replay
with NOAA Lewes verified tide shape, time-aligned and scaled to the official
6.73 ft NAVD88 / 9.48 ft MLLW crest. Winter Storm Jonas predates the city
archive and is calibrated to the documented North Wildwood crest of 6.69 ft
NAVD88 / 9.44 ft MLLW while preserving the Stone Harbor 15-minute tide shape.
Both events expose complete 15-minute replays and derived hourly values.

## Return-interval storms

The **Return Intervals** data source supplies synthetic 24-hour storms at every
2015 NACCS station 11283 annual recurrence interval through 10,000 years. All
frequency calculations are performed in feet NAVD88; MLLW is only a display
conversion using the mapper's existing `+2.75 ft` contract.

| Return interval | NACCS 11283 | Local gauge fit | Mapper target | Target method |
| ---: | ---: | ---: | ---: | :--- |
| 1 year | 4.2165 ft | 4.3500 ft | 4.3055 ft | 2:1 local-gauge-weighted blend |
| 2 years | 5.4460 ft | 4.8145 ft | 5.0250 ft | 2:1 local-gauge-weighted blend |
| 5 years | 6.6425 ft | 5.3507 ft | 5.7813 ft | 2:1 local-gauge-weighted blend |
| 10 years | 7.3436 ft | 5.7045 ft | 6.2509 ft | 2:1 local-gauge-weighted blend |
| 20 years | 8.0468 ft | 6.0192 ft | 6.6951 ft | 2:1 local-gauge-weighted blend |
| 50 years | 9.5326 ft | 6.3824 ft | 7.4324 ft | 2:1 local-gauge-weighted blend |
| 100 years | 10.7608 ft | 6.6220 ft | 8.0016 ft | 2:1 local-gauge-weighted blend |
| 200 years | 11.9254 ft | — | 11.9254 ft | NACCS only |
| 500 years | 13.4856 ft | — | 13.4856 ft | NACCS only |
| 1,000 years | 14.7033 ft | — | 14.7033 ft | NACCS only |
| 2,000 years | 15.9218 ft | — | 15.9218 ft | NACCS only |
| 5,000 years | 17.5026 ft | — | 17.5026 ft | NACCS only |
| 10,000 years | 18.6306 ft | — | 18.6306 ft | NACCS only |

The local estimate is a GEV distribution fitted by L-moments to one maximum
per available complete water year. It combines Stone Harbor's long historic
crest-stage record with the city-primary continuous archive from September
2017 onward. The combined record contains 60 water years from 1965–2025;
water year 1981 is unavailable. The fit uses the point-process return-level
convention `F = exp(-1/T)`, which gives a finite one-year level. The raw
6.22-ft NAVD88 USGS Jonas crest is used in this statistical series, not the
mapper's separate 6.69-ft North Wildwood replay calibration.

The 1–100-year targets use two parts local historic/continuous gauge record to
one part NACCS. The 200–10,000-year targets use the published NACCS values
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
`NorthWildwoodDepthp2000.png`) under versioned v37 filling, high-tide,
15-minute release, 30-minute release, and normal-draining directories.

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
   stage/penalty anchors. The penalty is exactly zero below minor and at or
   above major; therefore no green uncertainty is shown below minor and normal
   filling has resumed by one foot above major. Between the anchors the unique
   quadratic is `0.125x² - 0.625x + 0.75`, where `x` is feet above minor.
   Connectivity is always evaluated at the full gauge stage; the penalty only
   holds back the shallow connected developed-ground band. It is uniform
   across the city's developed mask and does not vary with source distance.
   The NJDEP 2015 `TYPE15 = URBAN` mask prevents any penalty on marshes,
   beaches, water, forest, and agriculture.
6. Keeps the full penalty at the local high tide, then removes it linearly in
   quarter-hour steps over 45 minutes for a minor crest, 30 minutes for a
   moderate crest, and zero minutes for a major crest. There is no positive
   draining offset. Any post-crest cell that is blue uses the full selected
   gauge stage as its water surface, equal to the outside/source-block water
   surface. The penalty controls admission only; it never raises inland water.

The solve produces 201 stages from 0.0–20.0 ft NAVD88 at 0.1-foot intervals for
`filling`, `slack`, `draining-release-15`, `draining-release-30`, and
`draining`. Minor remaining-penalty fractions are 1, 2/3, 1/3, and 0 at 0,
15, 30, and 45 minutes after high tide; moderate fractions are 1, 1/2, and 0
at 0, 15, and 30 minutes; major is 0 immediately. Hourly and 15-minute updates
floor the selected level to the same stage catalog. Release is based on elapsed
time since the latest confirmed crest, not array position. The visible frame
and nearest neighbors load first; farther frames warm sequentially during
browser idle time.

Build the parcel and NSI impact assets described under **Parcel House Alerts**
independently from the hydraulic terrain. The main hydraulic builders are:

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
declared developed-only polynomial penalty is wrong. It also requires both the
graph and state package to state explicitly that NSI floors are not hydraulic
terrain.

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
the penalty-held developed uncertainty mask. A disconnected marsh/beach cell
can never be converted to blue. Every feeder is rendered at 0.05 ft, inside the
displayed 0.00–0.10-ft depth bin. The road mask is derived from OpenStreetMap
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
or new water. The render validator checks all 2,010 PNGs and rejects any
mismatched depth/stage mask, corner-only connection, blue component without a
source, green cell below minor, misplaced green disconnected/penalty state, or
feeder outside the 0.00–0.10-ft bin. It also rejects any feeder pixel outside
the public-road corridor or the explicit developed penalty band.

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
- `.github/workflows/update-observed.yml` maintains a clean fallback layer from
  USGS site `01411360`, parameter `72279`, then overlays the North Wildwood city
  gauge on exact 15-minute anchors. The city source wins whenever it has a
  usable interpolation bracket of 30 minutes or less. Stone Harbor supplies
  earlier dates and remaining gaps.
- `.github/workflows/update-city-gauge-archive.yml` refreshes the municipal
  archive daily, reapplies that source priority, and rebuilds the hourly
  calendar plus browser-optimized daily indexes and source/year shards in
  `observed_archive/`.
- `.github/workflows/update-lewes-archive.yml` maintains the verified pre-2007
  Lewes surrogate used only when the Stone Harbor continuous record does not
  exist.

The interface includes 15-minute, hourly, and daily playback; top-ten historic
tides; guided help; address lookup; map and GIF export; mobile controls; parcel
boundaries; House Alerts; USACE NSI 2026 modeled first-floor impacts; and
clickable depth.

To rebuild and verify the browser-optimized tide archive:

```bash
python3 tools/build_observed_archive_shards.py
python3 tools/test_observed_archive_shards.py
```

## Parcel House Alerts

`tools/build_parcel_alerts.py` uses the official NJ composite MOD-IV layer for
North Wildwood municipality `0507`. Its parcel-ground fallback uses the highest
center of an intersecting cell from the original five-foot DEM grid. The
historical count comes from independent high-tide peaks in the city-primary
observed archive, separated by at least six hours. A threshold is exceeded only
when water is strictly more than 0.10 ft above it; a depth equal to 0.10 ft is
excluded.

`tools/build_nsi_2026_structures.py` adds the USACE National Structure Inventory
2026 Base layer. It clips the API response to the official NJGIS municipal
boundary, collapses stacked NSI records to one point per building footprint,
samples the mapper's local 2019 bare-earth LiDAR ground at that point, and
calculates:

```text
modeled first floor (ft NAVD88)
  = local mapper ground (ft NAVD88) + NSI found_ht (ft above ground)
```

This intentionally replaces only NSI's nationally sourced 10-meter ground
value, not NSI's modeled foundation height. For a parcel with more than one
matched footprint, the profile uses the lowest residential first-floor
threshold, or the lowest threshold of any occupancy when no residential record
exists. The original parcel-ground fields remain in the asset as an explicit
fallback.

NSI first-floor thresholds are deliberately not burned into the DEM. They are
used only for structure and parcel impact screening. The hydraulic graph,
packed point-query grid, and all five phase catalogs use the
bulkhead-conditioned bare-earth surface. This avoids treating buildings as
solid terrain walls—especially the open space beneath pile and pier
foundations—and keeps the drainage surrogate aligned with its stated purpose.
The rectangles are modeled approximations, not source footprint polygons,
surveys, elevation certificates, or regulatory products. The structure-impact
dots, historical exceedance counts, and parcel projections continue to use the
same modeled first-floor thresholds.

The same city-primary series is fitted from equally weighted monthly means and
rebased to January 1, 2026. The projection model includes that existing local
trend plus NOAA's 2022 Low, Intermediate Low, Intermediate, Intermediate High,
and High Cape May relative sea-level scenarios. Every NOAA median curve is
fitted quadratically and rebased to zero in 2026. A continuous Gaussian-kernel
exceedance CDF and two-sided 95% calendar-year block-bootstrap interval are
evaluated for every curve, year from 2026–2100, and 0.1-foot elevation step
from 0.0–20.0 ft NAVD88. The upper bound matches the hydraulic stage catalog
and covers the full 1.2–18.6 ft range of the committed NSI floor thresholds.

```bash
python3 tools/build_parcel_alerts.py \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --observed observed15min.json \
  --output /path/to/parcel-assets

python3 tools/build_nsi_2026_structures.py \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --output assets/nsi-2026 \
  --parcels assets/parcel-history-v2/NorthWildwoodParcels.geojson \
  --cdf assets/parcel-history-v2/NorthWildwoodHouseAlertCDF.json
```

The NSI builder queries the official North Wildwood boundary's small bounding
box from the public API, then performs the exact municipal polygon clip locally.
This avoids a current API error on the municipality's detailed coastline while
preserving the exact city selection. `--nsi` and `--boundary` accept cached
GeoJSON for reproducible offline rebuilds. Run it after rebuilding parcels so
the modeled floor fields are not overwritten.

To refresh only the projection file using a cached NOAA 2022 response:

```bash
python3 tools/build_parcel_alerts.py \
  --observed observed15min.json \
  --slr /path/to/slr_projections_2022.json \
  --output assets/parcel-history-v2 \
  --cdf-only \
  --refresh-existing-parcels
```

Parcel and NSI results are screening estimates, not surveys, elevation
certificates, insurance determinations, legal boundaries, or structure-specific
engineering analyses. USACE describes NSI Base as a nationally consistent
modeled inventory rather than structure-by-structure verification; an
individual foundation type, height, occupancy, or point location can be wrong.

The Buildings switch repeats the exact Esri OSM vector-tile building geometry
from the basemap in a transparent foreground pane above the floodwater. The
**NSI floor impacts** switch lazily loads 3,843 modeled footprint points: red
means the selected water level is more than 0.10 ft above the modeled floor,
gold is within 0.5 ft, and cyan is below it. A building click or matched address
opens the parcel prompt and loads the projection dataset only after the user
chooses **See Flood History And Projections**. Initial startup similarly renders
the forecast hour nearest the current time first; observed archives, historical
tides, boundary data, and other secondary data warm in the background.

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
