#!/usr/bin/env python3
"""Executable contract checks for parcel flood-history projections."""

from __future__ import annotations

import math

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


assert len(model.ELEVATION_GRID_FT) == 141
assert model.ELEVATION_GRID_FT[0] == 0.0
assert model.ELEVATION_GRID_FT[-1] == 14.0
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

low, high = model.wilson_probability_interval(50, 100)
assert 0.4 < low < 0.5 < high < 0.6
zero_low, zero_high = model.wilson_probability_interval(0, 100)
assert math.isclose(zero_low, 0.0, abs_tol=1e-15)
assert 0.0 < zero_high < 0.05

peaks = [1.0, 2.0, 3.0, 4.0]
successes, sample_size, probability = model.exceedance_probability(peaks, 3.0, 0.0)
assert (successes, sample_size, probability) == (2, 4, 0.5)
shifted = model.exceedance_probability(peaks, 3.0, 1.0)
assert shifted == (3, 4, 0.75)

print("North Wildwood flood-history projection model checks passed.")
