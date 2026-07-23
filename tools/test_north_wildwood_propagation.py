#!/usr/bin/env python3
"""Deterministic travel-time test for the North Wildwood routing step."""

from __future__ import annotations

import numpy as np

import simulate_north_wildwood_hydraulics as model


def main() -> None:
    zone_count = 40
    histogram = np.zeros((zone_count, model.HIST_COUNT), dtype=np.int64)
    zero_bin = -model.HIST_MIN10
    histogram[:, zero_bin] = 625
    zones = {
        "connection10": np.zeros(zone_count, dtype=np.int16),
        "cell_count": np.full(zone_count, 625, dtype=np.int64),
        "source_cells": np.r_[1, np.zeros(zone_count - 1, dtype=np.int64)],
        "grate_cells": np.zeros(zone_count, dtype=np.int64),
        "hard_cells": np.zeros(zone_count, dtype=np.int64),
        "histogram": histogram,
    }
    edges = {
        "a": np.arange(zone_count - 1, dtype=np.int32),
        "b": np.arange(1, zone_count, dtype=np.int32),
        "crest_ft": np.zeros(zone_count - 1, dtype=np.float64),
        "width_ft": np.full(zone_count - 1, 25.0, dtype=np.float64),
    }
    solver = model.HydraulicSolver(zones, edges)
    storage = np.zeros(zone_count, dtype=np.float64)
    surface = np.zeros(zone_count, dtype=np.float64)
    source_storage = solver.storage(np.ones(zone_count, dtype=np.float64))
    storage[0] = source_storage[0]
    surface[0] = 1.0

    storage, _, diagnostics = solver.advance(storage, surface, 1.0)
    wet = np.flatnonzero(storage > 0.01)
    farthest_hop = int(wet.max()) if wet.size else -1
    substeps = model.TIDE_STEP_SECONDS // model.MODEL_STEP_SECONDS
    if farthest_hop > substeps:
        raise AssertionError(
            f"Water crossed {farthest_hop} graph edges in {substeps} substeps"
        )
    if diagnostics["stormDrainExchangeFt3"] != 0.0:
        raise AssertionError("Storm-drain exchange was not disabled")
    if diagnostics["maxInternalConservationResidualFt3"] > 1e-8:
        raise AssertionError("Internal edge routing did not conserve volume")

    print(
        {
            "status": "passed",
            "substepsPer15Minutes": substeps,
            "farthestWetGraphHop": farthest_hop,
            "maximumConservativeTravelFt": (
                model.MAX_OVERLAND_FRONT_TRAVEL_PER_TIDE_STEP_FT
            ),
            "stormDrainExchangeFt3": diagnostics["stormDrainExchangeFt3"],
        }
    )


if __name__ == "__main__":
    main()
