#!/usr/bin/env python3
"""Route and render one representative rising history for mesh QA.

This deliberately avoids generating the seven-family publication package. It
is used to compare candidate finite-volume resolutions on the real DEM before
committing the expensive complete atlas solve.
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
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--maximum-stage", type=float, default=7.5)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = json.loads(
        (args.graph / "graph_manifest.json").read_text(encoding="utf-8")
    )
    zones = model.load_zones(args.graph / "zones.csv")
    edges = model.load_edges(args.graph / "edges.csv")
    solver = model.HydraulicSolver(
        zones,
        edges,
        control_volume_size_ft=float(manifest["controlVolumeSizeFt"]),
    )
    stride = solver.zone_count + 1
    states = np.full(
        (len(model.STAGES_FT), stride),
        model.DRY_SENTINEL,
        dtype="<i2",
    )
    storage, surface = solver.dry_start(0.0)
    duration_seconds = max(
        model.MODEL_STEP_SECONDS,
        round(
            model.MODEL_STAGE_STEP_FT
            / model.RISE_RATE_FAMILIES_FT_PER_HOUR["rising_typical"]
            * 3600.0
            / model.MODEL_STEP_SECONDS
        )
        * model.MODEL_STEP_SECONDS,
    )
    selected_metrics: list[dict] = []
    maximum_residual = 0.0
    terrain = ~solver.source
    requested = {2.0, 2.2, 3.0, 4.0, 5.0, 7.5}
    for stage_index, stage_raw in enumerate(model.STAGES_FT):
        stage = float(stage_raw)
        if stage > args.maximum_stage + 1e-9:
            break
        storage, surface, diagnostic = solver.advance(
            storage,
            surface,
            stage,
            duration_seconds=duration_seconds,
        )
        states[stage_index] = solver.encode_surface(storage, surface)
        maximum_residual = max(
            maximum_residual,
            diagnostic["maxInternalConservationResidualFt3"],
        )
        if any(abs(stage - value) < 1e-9 for value in requested):
            wet = (storage > 0.01) & terrain
            selected_metrics.append(
                {
                    "stageNavd88Ft": stage,
                    "wetTerrainZoneCount": int(np.count_nonzero(wet)),
                    "wetTerrainFootprintAcres": float(
                        zones["cell_count"][wet].sum() / 43_560.0
                    ),
                    "terrainVolumeAcreFt": float(storage[terrain].sum() / 43_560.0),
                    "sourceExchangeAcreFt": float(
                        diagnostic["sourceExchangeFt3"] / 43_560.0
                    ),
                }
            )
        if stage_index % 10 == 0:
            print(f"representative rising history: {stage:.1f} ft NAVD88")

    crest_states = np.full_like(states, model.DRY_SENTINEL)
    crest_index = int(round(args.maximum_stage / model.MODEL_STAGE_STEP_FT))
    crest_storage, crest_surface, crest_diagnostic = solver.advance(
        storage.copy(),
        surface.copy(),
        float(args.maximum_stage),
        duration_seconds=model.SHORT_CREST_MINUTES * 60,
    )
    crest_states[crest_index] = solver.encode_surface(
        crest_storage,
        crest_surface,
    )
    maximum_residual = max(
        maximum_residual,
        crest_diagnostic["maxInternalConservationResidualFt3"],
    )
    families = {
        "rising_typical": states,
        "crest": crest_states,
    }
    render = model.render_assets(
        args.graph,
        args.dem,
        args.output,
        families,
        family_names=("rising_typical", "crest"),
    )
    report = {
        "schema": "north-wildwood-resolution-preview-v1",
        "controlVolumeSizeFt": manifest["controlVolumeSizeFt"],
        "connectionBinFt": manifest["connectionBinFt"],
        "zoneCount": solver.zone_count,
        "terrainZoneCount": int(np.count_nonzero(terrain)),
        "sourceZoneCount": int(np.count_nonzero(solver.source)),
        "edgeGroupCount": int(edges["a"].size),
        "maximumInternalConservationResidualFt3": maximum_residual,
        "selectedStages": selected_metrics,
        "render": render,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "resolution-preview.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
