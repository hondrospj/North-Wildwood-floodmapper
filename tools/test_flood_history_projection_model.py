#!/usr/bin/env python3
"""Executable contract checks for parcel flood-history projections."""

from __future__ import annotations

import math
import json
import tempfile
from pathlib import Path

import build_parcel_alerts as model


def synthetic_slr_payload() -> dict:
    rows = []
    multipliers = {
        "Low": 0.7,
        "Intermediate-Low": 0.9,
        "Intermediate": 1.2,
        "Intermediate-High": 1.6,
        "High": 2.1,
    }
    for scenario, multiplier in multipliers.items():
        for year in (2020, 2030, 2050, 2070, 2100):
            x = year - model.CURRENT_YEAR
            rows.append(
                {
                    "scenario": scenario,
                    "projectionYear": year,
                    "projectionRsl": (20.0 + multiplier * (0.12 * x + 0.003 * x * x)) * 30.48,
                }
            )
    return {"SlrProjections": rows}


assert len(model.ELEVATION_GRID_FT) == 201
assert model.ELEVATION_GRID_FT[0] == 0.0
assert model.ELEVATION_GRID_FT[-1] == 20.0
assert all(
    math.isclose(float(right - left), 0.1, abs_tol=1e-9)
    for left, right in zip(model.ELEVATION_GRID_FT, model.ELEVATION_GRID_FT[1:])
)

deltas, metadata = model.fit_quadratic_slr_deltas(synthetic_slr_payload(), 0.02)
assert list(deltas) == [
    "observedTrend",
    "low",
    "intermediateLow",
    "intermediate",
    "intermediateHigh",
    "high",
]
assert all(len(values) == len(model.YEARS) for values in deltas.values())
assert all(values[0] == 0.0 for values in deltas.values())
assert metadata["intermediate"]["type"] == "quadratic"
assert math.isclose(deltas["observedTrend"][-1], 1.48, abs_tol=1e-9)

historic_peaks = [1.0, 1.1, 1.1001, 1.2]
assert model.historic_flood_count(historic_peaks, 1.0) == 2
assert model.historic_flood_count([1.1], 1.0) == 0

peaks = [1.0, 2.0, 3.0, 4.0]
events = [
    {"year": 2024, "rebasedNavd88Ft": 1.0},
    {"year": 2024, "rebasedNavd88Ft": 2.0},
    {"year": 2025, "rebasedNavd88Ft": 3.0},
    {"year": 2025, "rebasedNavd88Ft": 4.0},
]
thresholds = model.np.asarray([[3.0, 2.5, 2.0]], dtype=float)
estimate, lower95, upper95, fit = model.fit_continuous_exceedance_cdf(
    peaks, events, [thresholds]
)
curve = estimate[0][0]
assert curve[0] < curve[1] < curve[2]
assert 0.3 < curve[0] < 0.5
assert lower95[0].shape == thresholds.shape
assert upper95[0].shape == thresholds.shape
assert fit["type"] == "continuous Gaussian-kernel CDF"
assert fit["bootstrapReplicates"] == model.KDE_BOOTSTRAP_REPLICATES

# Accepted water years, including nonadjacent years, are whole bootstrap blocks.
water_events = [dict(event, waterYear=2020 if i < 2 else 2022) for i, event in enumerate(events)]
_, _, _, water_fit = model.fit_continuous_exceedance_cdf(peaks, water_events, [thresholds])
assert water_fit["bootstrapBlockCount"] == 2
assert water_fit["uncertaintyMethod"].startswith("water-year")

# Refreshing analytics must update the same first-floor grid threshold used by
# the NSI join, together with the coverage dates and original ground count.
with tempfile.TemporaryDirectory() as directory:
    parcel_path = Path(directory) / "parcels.geojson"
    original = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {
                "elevationNavd88Ft": 5.98,
                "nsi2026ModeledFirstFloorNavd88Ft": 6.48,
                "nsi2026ModelElevationIndex": 99,
                "nsi2026HistoricFirstFloorExceedanceCount": 99,
            }},
            {"type": "Feature", "properties": {"elevationNavd88Ft": 2.0}},
            {"type": "Feature", "properties": {
                "elevationNavd88Ft": 10.0,
                "nsi2026ModeledFirstFloorNavd88Ft": 25.0,
                "nsi2026HistoricFirstFloorExceedanceCount": 99,
            }},
        ],
    }
    parcel_path.write_text(json.dumps(original))
    refreshed_cdf = {
        "observedArchive": {"startDate": "2020-01-01", "endDate": "2026-11-02"},
        "elevationGridFtNavd88": [0.0, 3.0, 6.4, 6.5, 20.0],
        "historicFloodEventCountByElevation": [4, 4, 2, 1, 0],
    }
    refresh_events = [{"navd88Ft": level} for level in [6.49, 6.51, 6.6, 6.7]]
    assert model.refresh_existing_parcel_counts(parcel_path, refresh_events, refreshed_cdf) == 3
    refreshed = json.loads(parcel_path.read_text())["features"]
    floor = refreshed[0]["properties"]
    assert floor["nsi2026HistoricFirstFloorExceedanceCount"] == 1
    assert floor["nsi2026ModelElevationIndex"] == 3
    assert floor["nsi2026ModelElevationNavd88Ft"] == 6.5
    assert floor["historicFloodEventCount"] == 4
    assert floor["historicStartDate"] == "2020-01-01"
    assert floor["historicEndDate"] == "2026-11-02"
    assert "nsi2026HistoricFirstFloorExceedanceCount" not in refreshed[1]["properties"]
    assert refreshed[1]["properties"]["historicFloodEventCount"] == 4
    high_floor = refreshed[2]["properties"]
    assert high_floor["nsi2026ModelElevationIndex"] == 4
    assert high_floor["nsi2026ModelElevationNavd88Ft"] == 20.0
    assert high_floor["nsi2026HistoricFirstFloorExceedanceCount"] == 0
    stable_bytes = parcel_path.read_bytes()
    model.refresh_existing_parcel_counts(parcel_path, refresh_events, refreshed_cdf)
    assert parcel_path.read_bytes() == stable_bytes
    # An incomplete replacement CDF must not overwrite a usable parcel file.
    incomplete_cdf = {**refreshed_cdf, "historicFloodEventCountByElevation": []}
    try:
        model.refresh_existing_parcel_counts(parcel_path, refresh_events, incomplete_cdf)
    except ValueError:
        pass
    else:
        raise AssertionError("Missing first-floor CDF counts must fail before writing parcels")
    assert parcel_path.read_bytes() == stable_bytes

print("North Wildwood flood-history projection model checks passed.")
