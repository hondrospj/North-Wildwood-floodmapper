# North Wildwood hydraulic atlas source-field correction

## Determination

The remaining geometry defect was not CDN caching. The live dashboard was
loading v25, but v25 exposed two model artifacts:

1. Its 25-foot finite volumes were visibly imprinted on the five-foot public
   raster as regular blocks and checkerboard edges.
2. The hydraulic forcing correctly used only literal <=2.0-foot cells, but the
   public raster hid the entire source field. Painting it later exposed valid
   above-threshold DEM artifacts as offshore circles and triangles.

V26 keeps the mass-conserving, history-aware diffusive-wave method and changes
the spatial representation. Terrain storage is resolved on ten-foot tiles,
each source component is one fixed-head node, and every one-foot perimeter
face and crest remains explicit. Hydraulic forcing contains only the two
qualified four-neighbour <=2.0-foot components. The public display follows the
Stone Harbor contract by showing that complete field and visually filling only
its enclosed raster artifacts. Those fills never become forcing; the
exterior-connected city landmass remains finite storage.

## Resolution tests

The real 61,749,200-cell North Wildwood DEM was rebuilt and routed at candidate
resolutions before the publication solve.

| Candidate | Zones | Finding |
| --- | ---: | --- |
| 25-ft / 2-ft connection bins | 145,842 | Compact, but the computational mesh is visible in the overlay. |
| 10-ft / 0.5-ft connection bins | 987,591 | Fine geometry, but unnecessary elevation splitting produces a 2.5-GB working graph and omits 205,322 subcells from the two-slot renderer. |
| 10-ft / 2-ft connection bins | 500,245 | Selected ten-foot terrain, two source nodes, 2,900 omitted render subcells. |

The 0.5-foot connection-bin candidate was rejected because it increased state
and graph size without a commensurate visible improvement. The selected
ten-foot/two-foot-bin grid is the smallest practical atlas mesh that removes
the 25-foot signature while retaining the existing five-foot renderer and
compact Bunny object count.

## Source and flux contract

- The initial two <=2.0-foot fields contain 18,230,034 one-foot cells.
- Their enclosed higher-DEM display artifacts contain 1,326,836 cells. Those
  cells remain finite-storage terrain and never become boundary forcing.
- Exactly two fixed-head source nodes represent the 18,230,034 qualified low
  cells. The public image fills the enclosed artifacts only to present the
  complete two-foot field without offshore circles or triangles.
- The complete source field is visible in public depth and stage images from
  2.0 ft NAVD88 upward.
- Source and terrain exchange through 10,111 grouped edge records retaining
  66,088 one-foot face segments. No source and terrain cell share a node.
- At exactly 2.0 feet NAVD88, every five-foot bin in the complete visible
  source field is present; expansion beyond it still requires routed volume.
- Ordinary terrain flow remains Manning diffusive-wave conveyance with a
  free-overflow weir capacity bound, donor/receiver/equalization caps, a
  0.05-foot mobile-depth threshold, and 60-second wetting steps.

## Compact publication

The browser contract is unchanged: it selects one of seven precomputed history
families and one 0.1-foot stage image, plus one stored five-high-tide historical
maximum. It publishes 708 depth and 708 stage PNGs, not tide-cycle
permutations. The corrected catalog is published under `/v28/` with the
`20260811-hydraulic-v28-source-field` cache version.

## Verification

The feature/state validator passed with:

- graph schema v11 and state schema v14;
- 500,245 zones and exactly two source zones;
- 174,993 conditioned bulkhead pixels, all at or above 7.5 feet NAVD88;
- no storm-drain exchange or mixed source/terrain node;
- maximum internal mass residual `6.548361852765083e-10 ft³`.

The render validator scanned all 1,416 public frames and passed. Every complete
source-field bin renders from 2.0 ft upward; enclosed display fills never become
forcing. The maximum adjacent-frame new-water distance beyond that field is 32
five-foot pixels against the ten-foot mesh's 46-pixel physical travel envelope.
The largest connected adjacent-frame addition is 215 five-foot pixels.

The exact 7.5-foot crest frame was also inspected over the street/base map. It
has no offshore source-enclave blob, no circular marsh rings, and no visible
25-foot checkerboard.
