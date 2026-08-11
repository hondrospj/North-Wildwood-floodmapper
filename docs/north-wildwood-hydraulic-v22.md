# North Wildwood hydraulic atlas v22

> Superseded by [north-wildwood-hydraulic-v23.md](north-wildwood-hydraulic-v23.md),
> which removes manual seed qualification and center-cell rendering.

## Corrected boundary interpretation

The six small GIS polygons are seed markers, not tidal cells and not hydraulic
boundaries. V21 incorrectly rendered their qualified pixels as the fixed-head
source, which produced the isolated rectangular/circular-looking patches seen
on the map.

V22 uses the seeds only to select legitimate four-neighbour tidal components.
Every one-foot DEM cell at or below **2.0 ft NAVD88** in each selected component
is fixed-head source. Five unique connected components qualify, containing
18,231,114 one-foot cells, or 418.53 acres. The complete footprint comprises
the inlet, coastal water, channels, and connected marsh. It contains 47,453
subgrid source zones and retains 116,898 one-foot source–terrain perimeter
faces. No source zone contains ordinary terrain.

The browser contract is unchanged: it derives a stage and history family from
the scalar hydrograph, floors the stage to 0.1 ft, and pulls one PNG. It never
runs hydraulics for an individual forecast tide.

## Source transition

- Rising and crest frames below 2.0 ft remain transparent.
- At 2.0 ft, the positive-depth portion of the complete source footprint is
  visible: 410.68 acres. Cells whose ground is exactly 2.0 ft have zero depth
  and correctly remain transparent. Exterior terrain volume is zero.
- At 2.1 ft, the remaining source-edge cells acquire displayable depth. The
  visible footprint is 418.19 acres and visible exterior terrain is still zero.
- At 2.2 ft, the typical rising family shows 7.76 exterior acres. The zone-level
  exterior stored volume is 0.710862 acre-ft after finite perimeter routing.
- Water can leave the source only through its complete one-foot perimeter and
  only for the time represented by the selected rise or crest history.
- On recession, terrain can drain back through the same perimeter. The 2.0-ft
  inflow condition is directional, not an artificial two-way wall.

## Numerical method

Each 25-ft finite-volume node retains the one-foot DEM elevation histogram.
Ordinary face discharge uses the US customary Manning wide-sheet relation

`Q = (1.486 / n) W h^(5/3) sqrt(|delta eta| / L)`

with `n = 0.12`, `L = 25 ft`, grouped one-foot face width `W`, water depth above
the face crest `h`, and water-surface gradient `delta eta / L`. At a dry,
free-overflow face, discharge is capped by

`Q = 3.10 W h^(3/2)`.

Fluxes are simultaneous at 60-second intervals and limited by donor storage,
receiver capacity, and two-basin equalization volume. A newly wet node cannot
donate until the next step and must first store a 0.05-ft mobile depth. These
rules prevent a microscopic numerical film from traversing a connected basin.

The atlas contains three rising families (0.55, 0.79, and 0.90 ft/hr), a
15-minute crest family, and continuous recessions from 4.0-, 5.5-, and 8.5-ft
prior crests. Each family contains 101 stages from 0.0 through 10.0 ft NAVD88,
for 707 depth and 707 stage PNGs. This preserves tide timing and hysteresis with
a bounded asset catalog rather than tide-cycle-specific simulations.

## Verification

The release validation found:

- 707/707 depth frames and 707/707 stage frames present;
- identical depth/stage wet masks at every state;
- no water below 2.0 ft in rising or crest families;
- exact 2.0-ft agreement with the positive-depth portion of the connected
  source footprint and zero exterior terrain;
- maximum connected adjacent-stage terrain addition of 643 five-foot pixels,
  or 0.37 acre;
- maximum new-water arrival of 57 five-foot pixels (285 ft), below the
  conservative 115-pixel (575-ft) per-transition travel envelope;
- maximum internal conservation residual of 9.095e-11 ft3 across the complete
  atlas and 6.134e-14 ft3 in the low-stage method benchmark;
- 21-cell, 7.5-ft NAVD88 bulkhead preserved, with no crossing below its crest;
- storm-drain exchange disabled;
- all seven all-stage contact sheets visually inspected, followed by satellite
  inspection at 2.0, 2.1, 2.2, 3.0, 4.0, and 5.0 ft and on recession.

The executable method comparison is
`tools/benchmark_north_wildwood_methods.py`; its committed output is
`docs/north-wildwood-hydraulic-v22-benchmark.json`. The render audit is
`tools/validate_north_wildwood_render_connectivity.py`.

## Research basis

- SFINCS subgrid corrections retain subgrid volume, wet fraction, roughness,
  and interface conveyance in continuity and momentum calculations:
  <https://gmd.copernicus.org/articles/18/843/2025/>.
- Bates, Horritt, and Fewtrell retain continuity, water-surface gradient, and
  friction in a reduced local-inertial floodplain formulation:
  <https://doi.org/10.1016/j.jhydrol.2010.03.027>.
- HEC-RAS storage-area/2D connections limit transfer through explicit cross
  sections:
  <https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.4/entering-and-editing-geometric-data/storage-area-and-2d-flow-area-connections>.
- HEC-RAS distinguishes critical/free weir overflow from submerged ordinary
  2D flow:
  <https://www.hec.usace.army.mil/confluence/rasdocs/hgt/latest/guides/modeling-weirs-in-2d-areas>.
- USACE roughness guidance notes the elevated resistance of shallow urban
  overland flow:
  <https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/6.5/developing-a-terrain-model-and-geospatial-layers/creating-land-cover-mannings-n-values-and-impervious-layers>.
- Gallien et al. show the importance of time-varying coastal forcing and
  pathway timing for urban coastal inundation:
  <https://doi.org/10.1016/j.coastaleng.2014.04.007>.

## Limitations

This is a reduced-physics response atlas, not a calibrated event-specific 2D
shallow-water forecast. It omits rainfall, wave setup, wind stress,
infiltration, storm-drain hydraulics, and spatially varying roughness. The
2.0-ft footprint is derived from the conditioned one-foot DEM and seed-selected
four-neighbour connectivity. High-water marks or street sensors are still
required for calibration before engineering-design use.
