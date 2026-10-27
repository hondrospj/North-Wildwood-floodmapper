#!/usr/bin/env python3
"""Benchmark the current conditional-connectivity solver and phase policies.

The retired routing implementations are not selectable in today's solver.
This diagnostic checks its actual stage connectivity, storage, and developed
land admission policies instead of reporting results for unavailable methods.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import simulate_north_wildwood_hydraulics as model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    zones = model.load_zones(args.graph / "zones.csv")
    edges = model.load_edges(args.graph / "edges.csv")
    solver = model.HydraulicSolver(zones, edges)
    terrain = ~solver.source
    states = []
    for stage in (0.0, 1.9, 2.0, 2.1, 2.2, 3.25, 4.25, 5.25, 7.5):
        storage, surface = solver.equilibrium(stage)
        wet = storage > 0.01
        decoded = solver.surface_from_storage(storage, surface)
        active = storage > 1e-7
        states.append({
            "stageNavd88Ft": stage,
            "sourceVisible": bool(np.any(wet & solver.source)),
            "terrainWetZoneCount": int(np.count_nonzero(wet & terrain)),
            "terrainStoredVolumeAcreFt": float(storage[terrain].sum() / 43_560.0),
            "terrainWetFootprintAcres": float(zones["cell_count"][wet & terrain].sum() / 43_560.0),
            "disconnectedWetZoneCount": int(np.count_nonzero(wet & (solver.connection_ft > stage + 1e-9))),
            "maximumStorageRoundTripSurfaceErrorFt": float(np.max(np.abs(decoded[active] - surface[active]))) if np.any(active) else 0.0,
        })
    policies = []
    for stage in (3.25, 4.25, 5.25):
        for phase in model.PHASE_DIRECTORIES:
            policies.append({
                "stageNavd88Ft": stage, "phase": phase,
                "developedAdmissionStageFt": float(model.phase_adjusted_stage_ft(stage, phase, True)),
                "undevelopedAdmissionStageFt": float(model.phase_adjusted_stage_ft(stage, phase, False)),
                "developedDepthAtZeroGroundFt": float(model.penalized_connected_depth_ft(stage, 0.0, True, phase)),
            })
    report = {
        "schema": "north-wildwood-routing-method-benchmark-v6",
        "modelKind": "phase-aware developed-land conditional connectivity",
        "graphZoneCount": solver.zone_count, "graphEdgeGroupCount": int(edges["a"].size),
        "states": states, "phasePolicies": policies,
        "acceptance": {
            "noDisconnectedWetZones": all(row["disconnectedWetZoneCount"] == 0 for row in states),
            "maximumStorageRoundTripSurfaceErrorFt": max(row["maximumStorageRoundTripSurfaceErrorFt"] for row in states),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
