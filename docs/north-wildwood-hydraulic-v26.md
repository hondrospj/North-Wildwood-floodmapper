# North Wildwood hydraulic atlas v26

## Determination

The remaining geometry defect was not CDN caching. The live dashboard was
loading v25, but v25 exposed two model artifacts:

1. Its 25-foot finite volumes were visibly imprinted on the five-foot public
   raster as regular blocks and checkerboard edges.
2. It defined source from only the literal <=2.0-foot DEM cells. Valid
   above-threshold pockets wholly enclosed by that tidal field remained
   ordinary terrain, producing the offshore circles, triangles, and marsh
   rings visible at high tide.

V26 keeps the mass-conserving, history-aware diffusive-wave method and changes
the spatial representation. Terrain storage is resolved on ten-foot tiles,
each source component is one fixed-head node, and every one-foot perimeter
face and crest remains explicit. The complete source footprint is formed from
the two qualified four-neighbour <=2.0-foot components and all valid complement
pockets that cannot reach the raster or nodata exterior. The exterior-connected
city landmass remains finite storage.

## Resolution tests

The real 61,749,200-cell North Wildwood DEM was rebuilt and routed at candidate
resolutions before the publication solve.

| Candidate | Zones | Finding |
| --- | ---: | --- |
| 25-ft / 2-ft connection bins | 145,842 | Compact, but the computational mesh is visible in the overlay. |
| 10-ft / 0.5-ft connection bins | 987,591 | Fine geometry, but unnecessary elevation splitting produces a 2.5-GB working graph and omits 205,322 subcells from the two-slot renderer. |
| 10-ft / 2-ft connection bins | 500,245 before source fill | Fine geometry with only 2,910 omitted render subcells. |
| Selected v26 | 484,551 | Ten-foot terrain, two source nodes, filled source enclaves, 2,900 omitted render subcells. |

The 0.5-foot connection-bin candidate was rejected because it increased state
and graph size without a commensurate visible improvement. The selected
ten-foot/two-foot-bin grid is the smallest practical atlas mesh that removes
the 25-foot signature while retaining the existing five-foot renderer and
compact Bunny object count.

## Source and flux contract

- The initial two <=2.0-foot fields contain 18,230,034 one-foot cells.
- Their 158 enclosed valid terrain components contain 1,326,836 cells
  (30.460 acres) and are filled into the source footprint.
- The final complete source footprint contains 19,556,870 cells
  (448.964 acres) represented by exactly two fixed-head source nodes.
- The source is hydraulic forcing only and is never painted in public depth or
  stage images.
- Source and terrain exchange through 10,111 grouped edge records retaining
  66,088 one-foot face segments. No source and terrain cell share a node.
- At exactly 2.0 feet NAVD88, rising and crest frames are transparent and
  exterior terrain storage is zero.
- Ordinary terrain flow remains Manning diffusive-wave conveyance with a
  free-overflow weir capacity bound, donor/receiver/equalization caps, a
  0.05-foot mobile-depth threshold, and 60-second wetting steps.

## Compact publication

The browser contract is unchanged: it selects one of seven precomputed history
families and one 0.1-foot stage image. V26 still publishes 707 depth and 707
stage PNGs, not tide-cycle permutations. The 685,160,912-byte raw state matrix
compresses to 43,215,513 bytes; the complete Bunny payload is 129,564,423
bytes across 1,418 objects. Overlay paths are versioned under `/v26/`, so no
purge or unversioned CDN overwrite is required.

## Verification

The feature/state validator passed with:

- graph schema v10 and state schema v13;
- 484,551 zones and exactly two source zones;
- 174,993 conditioned bulkhead pixels, all at or above 7.5 feet NAVD88;
- no storm-drain exchange or mixed source/terrain node;
- maximum internal mass residual `6.548361852765083e-10 ft³`.

The render validator scanned all 1,414 public frames and passed. Source-only
cells never render, the 2.0-foot rising/crest frames are transparent, and the
maximum adjacent-frame new-water distance is 32 five-foot pixels against the
ten-foot mesh's 46-pixel physical travel envelope. The largest connected
adjacent-frame addition is 215 five-foot pixels.

The exact 7.5-foot crest frame was also inspected over the street/base map. It
has no offshore source-enclave blob, no circular marsh rings, and no visible
25-foot checkerboard.
