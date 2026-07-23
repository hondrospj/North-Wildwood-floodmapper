#!/usr/bin/env python3
"""Fail-fast checks that bulkheads and storm grates survive the full model."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from pathlib import Path

import numpy as np


MAGIC = b"NWHYD2\x00\x00"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--states", type=Path, required=True)
    return parser.parse_args()


def load_states(path: Path, expected_stride: int) -> tuple[dict, dict[str, np.ndarray]]:
    raw = gzip.decompress(path.read_bytes())
    if raw[:8] != MAGIC:
        raise AssertionError(f"Unexpected hydraulic state magic in {path}")
    header_length = int.from_bytes(raw[8:12], "little")
    header = json.loads(raw[12 : 12 + header_length])
    if int(header["zoneStride"]) != expected_stride:
        raise AssertionError("Hydraulic state stride does not match graph")
    payload_start = 12 + header_length
    arrays = {}
    for phase in ("filling", "slack", "draining"):
        record = header["phaseArrays"][phase]
        arrays[phase] = np.frombuffer(
            raw,
            dtype=np.uint8,
            count=int(record["length"]),
            offset=payload_start + int(record["offset"]),
        ).reshape(int(header["stageCount"]), expected_stride)
    return header, arrays


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    manifest = json.loads((graph / "graph_manifest.json").read_text(encoding="utf-8"))
    width = int(manifest["width"])
    height = int(manifest["height"])
    zone_count = int(manifest["zoneCount"])

    hard_pixels = int(
        np.memmap(
            graph / "hard_flag.raw",
            dtype=np.uint8,
            mode="r",
            shape=(height, width),
        ).sum(dtype=np.uint64)
    )
    grate_pixels = int(
        np.memmap(
            graph / "grate_flag.raw",
            dtype=np.uint8,
            mode="r",
            shape=(height, width),
        ).sum(dtype=np.uint64)
    )

    hard_zone_ids: set[int] = set()
    grate_rows: list[dict[str, int]] = []
    row_count = 0
    with (graph / "zones.csv").open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            row_count += 1
            zone_id = int(row["zone_id"])
            cell_count = int(row["cell_count"])
            hard_cells = int(row["hard_cells"])
            grate_cells = int(row["grate_cells"])
            histogram_total = sum(int(value) for value in row["hist_counts"].split(":"))
            if histogram_total != cell_count:
                raise AssertionError(f"Zone {zone_id} hypsometry does not match cell count")
            if hard_cells:
                hard_zone_ids.add(zone_id)
                if hard_cells != cell_count:
                    raise AssertionError(
                        f"Bulkhead zone {zone_id} also contains non-bulkhead terrain"
                    )
            if grate_cells:
                grate_rows.append(
                    {
                        "zone_id": zone_id,
                        "connection10": int(row["connection10"]),
                        "grate_cells": grate_cells,
                    }
                )

    if row_count != zone_count:
        raise AssertionError(f"Expected {zone_count} zones, read {row_count}")
    if hard_pixels != 11_200:
        raise AssertionError(f"Expected 11,200 bulkhead pixels, found {hard_pixels}")
    if grate_pixels != 6:
        raise AssertionError(f"Expected six storm-grate pixels, found {grate_pixels}")
    if sum(row["grate_cells"] for row in grate_rows) != grate_pixels:
        raise AssertionError("Storm-grate pixels were lost during zone aggregation")
    if len(grate_rows) != grate_pixels:
        raise AssertionError("Each supplied storm grate must occupy a distinct zone")

    hard_edge_records = 0
    hard_edge_width_ft = 0
    with (graph / "edges.csv").open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            touches_hard = (
                int(row["zone_a"]) in hard_zone_ids
                or int(row["zone_b"]) in hard_zone_ids
            )
            if not touches_hard:
                continue
            hard_edge_records += 1
            hard_edge_width_ft += int(row["width_ft"])
            if int(row["crest10"]) < 75:
                raise AssertionError("An edge crosses a bulkhead below 7.5 ft NAVD88")

    header, states = load_states(args.states.resolve(), zone_count + 1)
    dry = int(header["drySentinel"])
    offset10 = int(header["surfaceOffsetDecifeet"])
    hard_lookup = np.asarray(sorted(hard_zone_ids), dtype=np.int64) + 1
    for phase in ("filling", "slack"):
        if np.any(states[phase][74, hard_lookup] != dry):
            raise AssertionError(
                f"{phase} state wets a bulkhead before 7.5 ft NAVD88"
            )

    grate_checks = []
    for row in grate_rows:
        zone_lookup = row["zone_id"] + 1
        wet_index = min(int(header["stageCount"]) - 1, row["connection10"] + 1)
        for phase in ("filling", "slack"):
            encoded = int(states[phase][wet_index, zone_lookup])
            if encoded == dry:
                raise AssertionError(
                    f"Storm-grate zone {row['zone_id']} is dry in {phase} "
                    f"above its {row['connection10'] / 10:.1f}-ft connection"
                )
            surface = (encoded + offset10) / 10
            selected_stage = wet_index / 10
            if not math.isfinite(surface) or surface > selected_stage + 0.11:
                raise AssertionError(
                    f"Storm-grate zone {row['zone_id']} has invalid {phase} surface"
                )
        grate_checks.append(
            {
                "zoneId": row["zone_id"],
                "firstConnectionNavd88Ft": row["connection10"] / 10,
                "verifiedWetByNavd88Ft": wet_index / 10,
            }
        )

    physics = header.get("physics") or {}
    if physics.get("grates") != "48-inch circular orifice":
        raise AssertionError("State package does not declare the 48-inch grate physics")
    if float(physics.get("bulkheadElevationNavd88Ft", math.nan)) != 7.5:
        raise AssertionError("State package does not declare the 7.5-ft bulkhead")

    print(
        json.dumps(
            {
                "status": "passed",
                "graphSchema": manifest["schema"],
                "zoneCount": zone_count,
                "bulkheadPixels": hard_pixels,
                "bulkheadZones": len(hard_zone_ids),
                "bulkheadEdgeRecords": hard_edge_records,
                "bulkheadSharedEdgeWidthFt": hard_edge_width_ft,
                "minimumBulkheadEdgeCrestNavd88Ft": 7.5,
                "stormGratePixels": grate_pixels,
                "stormGrateZones": grate_checks,
                "statePhases": list(states),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
