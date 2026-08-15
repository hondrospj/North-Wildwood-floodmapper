# North Wildwood conditional-connectivity v29

Generated and validated on 2026-08-15.

## Inputs and terrain

- Source: 2019 South Jersey LiDAR DEM, 5 ft grid, EPSG:6527, NAVD88 feet.
- Resample: cubic convolution on a 1 ft computational grid, bounded to each
  output cell's finite 5x5 source-neighborhood extrema. This preserves smooth
  feature shape without cubic overshoot. The maximum error at original 5 ft
  cell centers was `1.46e-11 ft`.
- Bounded values: 392,691 low overshoots and 173,208 high overshoots were
  clipped. The result has 61,749,200 valid 1 ft cells.
- Bulkhead: the previously supplied hard-structure centerline was rasterized
  with `ALL_TOUCHED`, buffered ten 1 ft cell centers per side, and stitched into
  the source DEM at a minimum 7.5 ft NAVD88. The 21-cell mask contains 174,993
  cells; all were raised.
- Developed land: official NJDEP Land Use/Land Cover 2015 polygons selected by
  `TYPE15 = URBAN`, aligned to the 1 ft grid. Wetlands, water, forest,
  agriculture, and barren land (including beaches) receive no penalty.

The original 5 ft measurements remain the accuracy support of the interpolated
grid. The 1 ft spacing is used to preserve narrow barriers and shared-side
connectivity, not to claim new survey accuracy.

## Source and connectivity rule

The source raster is generated only from the unrounded, conditioned DEM:

1. Mark every valid cell at or below 2.000000 ft NAVD88.
2. Label components using four-neighbor/shared-side connectivity.
3. Keep every component containing at least 101 cells (the source cell plus at
   least 100 other cells).
4. Do not consult the legacy hand-drawn source polygons.

The production result contains 28 components and 18,233,174 source cells. A
monotone union-find solve records the first gauge stage at which every 1 ft
cell becomes side-connected to this source field, through 20.0 ft NAVD88.

## Developed-land polynomial and phase behavior

For `x = stage - 3.25`, the penalty between minor and major flood is:

`P(x) = 0.125x² - 0.625x + 0.75`

It is clamped to 0.75 ft below minor flood and 0.00 ft above major flood. The
three exact stage/penalty anchors are `(3.25, 0.75)`, `(4.25, 0.25)`, and
`(5.25, 0.00)`.

- Filling and slack: developed cells use `adjusted stage = gauge stage - P`.
  Cells connected at the gauge stage but excluded at the adjusted stage are
  green uncertainty.
- Draining: developed cells use `adjusted stage = gauge stage + P`. This
  retains previously routed water to represent lagged recession; it does not
  introduce a new source or inflow.
- Undeveloped cells always use the unadjusted gauge stage.

Every phase-adjusted candidate mask is relabeled with four-neighbor
connectivity, and every blue component must touch a qualified source pixel.

## Published asset contract

- 201 stages, 0.0 through 20.0 ft NAVD88 in 0.1 ft increments.
- Three phase directories: `filling/`, slack at the town root, and
  `draining/`.
- Two PNG families per phase: depth and stage, for 1,206 PNGs total.
- Bunny-compatible filenames run from `NorthWildwoodDepthp0000.png` to
  `NorthWildwoodDepthp2000.png` and equivalently for `NorthWildwoodStage`.
- `NorthWildwoodHydraulicQuery5ft.png` contains ground and first connection
  stage. `NorthWildwoodDevelopedMask5ft.png` supplies the aligned developed
  flag for browser point queries.
- Positive clicked depth from 0.00 through 0.10 ft is formatted `0.0-0.1ft`.

## Validation result

The production validation passed all of the following:

- exact equality between the source raster and the literal unrounded
  2.00-ft/101-cell rule;
- continuous ten-cell expansion in all cardinal directions from the 11,200
  centerline cells;
- no bulkhead terrain below 7.5 ft NAVD88 and no active drain cells;
- all 603 depth/stage frame pairs have identical blue masks;
- every blue component is shared-side connected to a source;
- every green cell is exactly the developed rising/slack exclusion band;
- every draining-only retained cell is developed land; and
- 1,277,094 green uncertainty pixel-instances and 2,095,899 recession-retained
  pixel-instances were independently reproduced by the validator.

The Bunny upload helper targets versioned `v29` paths and verifies public
checksums and CORS. The repository also contains the complete local v29 catalog
so the dashboard does not depend on an upload being present.
