# North Wildwood Floodmapper 2.0

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

The flood-depth catalog extends through 22.00 ft NAVD88, covering every
published NACCS station 11283 target in this set without a display cap. All
phase-aware images and compact point-query/state files are bundled under
`assets/hydraulic-v19/`; older equilibrium images are not used as fallbacks.

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
2. Uses four-neighbour components at or below 1.0 ft NAVD88 to qualify supplied
   source-boundary polygons. A component qualifies only when it contains at
   least 101 cells and intersects a supplied polygon; corner-only contact does
   not count. Only the supplied polygon cells inside that qualified component
   become fixed-head boundary cells. The rest of the low component remains
   finite terrain storage instead of being promoted to ocean.
3. Groups the one-foot terrain into 25-foot finite-volume nodes while retaining
   the exact one-foot elevation histogram and the shared one-foot flow width at
   every edge. Boundary cells are placed in separate fixed-head nodes, so a
   source and interior terrain can never share a 25-foot storage node. Storm
   drains are disabled: they are neither connectivity seeds nor underground
   exchange paths.
4. Routes water through those edges with a submerged broad-crested-weir
   relation in 60-second substeps. Edge flow is capped by donor storage,
   receiver capacity, and the two-basin equalization volume. A cell that first
   becomes wet in one substep cannot donate water until the next substep.
5. Builds separate rising, short-slack, and falling histories. Slack holds the
   rising state for 15 minutes. Falling targets interpolate the stored water
   between routed crest histories one foot apart, keeping the effective prior
   crest continuously 2.5 ft above the target without jumps at band boundaries.
   No phase begins from an equilibrium city-wide water plane.

The solve produces reusable assets from 0.0–22.0 ft NAVD88 at 0.1-foot
intervals: 221 stages in each of three phase families, or 663 depth PNGs plus
663 stage-class PNGs. Forecast and observed updates only identify the current
phase and floor the selected level to the nearest 0.1-foot asset; they never
rerun the hydraulic model.

This is a compact response atlas, not an exhaustive high/low endpoint matrix.
At 0.1-foot spacing, even unordered low/high pairs would create 24,531 endpoint
combinations before adding the frames within each tide. V2 instead represents
the dominant hydraulic memory with rising, short-slack, and locally initialized
falling histories. Event-exact timing would require either additional
rise-rate/amplitude buckets or running the same finite-volume solver for the
specific tide series. The weir coefficient, control-volume size, and history
windows should be calibrated against observed street-flood arrival times and
high-water extents before the maps are used for engineering decisions.

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
  --output /path/to/graph

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
```

The feature validator fails if the centerline is not expanded by at least ten
cells in all four cardinal directions, any bulkhead cell is below 7.5 ft
NAVD88, any supplied bulkhead cell is mixed into a terrain node, any edge
crosses a bulkhead below 7.5 ft NAVD88, a storm-drain cell enters the graph, or
the phase arrays do not differ, finite-volume conservation fails, or the
declared front-propagation rule is missing.

The feature-preparation step records the source ZIP hash, validates the
one-foot grid, and requires the expected 1 hard-structure feature, 6 ignored
drain points, 6 source polygons, 11,200 centerline pixels, and 254,212
manual-source pixels. It records the expanded wall pixel count and conditioned
DEM provenance in the generated manifest. In the current graph, 113,359
qualified boundary pixels form 326 boundary-only zones, with no zone containing
both fixed-head boundary and terrain cells.

The renderer uses the new depth key: shallow water is bright cyan and deeper
water grades to dark navy. Green includes terrain that is below the selected
tide but has not yet been reached by the routed wetting front. Surface values
are smoothed over roughly eight feet only inside the immutable finite-volume
wet mask, so smoothing cannot create new water. Falling-tide puddles may remain
after their visible five-foot connection to the source has dried. The render
validator checks all 1,326 depth/stage PNGs, requires matching masks and a real
moving front, and confirms that the three phase catalogs are distinct. It also
fails if any newly flooded interior four-neighbour component exceeds 2,500
one-foot pixels between adjacent 0.1-ft frames. The current maximum is 1,978
pixels; drying transitions are measured separately and do not count as flood
growth.

## Clickable depth

`NorthWildwoodHydraulicQueryWGS84.cog.tif` is a six-band, one-foot COG carrying:

1. conditioned ground elevation;
2. hydraulic zone ID;
3. first equilibrium connection stage;
4. qualified supplied source-boundary flag;
5. 21-cell, 7.5-foot bulkhead flag;
6. disabled storm-drain flag (always zero).

The phase-aware state package is a gzip-compressed, two-byte centifeet audit
lookup. `NorthWildwoodHydraulicQuery5ft.png` carries conditioned elevation and
the legacy connection threshold, while `NorthWildwoodHydraulicZone5ft.png`
carries the 24-bit finite-volume zone ID. Both align pixel-for-pixel with the
displayed five-foot flood PNGs, so ordinary PNG downloads avoid fragile large
COG range requests. A click reads the phase/stage node surface and reports only
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
