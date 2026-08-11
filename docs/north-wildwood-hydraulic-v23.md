# North Wildwood hydraulic atlas v23

## Determination

The 2.0-ft NAVD88 source must be the complete low-elevation tidal body, not a
collection of user-drawn circles and not one sampled pixel per display cell.
V23 therefore defines source water by the conditioned DEM alone: the single
four-neighbour component at or below 2.0 ft NAVD88 that touches the exterior
DEM boundary. A 101-cell minimum rejects noise. The six manual polygons remain
in the provenance manifest, but cannot create or qualify source water.

This gives one genuine source component with 17,452,983 one-foot cells
(400.665 acres), 45,424 isolated fixed-head zones, and 110,487 one-foot
source–terrain exchange faces. It removes the three tiny polygon-shaped
components and the separate southern internal basin admitted by v22.

The browser contract is unchanged. It still selects one of seven history
families and one 0.1-ft stage PNG; it does not run a new tide simulation or
store tide-cycle permutations.

## Physics and finite conveyance

The solver retains one-foot terrain histograms inside 25-ft finite-volume
nodes. Ordinary discharge uses the US customary Manning wide-sheet relation

`Q = (1.486 / n) W h^(5/3) sqrt(|delta eta| / L)`

with `n = 0.12`, grouped one-foot interface width `W`, hydraulic depth `h`, and
water-surface gradient over `L = 25 ft`. Dry free overflow is limited by

`Q = 3.10 W h^(3/2)`.

Transfers occur simultaneously in 60-second substeps and are limited by donor
storage, receiver capacity, equalization volume, and the measured shared-face
cross section. Newly wet nodes cannot donate until a later substep and must
store a 0.05-ft mobile depth. These rules are what prevent one connected cell
from instantaneously filling a large below-grade basin.

The method benchmark rejects equilibrium connectivity because it has no time
or cross-section constraint, and rejects broad-crested-weir routing on every
ordinary face because it omits friction and path length. The selected hybrid
uses Manning diffusive routing on ordinary faces and a weir cap only for true
dry free overflow. On the real graph it produces:

- zero exterior terrain volume at 2.0 and 2.1 ft;
- 0.674865 acre-ft of exterior stored water at 2.2 ft during the typical rise;
- a 26.857805-acre wet terrain control-volume footprint at 2.2 ft;
- 6.484e-14 ft3 maximum internal conservation residual in the low-stage test.

The committed executable report is
`north-wildwood-hydraulic-v23-benchmark.json`.

## Area-preserving display

The former renderer chose the center one-foot sample from every 5-by-5 block.
That made a complete 2.0-ft source look perforated or cell-like and could omit
thin channels. V23 writes one compact 42-byte summary for every five-foot
display cell. Each summary retains:

- exact source count and source ground-elevation sums;
- the exact positive-depth source count at 2.0 ft;
- the two dominant terrain-zone counts, ground means, and ground ranges;
- valid and omitted subcell counts.

The two terrain slots represent all but 2,077 of 43,518,086 terrain subcells
(0.00477%). Every source subcell is exact. Wet fraction is encoded with four
alpha levels, so edge cells no longer appear as solid five-foot blocks. Depth
is area-weighted and display-smoothed only inside the immutable wet footprint;
smoothing cannot create water.

At exactly 2.0 ft, all source cells below the 2.0-ft contour contribute and the
zero-depth contour remains transparent: 17,137,183 one-foot cells, or 393.416
acres, are visible. At 2.1 ft the complete 400.665-acre source footprint is
eligible. Exterior water still comes only from the finite-volume solve.

## Compact deployment

The release contains 707 depth and 707 stage PNGs: 101 stages for each of three
rising rates, a crest hold, and three recession histories. The atlas is about
129 MB and its complete seven-family hydraulic state package compresses to
17.0 MB. Thus history and hysteresis remain represented without millions of
PNGs or per-tide server simulations.

## Verification

The v23 release passed:

- one exterior-connected source component and no fixed-head/terrain mixed zone;
- 707/707 depth and 707/707 stage frames with identical wet masks;
- exact area-aggregated 2.0-ft source agreement and zero exterior terrain;
- maximum connected adjacent-stage terrain addition of 524 five-foot pixels
  (0.30 acre);
- maximum new-water arrival of 59 five-foot pixels (295 ft), below the
  115-pixel (575-ft) transition envelope;
- maximum full-atlas conservation residual of 7.549e-11 ft3;
- 21-cell, 7.5-ft NAVD88 bulkhead preservation and disabled storm drains;
- visual inspection of all 707 depth states in seven contact sheets and
  satellite inspection at 2.0, 2.1, 2.2, 2.3, 3.0, 4.0, 5.0, and 7.0 ft.

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
