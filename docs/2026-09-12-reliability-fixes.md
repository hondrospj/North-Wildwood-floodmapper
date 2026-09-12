# FloodMapper reliability and observation-quality fixes

This change addresses the September 12, 2026 audit. It preserves raw municipal observations, the published hydraulic catalog, and the existing published projection/return-interval estimates. It rebuilds the displayed observation composite and its calendar/year shards using explicit source and quality metadata.

## Display and browser behavior

- Null, empty, boolean, and nonfinite water levels remain unavailable instead of becoming 0 ft.
- Selecting a frame clears the previous flood layer, including its 3D texture. Missing images, failed bounds, and failed downloads produce an explicit, persistent status. Current-selection exports and point-depth popups require a valid frame.
- Fractional filling colors use the same adjusted local water surface as queried filling depth. A shallow feeder range is reported only when its rendered color establishes that range. A pooled or history-preserved pixel without a valid point-depth estimate reports N/A.
- Failed image and catalog lookups are evicted. Reload clears dependent image/archive caches, and superseded requests cannot restore old records or change the newest selected date/mode. JSON and image requests have bounded waits.
- NWS alerts refresh at startup, on Reload, and every five minutes independently of tide-history loading. Unavailable and stale results remain distinct from no alerts; failures preserve the last successful alert report and still attempt configured zones.
- The desktop sidebar has one scrolling policy. The conflicting desktop writer was removed from the mobile correction script.
- 3D readiness is committed after building initialization. Failed dependencies are removed and retried, with bounded waits; failed startup restores the 2D visibility class.

## Observation policy

The policy identifier is `north-wildwood-observation-quality-v1`. These screening rules identify records needing review; they do not establish that Stone Harbor always represents the correct North Wildwood elevation and do not apply a new station bias correction.

City observations receive priority only inside coverage that passes the existing annual comparison review **and** a UTC-day comparison screen: at least 48 paired quarter hours, absolute median difference no greater than 0.75 ft, and correlation at least 0.9. Flat comparisons cannot pass. Missing comparisons, flagged years/days, and observations outside screened coverage use the labeled Stone Harbor fallback or remain unavailable. A later calibration review can change the accepted data; raw city files are preserved.

The city normalizer excludes bounded single- and multiple-sample excursions. Offset-free local timestamps in repeated autumn hours or nonexistent spring hours are excluded from time-aligned analysis; offset-bearing timestamps preserve distinct instants. The comparison builder and municipal viewer share one JavaScript time converter. The viewer retains ambiguous raw rows and labels them.

New interpolation is limited to 30 minutes. Each compact day carries aligned per-sample arrays:

| Field | Meaning |
| --- | --- |
| `s` | `N`: North Wildwood city; `S`: Stone Harbor; `-`: unavailable |
| `q` | `M`: exact source timestamp; `I`: short interpolation; `C`: calibrated storm replay; `U`: unknown legacy sampling provenance; `-`: unavailable |
| `g` | Interpolation bracket in seconds; zero for exact timestamps; null when unknown/unavailable |

Exact source timestamps may be deduplicated municipal measurements. Quality codes describe sampling and processing; they do not certify instrument calibration. Rebuilt archives retain source-file and quality-code hashes. Scheduled publishers validate the compact arrays and peak/source counts before committing.

The legacy Stone Harbor archive cannot reveal which older entries were interpolated across long gaps. Those entries retain unknown sampling provenance instead of being relabeled as measured. The UI displays that limitation. Reconstructing those flags requires a source backfill, not an invented mask.

## Analytical rebuilds

New event-frequency and return-interval builds require quality-qualified water years with at least 99% quarter-hour coverage and no gap exceeding six hours. A partial continuous year cannot silently enter the annual-maxima fit. The maximum's station comes from its actual sample, not from whether its day contains any city data. Official annual crest records remain distinct from continuous-record exposure.

Event-frequency uncertainty resamples eligible water-year blocks. Reported exposure sums qualified samples rather than counting omitted years between the first and last events. Trend-station metadata also comes from qualified samples instead of the composite archive's headline station.

The trend fit requires a single-station series. Daily means need at least 90% of UTC quarter-hour samples, monthly means need at least 90% of eligible days, and at least 24 eligible months are required. A nonpositive fitted trend stops projection publication for review; it is not changed to a positive number. The rebasing formula remains:

`level_2026 = observed_level + trend_ft_per_year * (2026 - observation_year)`

Projection output records its observation and trend source hashes, fit coverage, and quality-policy version. Its event archive dates describe the eligible exposure used in the fit. The existing published projection panel identifies its older Stone Harbor basis, August 15, 2026 observation end, and August 16 generation date. It is not claimed to be recalculated from the new composite.

Before producing replacement analytical estimates, backfill source sampling provenance and review the calibration/station-transfer policy. A typical sequence, in the configured geospatial environment, is:

```sh
python tools/update_observed_15min.py --full --output stone_harbor_observed15min.json --no-update-hourly
node tools/build_north_wildwood_stone_harbor_comparison.mjs
python tools/merge_north_wildwood_city_gauge.py
python tools/validate_observed_contract.py
python tools/build_observed_archive_shards.py
```

Then use `--trend-observed stone_harbor_observed15min.json` when building parcel analytics from the qualified composite, and inspect the reported coverage and fitted trend before publishing derived assets. A failed gate leaves the previous analytical artifact intact. The screening thresholds are conservative operational defaults, not an independent validation of parcel-scale flooding or a new calibration of either gauge.

## Optional model and legacy tools

- Graph edge crest encoding now allocates ten bits, preserving the complete −10 to +20 ft range. Mask reads check CRS/geotransform and treat nodata as inactive.
- Terrain caches require matching configuration, builder, input, tile, and output hashes. `--force` rebuilds terrain. Spatial lookup keys include mesh coordinates, transform, CRS, and crop bounds.
- First-arrival time survives drying and rewetting.
- The legacy rising benchmark samples storage at the crest instead of at the end of the recession.

## Verification

New tests exercise missing stages, color/query depth agreement, stale frames, failed-cache recovery, alert outages, date races, DST ambiguity, quality screening, interpolation limits, trend/annual exposure, C++ crest round trips and raster alignment, 3D recovery, and cache/arrival behavior. The layout test runs actual page styles and both original layout scripts. CI also runs the existing browser/scientific contracts and validates generated observations.

Local verification on September 12, 2026:

- All 16 pre-existing test/check entrypoints passed with the explicit sparse-catalog exception below. Added regressions passed, including 13 observation-quality cases and three cache/arrival cases. The compiled C++ test checked all 301 crest codes and real GDAL mask rasters.
- The complete page loaded and recovered from deliberately failed images on desktop (1440 × 1000) and mobile (390 × 844), with zero JavaScript errors. Missing stages cleared both the 2D layer and 3D flood texture. Observation and projection notices were visually inspected at both sizes.
- Idle sidebar style mutations were zero after settling, compared with 109 in the original isolated reproduction.
- Rebuilt year shards exactly reconstruct the compact archive, all source hashes match, and both raw source archives remain unchanged. Screening changes 27,438 quarter-hour values. At 2026-04-19 02:30 UTC, the flagged city value of 0.70 ft NAVD88 is replaced with the explicitly labeled 3.78-ft Stone Harbor fallback; this is a source substitution, not proof of the actual North Wildwood height.

For a sparse checkout, `FLOODMAPPER_SKIP_CATALOG_FILES=1` runs the browser code contracts while explicitly skipping the untouched flood-catalog directory-presence checks. The default CI check does not skip them. This change does not claim a fresh terrain build, verification of every rendered flood PNG, an ANUGA forecast simulation, or independent street-flood calibration.

The large inline page and empirical flood-model assumptions still merit later modularization and independent calibration. This patch repairs the reproduced defects and adds publication guards; it does not treat a passing code test as validation of parcel-scale inundation.
