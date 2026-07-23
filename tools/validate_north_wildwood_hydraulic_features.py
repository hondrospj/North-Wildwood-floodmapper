#!/usr/bin/env python3
"""Fail-fast checks for the conditioned DEM and connected-bathtub states."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal


MAGIC = b"NWHYD2\x00\x00"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--states", type=Path, required=True)
    parser.add_argument("--centerline", type=Path, required=True)
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
    gdal.UseExceptions()
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
    expected_hard_pixels = int(manifest["bulkheadPixelCount"])
    if int(manifest.get("bulkheadNominalWidthCells", 0)) != 21:
        raise AssertionError("Graph does not declare a 21-cell bulkhead")

    hard_zone_ids: set[int] = set()
    grate_zone_count = 0
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
                grate_zone_count += 1

    if row_count != zone_count:
        raise AssertionError(f"Expected {zone_count} zones, read {row_count}")
    if hard_pixels != expected_hard_pixels:
        raise AssertionError(
            f"Expected {expected_hard_pixels} 21-cell bulkhead pixels, "
            f"found {hard_pixels}"
        )
    if grate_pixels != 0 or grate_zone_count != 0:
        raise AssertionError("Storm drains were not fully disabled")

    elevation10 = np.memmap(
        graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(height, width),
    )
    hard = np.memmap(
        graph / "hard_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(height, width),
    )
    if int(elevation10[hard != 0].min()) < 75:
        raise AssertionError("A stitched bulkhead DEM cell is below 7.5 ft NAVD88")

    centerline_ds = gdal.Open(str(args.centerline.resolve()))
    if centerline_ds is None:
        raise FileNotFoundError(args.centerline)
    if (
        centerline_ds.RasterXSize != width
        or centerline_ds.RasterYSize != height
    ):
        raise AssertionError("Bulkhead centerline dimensions do not match graph")
    centerline = centerline_ds.GetRasterBand(1).ReadAsArray().astype(bool)
    centerline_ds = None
    centerline_pixels = int(np.count_nonzero(centerline))
    if centerline_pixels != 11_200:
        raise AssertionError(
            f"Expected 11,200 centerline pixels, found {centerline_pixels}"
        )

    # The GDAL proximity expansion is defined as the centerline plus ten cell
    # centers on every side. Check intermediate and outer cardinal offsets so
    # no local break can collapse the nominal 21-cell wall.
    cardinal_offsets = [(0, 0)]
    for distance in (1, 5, 10):
        cardinal_offsets.extend(
            (
                (0, -distance),
                (0, distance),
                (-distance, 0),
                (distance, 0),
            )
        )
    for dy, dx in cardinal_offsets:
        source_y0 = max(0, -dy)
        source_y1 = min(height, height - dy)
        source_x0 = max(0, -dx)
        source_x1 = min(width, width - dx)
        for y in range(source_y0, source_y1, 512):
            y_end = min(source_y1, y + 512)
            thin = centerline[y:y_end, source_x0:source_x1]
            expanded = hard[
                y + dy : y_end + dy,
                source_x0 + dx : source_x1 + dx,
            ]
            if np.any(thin & (expanded == 0)):
                raise AssertionError(
                    "Bulkhead is not ten cells thick on every side of its "
                    f"centerline at offset ({dx}, {dy})"
                )

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
    if not np.array_equal(states["filling"], states["slack"]):
        raise AssertionError("Filling and slack states are not phase-invariant")
    if not np.array_equal(states["filling"], states["draining"]):
        raise AssertionError("Filling and draining states are not phase-invariant")
    hard_lookup = np.asarray(sorted(hard_zone_ids), dtype=np.int64) + 1
    for phase in ("filling", "slack", "draining"):
        if np.any(states[phase][74, hard_lookup] != dry):
            raise AssertionError(
                f"{phase} state wets a bulkhead before 7.5 ft NAVD88"
            )

    physics = header.get("physics") or {}
    if physics.get("modelKind") != "connectivity-first depth-penalized bathtub":
        raise AssertionError("State package does not declare the connected bathtub")
    if physics.get("phaseInvariant") is not True:
        raise AssertionError("State package does not declare phase-invariant states")
    if not str(physics.get("stormDrains", "")).startswith("disabled"):
        raise AssertionError("State package does not declare disabled storm drains")
    if float(physics.get("bulkheadElevationNavd88Ft", math.nan)) != 7.5:
        raise AssertionError("State package does not declare the 7.5-ft bulkhead")
    if int(physics.get("bulkheadNominalWidthCells", 0)) != 21:
        raise AssertionError("State package does not declare a 21-cell bulkhead")
    penalty = physics.get("verticalPenalty") or {}
    if not math.isclose(
        float(penalty.get("atOrBelowMinorFt", math.nan)),
        0.75,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong low-stage vertical penalty")
    if not math.isclose(
        float(penalty.get("atModerateFt", math.nan)),
        0.35,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong moderate-stage vertical penalty")
    if not math.isclose(
        float(penalty.get("atOrAboveMajorFt", math.nan)),
        0.0,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong major-stage vertical penalty")
    if not math.isclose(
        float(penalty.get("maximumLocalDepthPenaltyFraction", math.nan)),
        0.75,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong local depth-penalty cap")
    if not math.isclose(
        float(penalty.get("minimumConnectedDepthRetainedFraction", math.nan)),
        0.25,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong connected-depth floor")
    if "depth only" not in str(penalty.get("application", "")):
        raise AssertionError("State package applies the penalty to connectivity")

    # State connectivity is evaluated at the full gauge stage. The compact
    # state format stores decifeet, so a wet zone at 3.0 ft must encode the
    # unpenalized 3.0-ft connectivity surface. Local depth attenuation is
    # applied after the one-foot cell has been admitted to the wet footprint.
    low_stage = states["slack"][30]
    low_wet = low_stage != dry
    if np.any(low_wet) and int(low_stage[low_wet].max()) + offset10 != 30:
        raise AssertionError("Low-stage states do not preserve full-stage connectivity")

    print(
        json.dumps(
            {
                "status": "passed",
                "graphSchema": manifest["schema"],
                "zoneCount": zone_count,
                "bulkheadPixels": hard_pixels,
                "bulkheadCenterlinePixels": centerline_pixels,
                "bulkheadNominalWidthCells": 21,
                "bulkheadZones": len(hard_zone_ids),
                "bulkheadEdgeRecords": hard_edge_records,
                "bulkheadSharedEdgeWidthFt": hard_edge_width_ft,
                "minimumBulkheadEdgeCrestNavd88Ft": 7.5,
                "stormDrainPixels": grate_pixels,
                "stormDrainExchange": "disabled",
                "modelKind": physics["modelKind"],
                "phaseInvariant": physics["phaseInvariant"],
                "verticalPenalty": penalty,
                "statePhases": list(states),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
