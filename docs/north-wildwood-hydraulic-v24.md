# North Wildwood hydraulic atlas v24

## Determination

The 2.0-ft NAVD88 boundary is the complete low-elevation tidal field, not a
drawn circle and not only the low body that happens to touch the raster edge.
Component measurement found two authentic tidal fields: 17,452,983 one-foot
cells (400.665 acres) and 777,051 cells (17.839 acres). The smaller field is
separated from the outer DEM edge by domain nodata but intersects the supplied
tidal marker. V23 incorrectly removed it together with the marker artifacts.

V24 qualifies a complete four-neighbour component at or below 2.0 ft only when
it contains at least 43,560 cells (one acre) and either touches the exterior DEM
boundary or intersects a supplied tidal marker. The marker only identifies a
component; its geometry is never painted. This selects exactly the two tidal
fields while rejecting three marked artifacts of 0.012, 0.007, and 0.006 acre.
Unmarked 2.396- and 1.756-acre inland depressions remain finite terrain.

The resulting boundary contains 18,230,034 one-foot cells (418.504 acres),
47,436 isolated fixed-head zones, and 116,536 one-foot source–terrain exchange
faces. The browser still pulls one of seven precomputed history families and
one 0.1-ft stage PNG; it does not rerun hydraulics for each tide.

## Physics and finite conveyance

The solver retains one-foot terrain histograms inside 25-ft finite-volume
nodes. Ordinary discharge uses the US customary Manning wide-sheet relation

`Q = (1.486 / n) W h^(5/3) sqrt(|delta eta| / L)`

with `n = 0.12`, grouped one-foot interface width `W`, hydraulic depth `h`, and
water-surface gradient over `L = 25 ft`. Dry free overflow is limited by

`Q = 3.10 W h^(3/2)`.

Transfers occur simultaneously in 60-second substeps and are limited by donor
storage, receiver capacity, equalization volume, and measured shared-face cross
section. Newly wet nodes cannot donate until a later substep and must store a
0.05-ft mobile depth. These constraints prevent one connected cell from
instantaneously equalizing a large below-grade basin.

On the real v24 graph, the selected activated hybrid method produces:

- zero exterior terrain volume at 2.0 and 2.1 ft;
- 0.704237 acre-ft of exterior stored water at 2.2 ft during the typical rise;
- a 28.856703-acre wet terrain control-volume footprint at 2.2 ft;
- 4.574e-14 ft3 maximum internal conservation residual in the low-stage test.

The executable report is `north-wildwood-hydraulic-v24-benchmark.json`.

## Complete source display

Every five-foot display cell area-aggregates all 25 underlying one-foot cells.
The v24 summary is 37 bytes and retains exact source area and elevation sums,
two dominant terrain nodes, their subcell counts and elevation ranges, and
valid/omitted counts. The two terrain slots omit only 2,077 of 43,518,086
terrain subcells (0.00477%); every source subcell is exact.

At exactly 2.0 ft, the entire 418.504-acre qualified source appears. Literal
2.0-ft contour cells use the 0.05-ft minimum display depth so the fixed-head
boundary is legible, but this cartographic treatment adds no exterior terrain
volume and cannot wet a cell outside the two source components. Fractional
five-foot edge coverage remains encoded in alpha.

## Compact deployment and verification

The release contains 707 depth and 707 stage PNGs: 101 stages for three rising
rates, a crest hold, and three recession histories. The committed atlas is
about 138 MB and the seven-family state package is 18,316,901 gzip bytes. No
tide-cycle permutations or equilibrium/bathtub images are stored.

The v24 release passed:

- exactly two qualified source components and no fixed-head/terrain mixed zone;
- exact full-source agreement in every 2.0-ft rising/crest frame;
- zero exterior terrain at 2.0 and 2.1 ft;
- 707/707 depth and 707/707 stage frames with identical wet masks;
- maximum adjacent-frame arrival of 59 five-foot pixels (295 ft), below the
  115-pixel (575-ft) travel envelope;
- maximum connected adjacent-stage addition of 524 five-foot pixels;
- maximum full-atlas conservation residual of 9.049e-11 ft3;
- preservation of the 21-cell, 7.5-ft bulkhead and disabled storm drains;
- visual review of all 707 depth states in contact sheets and satellite review
  at 2.0, 2.2, 3.0, 4.0, and 5.0 ft.

## Research basis and limitations

- SFINCS subgrid corrections retain subgrid storage, wet fraction, roughness,
  and interface conveyance: <https://gmd.copernicus.org/articles/18/843/2025/>.
- Bates, Horritt, and Fewtrell retain continuity, water-surface gradient, and
  friction in a reduced local-inertial method:
  <https://doi.org/10.1016/j.jhydrol.2010.03.027>.
- HEC-RAS storage-area/2D connections route through an explicit cross section:
  <https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.4/entering-and-editing-geometric-data/storage-area-and-2d-flow-area-connections>.
- HEC-RAS distinguishes true free weir overflow from submerged ordinary 2D
  flow: <https://www.hec.usace.army.mil/confluence/rasdocs/hgt/latest/guides/modeling-weirs-in-2d-areas>.
- Gallien et al. demonstrate the importance of time-varying coastal forcing and
  pathway timing: <https://doi.org/10.1016/j.coastaleng.2014.04.007>.

This remains a reduced-physics response atlas rather than a calibrated,
event-specific two-dimensional shallow-water forecast. It omits rainfall, wave
setup, wind stress, infiltration, storm-drain hydraulics, and spatially varying
roughness. High-water marks or street sensors are required before engineering
design use.
