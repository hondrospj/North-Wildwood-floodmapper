# North Wildwood lowest-road conditional-connectivity v33

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
- Public roads: 398 current OpenStreetMap motor-vehicle road ways were buffered
  by classification or tagged width onto the aligned 5 ft display grid. The
  333,729-cell mask excludes footways, paths, tracks, parking aisles,
  driveways, and private ways.

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

- Filling: source connectivity is evaluated at the real gauge stage, then the
  negative offset is applied only to local developed ground. Cells in that
  shallow local band are green uncertainty; a penalized route crest cannot
  suppress a lower connected basin beyond it.
- Slack/high tide: the offset is zero, rapidly releasing the rising
  uncertainty as high tide arrives.
- Draining: developed cells use `adjusted stage = gauge stage + P`. This
  retains previously routed water to represent lagged recession; it does not
  introduce a new source or inflow.
- Undeveloped cells always use the unadjusted gauge stage.

Green is also used in every phase for terrain below the selected gauge stage
that does not have a qualified source connection. Blue always means connected
or lag-retained source-routed water. Green never means "no flooding" by itself; it distinguishes the
disconnected or penalty-held diagnostic state from connected blue water.

Each five-foot display cell pools all 25 underlying one-foot cells. The first
eligible one-foot source connection paints the display cell, preserving narrow
shared-side feeder paths at a visible 15-foot width. This replaces the old
center-cell sample and coarse-grid relabel that could erase a valid connection.
If the developed penalty would visually sever a lower connected basin during
filling, the reusable renderer begins at an adjusted-wet cell from the literal
qualified source mask, searches the eligible public-road graph, minimizes the
highest ground elevation encountered, and then minimizes length among routes
with the same controlling crest. The feeder is clipped to both that road
corridor and the unadjusted hydraulic mask, with one display-cell dilation
producing a corridor up to three cells (15 ft) wide. A road-unreachable basin
stays green rather than receiving a synthetic path across a parcel, building,
marsh, beach, or parking lot. Every filling/slack blue component must therefore
touch a qualified source pixel. Draining may retain isolated blue puddles as
the explicit developed-area recession lag.

The routing module accepts aligned source, baseline, penalty-adjusted,
elevation, and road arrays. It contains no North Wildwood dimensions, CRS,
threshold, or penalty constants, so another town can use the same logic after
building its own qualified source and aligned road corridor.

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
- every filling/slack blue component is shared-side connected to a source;
- every green cell is either disconnected terrain below the selected stage or
  the developed filling exclusion band;
- every draining-only retained cell is developed land; and
- all 23,794 feeder pixel-instances are inside the 333,729-cell public-road
  mask, with zero off-road feeder pixels across all 603 frames;
- 953,915 developed green uncertainty pixel-instances in the filling family,
  zero penalty-held pixels at slack/high tide, 883 road-reachable detached
  components joined, 1,672 road-unreachable components conservatively left
  green, and 1,715,671 recession-retained pixel-instances were independently
  reproduced by the validator.

At the reported Aug. 21, 2025 6:00 PM frame, 6.55 ft MLLW floors to the
`p0380` NAVD88 filling image. It contains 905,070 blue pixels and 74,888 green
diagnostic pixels. Browser review at Delaware Avenue and the west-side street
grid confirms that preserved feeders follow the visible road network rather
than the v31 right-angle paths across blocks. The same-stage route audit shows
that its feeders start from the qualified source, use a maximum road crest no
higher than the selected stage, and contain no off-road cells.

The Bunny upload helper targets versioned `v33` paths and verifies public
checksums and CORS. The repository also contains the complete local catalog
so the dashboard does not depend on an upload being present.
