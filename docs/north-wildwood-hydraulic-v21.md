# North Wildwood hydraulic atlas v21

## Decision

The live mapper keeps its existing operational contract: the browser derives a
stage and tide-limb/history family from the forecast or observation, floors the
stage to 0.1 ft, and requests one PNG. It does not run a new simulation for each
tide and it does not need a PNG for every possible hydrograph.

The assets behind that contract are rebuilt with a mass-conserving subgrid
diffusive-wave finite-volume solver. The important boundary interpretation is:

- the supplied blocks first become visible at **2.0 ft NAVD88**;
- exterior inflow is exactly zero at 2.0 ft;
- source-to-terrain flow begins only above 2.0 ft and is limited by actual
  one-foot interface width, head, gradient, friction, storage, and elapsed time;
- on a falling tide, previously routed terrain water can drain toward the lower
  boundary across the actual connection. The 2.0-ft inflow condition is not a
  two-way wall.

## Failure investigation

The public browser logic was not the cause. `setFloodLayer` creates one Leaflet
image overlay, and the family selector chooses one of seven roots. Replacing
that pull logic with a browser-side solver would increase failure modes and
would violate the storage and latency constraints.

The hydraulic-state generation was the cause. The real graph contains 136,612
finite-storage zones and 914,817 grouped one-foot face/crest records. The six
supplied source polygons rasterize to 113,359 one-foot pixels and 326 source
zones. Their source–terrain interface totals 3,244 one-foot face segments. Most
source ground is near -3.5 ft NAVD88. Treating those pixels as an active tidal
boundary before their stated 2.0-ft condition allowed hours of pre-activation
radial leakage. Treating every downstream face as a broad-crested weir then
moved a microscopic wetting film through connected low terrain much too fast.

At 2.0 ft on this graph:

| Method | Exterior wet footprint | Exterior stored volume | Finding |
| --- | ---: | ---: | --- |
| Connected equilibrium/bathtub | 408.37 acres | 1,825.48 acre-ft | Rejected: no time or continuity limit |
| Prior all-face-weir atlas | 26.70 acres | 36.21 acre-ft | Rejected: source was active below 2.0 ft |
| Diffusive wave without source activation | 26.87 acres | 36.47 acre-ft | Rejected: changing the equation alone does not fix pre-activation leakage |
| V21 selected method | **0.00 acres** | **0.00 acre-ft** | Accept: only the supplied blocks are visible |

For the selected typical rising family, the first 0.1 ft of positive source
head represents eight minutes. At 2.1 ft it has delivered 2.12 acre-ft to 4.57
exterior acres. The additional 15-minute crest hold contains 6.13 acre-ft over
7.92 exterior acres. The largest new connected render patch in that transition
is 2.36 acres, but its farthest new pixel is only 285 ft from prior water. The
solver's conservative 23-minute shared-side travel envelope is 575 ft. This is
a shallow local fringe around a 3,244-ft total interface, not instantaneous
promotion of a remote basin.

## Numerical method

Every node retains the one-foot DEM elevation histogram, so volume and wetted
area vary with water surface instead of assuming a flat 25-ft cell. Ordinary
face discharge uses the US customary Manning wide-sheet form

`Q = (1.486 / n) W h^(5/3) sqrt(|delta eta| / L)`

with `n = 0.12`, `L = 25 ft`, exact grouped one-foot width `W`, upstream depth
above the face crest `h`, and water-surface difference `delta eta`. At a dry
free-overflow face, discharge cannot exceed

`Q = 3.10 W h^(3/2)`.

Transfers are simultaneous at 60-second intervals. Each is bounded by donor
volume, receiver volume below the supplying surface, and two-basin
equalization volume. A newly wetted node cannot donate until the next substep.
A 0.05-ft wetted-depth volume is required before an interior node can transmit,
preventing a microscopic numerical film from advancing a whole control volume.
Internal edge transfers conserve volume to floating-point precision; only the
fixed-head boundary contributes or removes volume.

USACE notes that shallow overland-flow roughness is generally higher than
roughness for appreciable flow depths. Its example NLCD ranges are 0.06–0.12
for low-intensity developed land, 0.08–0.16 for medium-intensity development,
and 0.12–0.20 for high-intensity development. The selected uniform `n = 0.12`
is therefore a conservative uncalibrated urban value. A real-graph sensitivity
run at the first positive head tested `n = 0.08`, `0.12`, and `0.20`, plus
0.01-, 0.05-, and 0.10-ft wet/dry thresholds. Results varied smoothly; source
activation, not numerical roughness tuning, controlled the low-stage failure.

## Compact tide-history representation

The atlas contains 101 stages from 0.0 through 10.0 ft NAVD88 for each of:

- rising slow: 0.55 ft/hr;
- rising typical: 0.79 ft/hr;
- rising fast: 0.90 ft/hr;
- a 15-minute crest hold;
- continuous falling histories from absolute 4.0-, 5.5-, and 8.5-ft crests.

That is 707 depth PNGs and 707 stage-class PNGs. A whole rising limb uses one
family; a falling frame uses the nearest preceding absolute crest. These 1,414
PNGs represent time and hysteresis while keeping storage bounded and avoiding a
new simulation every forecast cycle.

## Verification and visual QA

The release checks require:

- no rendered water below 2.0 ft on rising or crest families;
- the 2.0-ft rising and crest frames equal the supplied source raster exactly;
- identical depth/stage wet masks and no equilibrium/potential color codes;
- distinct rise and recession histories;
- maximum new-water travel within the physical per-frame propagation envelope;
- one-graph-hop maximum movement in the single-source propagation unit test;
- zero storm-drain exchange, preserved 7.5-ft bulkhead, and no crossing below
  that wall crest;
- finite-storage conservation residuals near machine precision;
- visual contact sheets covering all 707 depth frames, followed by satellite
  inspection of the source transition, marsh routes, high stages, and all
  recession families.

The executable benchmark is `tools/benchmark_north_wildwood_methods.py`. The
render audit is `tools/validate_north_wildwood_render_connectivity.py`, and the
all-frame visual sheet builder is `tools/build_north_wildwood_contact_sheets.py`.

## Research basis

- SFINCS subgrid corrections retain subgrid volume, wet fraction, roughness,
  and interface conveyance in continuity and momentum calculations:
  <https://gmd.copernicus.org/articles/18/843/2025/>.
- Bates, Horritt, and Fewtrell describe a reduced local-inertial floodplain
  formulation that retains continuity, pressure gradient, and friction:
  <https://doi.org/10.1016/j.jhydrol.2010.03.027>.
- HEC-RAS uses storage-area/2D connections and hydraulic structures to limit
  transfer through explicit cross sections:
  <https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.4/entering-and-editing-geometric-data/storage-area-and-2d-flow-area-connections>.
- HEC-RAS distinguishes critical/free weir overflow from submerged ordinary
  2D flow:
  <https://www.hec.usace.army.mil/confluence/rasdocs/hgt/latest/guides/modeling-weirs-in-2d-areas>.
- USACE land-cover roughness guidance and shallow-flow caution:
  <https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/6.5/developing-a-terrain-model-and-geospatial-layers/creating-land-cover-mannings-n-values-and-impervious-layers>.
- Gallien et al. demonstrate the importance of time-varying coastal boundary
  forcing and pathways for urban coastal inundation:
  <https://doi.org/10.1016/j.coastaleng.2014.04.007>.

## Limitations

This is a reduced-physics response atlas, not a calibrated event-specific 2D
shallow-water forecast. It omits rainfall, wind stress, waves, infiltration,
storm-drain hydraulics, movable barriers, and spatially varying roughness. The
source polygons and 2.0-ft activation condition are treated as supplied model
inputs, not independently surveyed structures. Observed high-water marks or
street sensors should be used to calibrate roughness and validate recession
storage before the atlas is used for engineering design.
