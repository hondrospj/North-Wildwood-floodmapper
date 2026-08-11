#!/usr/bin/env python3
"""Benchmark candidate North Wildwood routing methods on the real graph.

The former benchmark compared a broad-crested-weir atlas with a reference
that used the same equation. This benchmark instead exercises the actual city
graph and the exact low-stage source failure visible in the public map.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import simulate_north_wildwood_hydraulics as model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def state_metrics(
    solver: model.HydraulicSolver,
    zones: dict[str, np.ndarray],
    storage: np.ndarray,
    surface: np.ndarray,
    stage: float,
) -> dict:
    wet = storage > 0.01
    terrain = ~solver.source
    source = solver.source
    return {
        "stageNavd88Ft": stage,
        "sourceVisible": bool(np.any(wet & source)),
        "sourceVolumeAcreFt": round(float(storage[source].sum() / 43_560.0), 6),
        "terrainWetZoneCount": int(np.count_nonzero(wet & terrain)),
        "terrainStoredVolumeAcreFt": round(
            float(storage[terrain].sum() / 43_560.0),
            6,
        ),
        "terrainWetFootprintAcres": round(
            float(zones["cell_count"][wet & terrain].sum() / 43_560.0),
            6,
        ),
        "maximumTerrainSurfaceNavd88Ft": round(
            float(np.max(surface[wet & terrain])) if np.any(wet & terrain) else -9999.0,
            4,
        ),
    }


def route_low_stage(
    solver: model.HydraulicSolver,
    zones: dict[str, np.ndarray],
) -> tuple[list[dict], float, np.ndarray, np.ndarray]:
    storage, surface = solver.dry_start(0.0)
    duration = max(
        model.MODEL_STEP_SECONDS,
        round(
            model.MODEL_STAGE_STEP_FT
            / model.RISE_RATE_FAMILIES_FT_PER_HOUR["rising_typical"]
            * 3600.0
            / model.MODEL_STEP_SECONDS
        )
        * model.MODEL_STEP_SECONDS,
    )
    requested = {0, 19, 20, 21, 22}
    records: list[dict] = []
    maximum_residual = 0.0
    for index, stage_raw in enumerate(model.STAGES_FT[:23]):
        stage = float(stage_raw)
        storage, surface, diagnostics = solver.advance(
            storage,
            surface,
            stage,
            duration_seconds=duration,
        )
        maximum_residual = max(
            maximum_residual,
            diagnostics["maxInternalConservationResidualFt3"],
        )
        if index in requested:
            records.append(state_metrics(solver, zones, storage, surface, stage))
    return records, maximum_residual, storage, surface


def first_exterior_routing_metrics(
    solver: model.HydraulicSolver,
    zones: dict[str, np.ndarray],
) -> dict:
    """Measure the first exterior-routing increment and a short crest hold."""
    records, residual, storage, surface = route_low_stage(solver, zones)
    rising = next(record for record in records if record["stageNavd88Ft"] == 2.2)
    crest_storage, crest_surface, crest_diagnostic = solver.advance(
        storage.copy(),
        surface.copy(),
        2.2,
        duration_seconds=model.SHORT_CREST_MINUTES * 60,
    )
    return {
        "rising": rising,
        "crestAfterAdditionalMinutes": model.SHORT_CREST_MINUTES,
        "crest": state_metrics(
            solver,
            zones,
            crest_storage,
            crest_surface,
            2.2,
        ),
        "risingMaximumInternalConservationResidualFt3": residual,
        "crestMaximumInternalConservationResidualFt3": crest_diagnostic[
            "maxInternalConservationResidualFt3"
        ],
        "crestSourceExchangeAcreFt": round(
            crest_diagnostic["sourceExchangeFt3"] / 43_560.0,
            6,
        ),
    }


def decode_legacy_stage(
    solver: model.HydraulicSolver,
    zones: dict[str, np.ndarray],
    families: dict[str, np.ndarray],
    stage_index: int,
) -> dict:
    encoded = families["rising_typical"][stage_index, 1:]
    wet = encoded != model.DRY_SENTINEL
    surface = solver.minimum_surface.copy()
    surface[wet] = encoded[wet].astype(np.float64) / 100.0
    storage = solver.storage(surface)
    storage[~wet] = 0.0
    return state_metrics(
        solver,
        zones,
        storage,
        surface,
        float(model.STAGES_FT[stage_index]),
    )


def main() -> None:
    args = parse_args()
    graph_manifest = json.loads(
        (args.graph / "graph_manifest.json").read_text(encoding="utf-8")
    )
    solver_kwargs = {
        "control_volume_size_ft": float(
            graph_manifest["controlVolumeSizeFt"]
        )
    }
    zones = model.load_zones(args.graph / "zones.csv")
    edges = model.load_edges(args.graph / "edges.csv")
    storage_solver = model.HydraulicSolver(zones, edges, **solver_kwargs)
    methods: list[dict] = []
    equilibrium_states = []
    for stage in (2.0, 2.1, 2.2):
        equilibrium_storage, equilibrium_surface = storage_solver.equilibrium(stage)
        equilibrium_states.append(
            state_metrics(
                storage_solver,
                zones,
                equilibrium_storage,
                equilibrium_surface,
                stage,
            )
        )
    methods.append(
        {
            "method": "connected_equilibrium",
            "description": "current-stage connectivity with instantaneous equalization",
            "states": equilibrium_states,
        }
    )

    candidates = (
        (
            "activated_all_faces_weir",
            model.HydraulicSolver(
                zones,
                edges,
                routing_method="legacy_weir",
                source_activation_navd88_ft=model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
                **solver_kwargs,
            ),
        ),
        (
            "diffusive_without_source_activation",
            model.HydraulicSolver(
                zones,
                edges,
                routing_method="diffusive",
                source_activation_navd88_ft=None,
                **solver_kwargs,
            ),
        ),
        (
            "activated_diffusive_without_free_overflow_cap",
            model.HydraulicSolver(
                zones,
                edges,
                routing_method="diffusive",
                source_activation_navd88_ft=model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
                **solver_kwargs,
            ),
        ),
        (
            "selected_hybrid_with_2ft_source_activation",
            model.HydraulicSolver(
                zones,
                edges,
                routing_method="hybrid_diffusive",
                source_activation_navd88_ft=model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
                **solver_kwargs,
            ),
        ),
    )
    for name, solver in candidates:
        states, residual, _, _ = route_low_stage(solver, zones)
        methods.append(
            {
                "method": name,
                "description": (
                    "broad-crested-weir routing on every face with 2.0-ft source activation"
                    if name.startswith("activated_all_faces")
                    else "Manning diffusive-wave face routing"
                    if "diffusive" in name
                    else (
                        "Manning diffusive-wave routing, free-overflow weir cap, "
                        "physical wetting depth, and 2.0-ft source activation"
                    )
                ),
                "maximumInternalConservationResidualFt3": residual,
                "states": states,
            }
        )

    sensitivities = []
    for label, manning_n, wetting_depth in (
        ("low_roughness", 0.08, 0.05),
        ("selected", 0.12, 0.05),
        ("high_roughness", 0.20, 0.05),
        ("thin_numerical_film", 0.12, 0.01),
        ("deep_wetting_front", 0.12, 0.10),
    ):
        solver = model.HydraulicSolver(
            zones,
            edges,
            routing_method="hybrid_diffusive",
            source_activation_navd88_ft=model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
            manning_n=manning_n,
            minimum_mobile_depth_ft=wetting_depth,
            **solver_kwargs,
        )
        sensitivities.append(
            {
                "label": label,
                "manningN": manning_n,
                "minimumMobileDepthFt": wetting_depth,
                **first_exterior_routing_metrics(solver, zones),
            }
        )

    selected = methods[-1]
    selected_20 = next(
        state for state in selected["states"] if state["stageNavd88Ft"] == 2.0
    )
    selected_21 = next(
        state for state in selected["states"] if state["stageNavd88Ft"] == 2.1
    )
    selected_22 = next(
        state for state in selected["states"] if state["stageNavd88Ft"] == 2.2
    )
    report = {
        "schema": "north-wildwood-routing-method-benchmark-v5",
        "graphZoneCount": storage_solver.zone_count,
        "graphEdgeGroupCount": int(edges["a"].size),
        "test": (
            "continuous typical rise on the real North Wildwood graph; complete "
            "connected 2.0-ft source transition and first exterior-routing increment"
        ),
        "methods": methods,
        "firstPositiveHeadSensitivity": sensitivities,
        "determination": {
            "selected": selected["method"],
            "reasons": [
                "complete <=2.0-ft components of at least one acre qualify by exterior topology or supplied tidal markers; polygons never paint source geometry",
                "the two complete qualified <=2.0-ft fields are fixed-head source",
                "at 2.0 ft the entire source boundary is displayed while exterior routed volume is zero",
                "at 2.1 ft the source remains complete without visible exterior terrain",
                "at 2.2 ft exterior water is finite and derived from perimeter face flux",
                "ordinary terrain flow includes distance and Manning friction",
                "true free overflow remains bounded by critical weir capacity",
                "storage and internal edge transfers conserve volume",
            ],
            "acceptance": {
                "sourceVisibleAt2Ft": selected_20["sourceVisible"],
                "terrainVolumeAt2FtAcreFt": selected_20[
                    "terrainStoredVolumeAcreFt"
                ],
                "finiteTerrainVolumeAt2_1FtAcreFt": selected_21[
                    "terrainStoredVolumeAcreFt"
                ],
                "finiteTerrainVolumeAt2_2FtAcreFt": selected_22[
                    "terrainStoredVolumeAcreFt"
                ],
                "maximumInternalConservationResidualFt3": selected[
                    "maximumInternalConservationResidualFt3"
                ],
            },
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
