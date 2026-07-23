# North Wildwood Floodmapper 2.0

This repository is the complete North Wildwood counterpart to Stone Harbor
Floodmapper 2.0. It uses the Great Channel at Stone Harbor gauge as the live and
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
Stone Harbor gauge. Winter Storm Jonas is calibrated to the documented North
Wildwood crest of 6.69 ft NAVD88 / 9.44 ft MLLW while preserving the Stone
Harbor 15-minute tide shape.

## One-foot hydraulic model

The source DEM is resampled bilinearly to a one-foot grid in EPSG:6527, with
vertical units in NAVD88 feet. The model then:

1. Rasterizes the user-drawn bulkhead centerline with GDAL, expands it ten
   one-foot cells on both sides (21 cells nominal width), and stitches that
   wall into a new DEM at 7.5 ft NAVD88 before graph construction.
2. Finds four-neighbour components at or below 1.0 ft NAVD88. A component is a
   source block only when it contains at least 101 cells and intersects a
   supplied source-block polygon. Corner-only contact does not count.
3. Computes each cell's minimum equilibrium connection stage through 14.0 ft.
   Storm drains are disabled in this model version: they are neither
   connectivity seeds nor underground exchange paths.
4. Marks a cell connected when its conditioned ground elevation and its exact
   four-neighbour source-connection threshold are both below the full selected
   gauge stage. A corner connection can never make a cell blue.
5. Penalizes the resulting connected depth to avoid overstating low-level
   flooding. The maximum penalty is 1.25 ft through minor flood, then follows
   a normalized exponential decay that reaches exactly zero at major flood.
   The applied penalty is capped at 75 percent of each cell's raw depth, so a
   connected wet cell retains at least 25 percent of its depth and remains
   shallow bright blue instead of being misclassified as green.

The solve produces reusable assets from 0.0–14.0 ft NAVD88 at 0.05-foot
intervals. It is intentionally static: `filling`, `slack`, and `draining`
assets are identical for the same gauge level. Hourly and 15-minute application
updates floor the selected level to the nearest 0.05-foot asset.

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
the three phase arrays differ, or the declared vertical penalty is wrong.

The feature-preparation step records the source ZIP hash, validates the
one-foot grid, and requires the expected 1 hard-structure feature, 6 ignored
drain points, 6 source polygons, 11,200 centerline pixels, and 254,212
manual-source pixels. It records the expanded wall pixel count and conditioned
DEM provenance in the generated manifest.

The renderer uses the new depth key: shallow water is bright cyan and deeper
water grades to dark navy. Green is reserved for terrain that is below the
selected tide but is genuinely not side-connected to a qualified source at
that tide. As its final step, the renderer labels the five-foot water mask with
four-neighbour connectivity and removes every blue component that does not
touch a qualified source. It smooths depth values over roughly ten feet only
inside that immutable water mask, so lidar noise cannot create stippled colors
or new water. The render validator checks all 843 depth/stage pairs and rejects
any isolated pixel, mismatched mask, corner-only connection, or blue component
without a source.

## Clickable depth

`NorthWildwoodHydraulicQueryWGS84.cog.tif` is a six-band, one-foot COG carrying:

1. conditioned ground elevation;
2. hydraulic zone ID;
3. first equilibrium connection stage;
4. source-block flag;
5. 21-cell, 7.5-foot bulkhead flag;
6. disabled storm-drain flag (always zero).

The phase-invariant state package is a gzip-compressed, two-byte centifeet audit
lookup. `NorthWildwoodHydraulicQuery5ft.png` is the routine browser lookup. Its
red/green channels carry the conditioned elevation in tenths of a foot and its
blue channel carries the first four-neighbour connection stage. It is aligned
pixel-for-pixel with the displayed five-foot flood PNGs, so one ordinary PNG
download replaces the large range requests that could make COG clicks fail
intermittently. The nearest-neighbour, uncompressed query COG remains a
retrying fallback. A click combines the packed query cell with full-stage
source connectivity and the bounded local depth penalty, then reports only the
modeled water depth.

## Forecast and observed archives

- `.github/workflows/update-forecast.yml` retrieves hourly PETSS/NOAA guidance,
  applies the -2.75 ft offset, and assigns the matching static stage asset.
- `.github/workflows/update-observed.yml` maintains USGS site `01411360`,
  parameter `72279`, on exact 15-minute anchors plus the hourly calendar
  archive and official historic crest list.
- `.github/workflows/update-lewes-archive.yml` maintains the verified pre-2007
  Lewes surrogate used only when the Stone Harbor continuous record does not
  exist.

The interface includes 15-minute, hourly, and daily playback; top-ten historic
tides; guided help; address lookup; map and GIF export; mobile controls; parcel
boundaries; House Alerts; and clickable depth.

## Parcel House Alerts

`tools/build_parcel_alerts.py` uses the official NJ composite MOD-IV layer for
North Wildwood municipality `0507`. It samples each parcel centroid against the
one-foot DEM and combines independent high-tide peaks with the NOAA 2022 Cape
May low, intermediate, and high relative sea-level scenarios through 2100.

```bash
python3 tools/build_parcel_alerts.py \
  --dem /path/to/NorthWildwoodDEM_1ft_NAVD88.tif \
  --observed observed15min.json \
  --output /path/to/parcel-assets
```

Parcel results are screening estimates, not surveys, insurance
determinations, legal boundaries, or structure-specific engineering analyses.

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
