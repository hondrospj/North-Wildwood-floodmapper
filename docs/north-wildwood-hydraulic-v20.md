# North Wildwood hydraulic v20 determination

> Superseded by [north-wildwood-hydraulic-v21.md](north-wildwood-hydraulic-v21.md).
> This document is retained as the record of the all-face-weir approach that
> exposed the low-stage source-activation failure.

## Failure reproduced

The browser did not route water. It classified each scalar tide entry as
`filling`, `slack`, or `draining`, floored the water level to 0.1 ft, and pulled
one pre-rendered PNG. Hydraulics existed only in the offline v19 atlas.

The one-foot graph contains 136,612 finite-storage zones and 914,817
crest/width edge records. A disjoint-set replay of its static connection logic
found the exact failure described by the user:

| First crest | Opening width at that crest | Area promoted by equilibrium connectivity |
|---:|---:|---:|
| 3.7 ft | 3 ft | 31.38 acres |
| 3.8 ft | 1 ft | 9.23 acres |
| 4.4 ft | 1 ft | 3.20 acres |
| 7.2 ft | 1 ft | 122.99 acres |

At the 7.2-ft threshold, the same zone pair has more width at higher crests,
but only one foot is open at first contact. Static connectivity nevertheless
promoted 5,357,594 ft² immediately. With a 3.10 broad-crested-weir coefficient,
a one-foot opening under one foot of head can pass at most 11,160 ft³ in one
hour before tailwater reduction. Spread over 122.99 acres, that is only 0.025
inches. The prior green `may flood` color displayed the entire equilibrium-
connected lowland even though the routed blue water had not reached it.

V19 had two additional time-history problems:

- Its rising family assumed 0.1 ft every 15 minutes (0.4 ft/hour). The 940
  observed high tides in `observed15min.json` have trough-to-crest rates of
  0.555, 0.786, and 0.904 ft/hour at the 10th, 50th, and 90th percentiles.
  The slow synthetic rise gave water roughly twice as long to enter lowlands.
- Its falling lookup used a moving prior crest of `current stage + 2.5 ft`,
  reset in one-foot bands. Adjacent falling PNGs consequently had large
  artificial state changes at band boundaries.

## Research basis

- Gallien, Sanders, and Flick compared static and hydrodynamic urban coastal
  flooding against observations. The static model substantially overpredicted
  inundation because transient events did not last long enough for inland
  water to equilibrate with shoreline level. This is the North Wildwood failure
  in direct physical terms: [Coastal Engineering 91 (2014), DOI
  10.1016/j.coastaleng.2014.04.007](https://doi.org/10.1016/j.coastaleng.2014.04.007).
- HEC-RAS represents storage areas with an elevation-volume curve and routes
  their exchange through explicit weirs, culverts, gates, or rating curves.
  It does not instantaneously assign the headwater elevation to the entire
  receiving storage area: [HEC-RAS storage-area/2D connections](https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.4/entering-and-editing-geometric-data/storage-area-and-2d-flow-area-connections)
  and [level-pool routing](https://www.hec.usace.army.mil/confluence/rasdocs/ras1dtechref/latest/performing-a-dam-break-study-with-hec-ras/inflow-flood-routing-a-through-reservoir/level-pool-routing).
- Reduced-physics hydrodynamic models retain continuity and momentum rather
  than connectivity alone. The local-inertial formulation is described by
  [Bates, Horritt, and Fewtrell (2010), DOI
  10.1016/j.jhydrol.2010.03.027](https://doi.org/10.1016/j.jhydrol.2010.03.027).
  SFINCS subgrid work likewise computes cell volume and uses volume/water-level
  lookup tables while retaining subgrid conveyance: [GMD 18, 843–861
  (2025)](https://doi.org/10.5194/gmd-18-843-2025).
- Precomputed inundation libraries are an accepted way to avoid real-time
  hydrodynamic runs, but accuracy depends on including hydrograph shape and
  timing rather than only peak stage: [Wang et al. (2022), DOI
  10.1016/j.jhydrol.2022.127735](https://doi.org/10.1016/j.jhydrol.2022.127735)
  and [Bhola, Leandro, and Disse (2018), DOI
  10.3390/geosciences8090346](https://doi.org/10.3390/geosciences8090346).

## Methods screened

1. **Connected bathtub/equilibrium.** Rejected. It has no continuity equation,
   no cross-section capacity, and exactly reproduces the reported whole-basin
   promotion.
2. **Per-tide 2D shallow-water simulation.** Physically strongest when fully
   calibrated, but rejected operationally. It changes the update pipeline,
   must run and publish every tide, and stores many time-step products.
3. **V19 fixed phase atlas.** Conserves routed volume offline and is compact,
   but it loses rise rate and absolute prior crest, and the green potential
   mask visually restores the equilibrium failure.
4. **V20 history-family finite-storage atlas.** Selected. It preserves the
   established one-PNG pull architecture while retaining the two hydrograph
   attributes that control delivered volume: rising duration and preceding
   absolute crest.

## Benchmark

`tools/benchmark_north_wildwood_atlas.py` integrates 60-second bidirectional,
submerged broad-crested-weir flow through the four real narrow-opening/large-
storage cases above. It tests 108 hydrographs (four peaks, three rise rates,
three crest durations, and three fall rates), or 432 opening-event cases.

| Lookup method | Normalized RMSE | Normalized MAE | Max overprediction |
|---|---:|---:|---:|
| Equilibrium stage only | 0.3371 | 0.2038 | 0.7191 |
| V19 stage + generic phase | 0.0884 | 0.0465 | 0.3306 |
| V20 stage + history family | 0.0178 | 0.0122 | 0.0071 |

This is a screening benchmark, not field calibration. It demonstrates that
the selected compact coordinate system preserves cross-section throttling and
hydrograph memory far better than a stage-only or generic-phase lookup.

## Implemented atlas

- Rising families: 0.55, 0.79, and 0.90 ft/hour.
- Turning-point family: typical rising state held for 15 minutes.
- Falling families: continuous recessions from 4.0, 5.5, and 8.5 ft NAVD88.
- 101 stages per family, 0.0–10.0 ft NAVD88, 0.1-ft spacing.
- 707 depth PNGs + 707 stage PNGs; 1,414 total versus v19's 1,326.
- Entire v20 asset bundle: about 61 MB versus v19's 135 MB.
- Dry low terrain is transparent. No green equilibrium/potential code is
  present in any v20 PNG.
- Levels over 10 ft use the previous volume-routed v19 planning assets; they do
  not use equilibrium PNGs.
- Forecast and observed updates perform only scalar hydrograph classification
  and one image pull. Per-cycle physics pointers are disabled.

Fixed-head source polygons are computation-only tidal boundary conditions.
They remain active in the volume and cross-section solve, but are omitted from
the public PNGs and point-query zone grid. The union of finite-storage terrain
wet under the slow, typical, fast, or short-crest histories through 2.0 ft
NAVD88 is also classified as the ordinary-tide/open-water baseline. It remains
active in hydraulic storage and conveyance, but is not painted or returned as land
inundation. Only routed expansion beyond that immutable baseline is displayed.
This prevents a broad hand-drawn source boundary and its normal tidal fringe
from appearing as an instantaneous circular or rectangular low-stage flood.

The state package reports a maximum internal conservation residual of
1.37e-10 ft³. The render validator checked all 1,414 PNGs; depth and stage masks
match, no potential code exists, and the largest connected interior change
between adjacent 0.1-ft frames is 1,150 five-foot pixels (0.66 acre), below the
1.43-acre rejection limit.

## Limits and calibration priority

V20 is physics-based reduced-order routing, not a regulatory engineering model.
Its most important remaining uncertainties are DEM/structure accuracy,
unmodeled storm-drain hydraulics, surface roughness, and the uncalibrated 3.10
weir coefficient. The next scientific improvement should use observed street
arrival times and high-water extents to calibrate conductance and validate the
three rising/three recession families. That calibration can replace the atlas
without changing the production pull architecture.
