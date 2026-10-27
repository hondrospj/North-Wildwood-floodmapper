#!/usr/bin/env python3
"""Inspect and optionally render the current conditional-connectivity model.

This is a small stage-limited QA package, using the same equilibrium state and
phase rendering APIs as the publication builder.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import simulate_north_wildwood_hydraulics as model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--road-mask", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--maximum-stage", type=float, default=7.5)
    parser.add_argument("--skip-render", action="store_true", help="Write state QA metrics without GDAL raster rendering")
    args = parser.parse_args()
    if not np.isfinite(args.maximum_stage) or not 0 <= args.maximum_stage <= float(model.STAGES_FT[-1]):
        parser.error("--maximum-stage must be between 0 and 20 ft NAVD88")
    return args


def main() -> None:
    args = parse_args()
    manifest = json.loads((args.graph / "graph_manifest.json").read_text(encoding="utf-8"))
    zones = model.load_zones(args.graph / "zones.csv")
    solver = model.HydraulicSolver(zones, model.load_edges(args.graph / "edges.csv"))
    stages = model.STAGES_FT[model.STAGES_FT <= args.maximum_stage + 1e-9]
    states = np.full((len(stages), solver.zone_count + 1), model.DRY_SENTINEL, dtype="<i2")
    terrain = ~solver.source
    selected = []
    for index, stage_raw in enumerate(stages):
        stage = float(stage_raw)
        storage, surface = solver.equilibrium(stage)
        states[index] = solver.encode_surface(storage, surface)
        wet = (storage > 0.01) & terrain
        selected.append({
            "stageNavd88Ft": stage,
            "wetTerrainZoneCount": int(np.count_nonzero(wet)),
            "wetTerrainFootprintAcres": float(zones["cell_count"][wet].sum() / 43_560.0),
            "terrainVolumeAcreFt": float(storage[terrain].sum() / 43_560.0),
        })
    render = None
    if not args.skip_render:
        # render_assets iterates the catalog's stage vector. Limit both together;
        # restore it so importing/invoking this diagnostic cannot alter the model.
        catalog_stages = model.STAGES_FT
        try:
            model.STAGES_FT = stages
            render = model.render_assets(
                args.graph, args.dem,
                args.road_mask or args.graph / "NorthWildwoodRoadCorridor5ft.tif",
                args.output,
                {phase: states for phase in model.PHASE_DIRECTORIES},
                phase_names=tuple(model.PHASE_DIRECTORIES),
            )
        finally:
            model.STAGES_FT = catalog_stages
    report = {
        "schema": "north-wildwood-resolution-preview-v2",
        "modelKind": "phase-aware developed-land conditional connectivity",
        "controlVolumeSizeFt": manifest["controlVolumeSizeFt"],
        "connectionBinFt": manifest["connectionBinFt"],
        "zoneCount": solver.zone_count,
        "terrainZoneCount": int(np.count_nonzero(terrain)),
        "sourceZoneCount": int(np.count_nonzero(solver.source)),
        "selectedStages": selected,
        "render": render,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "resolution-preview.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
