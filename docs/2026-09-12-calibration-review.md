# Source backfill and calibration review

The reviewed deployment restores sampling provenance from the original observations. It retains the city-quality gates and labeled Stone Harbor fallback. The review does **not** approve a single continuous-sample bias correction or a replacement projection/return-interval fit.

## Source review

The complete Stone Harbor continuous record was retrieved from USGS station 01411360, parameter 72279, for October 1, 2007 through September 12, 2026. The cached responses contain 1,612,642 unique cleaned measurements. The rebuilt archive covers 6,922 local days. The agency lists continuous coverage from October 2007; earlier daily records do not establish an earlier continuous series. [USGS station record](https://waterdata.usgs.gov/monitoring-location/USGS-01411360/).

The municipal endpoint was refreshed for every year from 2017 through 2026. It returned the same 1,313,044 source rows, ending August 20, 2026 at 19:31:07 local time. The refresh provides no later measurement or evidence resolving the flagged 2026 disagreement.

The datum conversion remains North Wildwood NAVD88 = MLLW − 2.75 ft, as specified by the city OEM. This datum conversion is distinct from transferring heights between gauges. [City datum reference](https://ready.northwildwood.com/wp-content/uploads/2021/02/2021-OEM-NGVD88-MLLW-reference-1.pdf).

Original USGS responses, request URLs, retrieval times, hashes, and agency qualifiers were retained in the local backfill audit. The overlapping response chunks contain 549 estimated-value flags and one revised-record flag; approved and provisional status remain distinguishable in those source responses. Compact M/I flags describe exact timestamps and short interpolation, not agency approval or independent instrument calibration. The calibrated Jonas replay remains separately marked C.

## Recovered-method calibration

Original-level city and Stone Harbor crests were re-extracted within the previously used astronomical cycle windows, requiring at least 90% hourly coverage, complete central six-hour coverage, and a peak away from the cycle boundary. Predictions establish timing only. No sea-level trend was added or removed during spatial calibration.

The comparison uses 5,400 accepted paired high tides. Median offset, affine regression, mean/variance scaling, and quantile mapping were compared using leave-one-calendar-year-out folds with at least 300 held-out tides. Selection minimizes mean absolute exceedance-rate error across 3.25, 4.25, and 5.25 ft NAVD88, then crest RMSE.

The selected candidate is **Stone Harbor − 0.22 ft**, matching the earlier original-level crest fit. Its mean held-out threshold-rate error is 0.459 percentage points, and its mean held-out crest RMSE is 0.094 ft. These scores apply to comparison-screened city intervals and are not an independent assessment of sensor accuracy.

There are important limits:

- The maximum paired city crest is 5.11 ft NAVD88. No pair reaches the 5.25-ft major threshold, so major and extreme transfers remain extrapolations.
- Annual median crest differences are approximately −0.10 to −0.11 ft in 2018–2020 and −0.24 to −0.27 ft in 2021–2025. One pooled correction does not resolve that change.
- The 2026 comparison still has a median discrepancy near −3.09 ft and correlation 0.634. Those intervals remain excluded from city priority.

The statistical results do not identify whether the changes arose from sensor calibration, reference elevation, local hydraulics, or another cause. A dated calibration/leveling record or independent colocated reference is needed before approving a physical correction. No municipal records were automatically shifted by three feet, and the crest-only −0.22-ft candidate was not applied to every continuous sample.

The later 2026 values still track tidal shape: May, July, and August each have monthly correlation above 0.998, while their median differences are −3.13 to −3.15 ft. This is consistent with a level-reference change, but does not establish its cause or magnitude. Simply adding 2.75 ft would still leave a −0.38 to −0.40-ft difference, compared with approximately −0.22 ft in late 2025. The calibration review therefore calls for a dated reference check around the spring 2026 transitions rather than treating the entire discrepancy as a proven datum conversion.

## Trend and exposure review

Coverage-qualified monthly means with calendar-month effects and HAC(12) uncertainty give Stone Harbor a trend of **+4.18 mm/year**, with a 95% interval of +1.71 to +6.65 mm/year, over 203 eligible months from October 2007 to August 2026. This is a review estimate, not a new published projection parameter.

The screened city record gives −0.33 mm/year over 80 eligible months. Adding a 2021 epoch term changes that estimate to +11.15 mm/year with a −0.223-ft epoch offset; uncertainty is broad in both cases. This sensitivity prevents interpreting the simple city slope as a reliable physical sea-level trend. Neither slope is forced positive.

Under the existing 99%-coverage/six-hour-gap rule, only water years 2017–2024 pass continuous-exposure checks. The 2025 archive contains a 15.75-hour gap; 2026 is incomplete. Earlier years fail for documented gaps, even where total coverage exceeds 99%. These gaps are not filled or reclassified as complete years.

The backfilled compact archive has no unknown legacy sampling flags. Both the hourly companion and year shards are regenerated from the complete reviewed composite so that pre-city days cannot retain the old sampling treatment. Existing published projection and return-interval values remain labeled with their prior basis until station transfer and analytical exposure are resolved.
