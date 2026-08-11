# North Wildwood hydraulic atlas v25

## Boundary/display correction

The complete 418.504-acre, <=2.0-ft NAVD88 tidal field remains the internal
fixed-head forcing boundary used by the mass-conserving finite-volume solve.
It supplies or receives water only through measured one-foot source/terrain
faces and is still subject to finite flux, elapsed time, donor/receiver
capacity, equalization, Manning friction, and the free-overflow cap.

The boundary itself is not flood impact. V25 therefore excludes every source
subcell from the public flood-depth and flood-stage PNGs. A colored public cell
now means exactly what the legend says: finite-storage terrain received routed
water. This removes the permanent dark source polygons without changing the
hydraulic state or rerunning a simulation for each tide cycle.

## Rendering contract

- The 2.0-ft activation frame is fully transparent for rising and crest
  histories; activating the internal boundary does not paint land or water.
- Mixed five-foot shoreline pixels aggregate only their non-source one-foot
  terrain subcells.
- Source-only five-foot pixels must be transparent in all 1,414 depth/stage
  assets.
- Depth and stage masks must match, dry terrain stays transparent, and the
  seven history families remain distinct.

## Verification

The all-frame validator examines every operational depth and stage image. It
asserts that no source-only display pixel is colored, that the 2.0-ft rising
and crest frames are transparent, and that adjacent-stage wetting respects the
physical travel-time envelope. V25 passes all 1,414 frames. Its maximum new
water travel is 59 five-foot pixels (295 ft), below the 115-pixel (575-ft)
limit, and its largest connected adjacent-stage terrain addition is 524
five-foot pixels (0.30 acre).

The hydraulics themselves remain the benchmarked v24 finite-volume state set;
only the incorrect visualization of its forcing reservoir changed. See
`north-wildwood-hydraulic-v24-benchmark.json` for the method comparison and
mass-conservation results.
