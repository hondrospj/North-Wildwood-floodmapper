# North Wildwood Floodmapper 2.0

This repository is the complete North Wildwood counterpart to Stone Harbor
Floodmapper 2.0. It uses the Great Channel at Stone Harbor gauge as the live and
historical water-level forcing source, then applies North Wildwood's datum
conversion, flood thresholds, terrain, DEM-integrated bulkheads, parcels, and
hydraulic routing.

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
4. Integrates exact one-foot elevation hypsometry inside economical 25-foot
   finite-volume tiles. A tile is split into separate four-neighbour components
   for every connection band, and bulkhead cells are isolated as barrier
   material, so disconnected terrain on opposite sides of a hard structure can
   never share a storage node. Each terrain cross section contains one foot of
   width for every shared one-foot cell side, grouped by crest elevation.
5. Advances flow with submerged broad-crested-weir physics and conservative
   60-second substeps inside every 15-minute tide interval. All edge transfers
   in a substep are simultaneous, so a newly wet control volume cannot pass
   water onward until the following minute. With a conservative 25-foot tile
   diagonal, the overland front can travel no more than about 530 feet per
   15-minute interval.
6. Bounds every explicit transfer by the two-basin equalization volume,
   aggregate receiving capacity, and available donor storage.

The expensive solve runs once. It produces reusable `filling`, `slack`, and
`draining` states from 0.0–14.0 ft NAVD88 at 0.1-foot intervals. Draining
states use local falling-tide histories: each half-foot target band starts
from a preceding crest no more than 1.0 ft above its lowest stage. This prevents an ordinary falling tide from
inheriting residual storage from a fictional 14 ft storm. Hourly and 15-minute
application updates only choose an existing phase/stage asset.

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
the finite propagation metadata does not match the explicit routing step.

The feature-preparation step records the source ZIP hash, validates the
one-foot grid, and requires the expected 1 hard-structure feature, 6 ignored
drain points, 6 source polygons, 11,200 centerline pixels, and 254,212
manual-source pixels. It records the expanded wall pixel count and conditioned
DEM provenance in the generated manifest.

The renderer uses the new depth key: shallow water is bright cyan and deeper
water grades to dark navy. Terrain that is below the selected tide but is not
connected or has not filled yet is green. As its final step, the renderer
labels the five-foot water mask with four-neighbour connectivity and removes
every blue component that does not touch a qualified source. It smooths depth
values over roughly ten feet only inside that immutable water mask, so lidar noise cannot create
stippled colors or new water. The render validator checks all 423 depth/stage
pairs and rejects any isolated pixel, mismatched mask, corner-only connection,
or blue component without a source.

## Clickable depth

`NorthWildwoodHydraulicQueryWGS84.cog.tif` is a six-band, one-foot COG carrying:

1. conditioned ground elevation;
2. hydraulic zone ID;
3. first equilibrium connection stage;
4. source-block flag;
5. 21-cell, 7.5-foot bulkhead flag;
6. disabled storm-drain flag (always zero).

The phase state package is a gzip-compressed binary lookup. It uses a compact
one-byte decifeet encoding so the browser downloads about 6 MB rather than
parsing roughly 150 MB of base64 JSON. A click combines the COG cell with the
exact phase/stage water surface and reports ground, local water surface, depth,
connection stage, source status, and hydraulic feature.

## Forecast and observed archives

- `.github/workflows/update-forecast.yml` retrieves hourly PETSS/NOAA guidance,
  applies the -2.75 ft offset, and assigns a rising/slack/falling hydraulic
  phase.
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
