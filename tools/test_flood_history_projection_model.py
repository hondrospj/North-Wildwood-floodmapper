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

print("North Wildwood flood-history projection model checks passed.")
