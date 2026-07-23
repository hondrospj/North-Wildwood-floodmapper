#!/usr/bin/env python3
"""Fail-fast checks for the five-cell DEM bulkhead and finite propagation."""

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
    if int(manifest.get("bulkheadNominalWidthCells", 0)) != 5:
        raise AssertionError("Graph does not declare a five-cell bulkhead")

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
            f"Expected {expected_hard_pixels} five-cell bulkhead pixels, "
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

    # The GDAL proximity expansion is defined as the centerline plus two cell
    # centers on every side. Check all four cardinal directions explicitly so
    # no local break can collapse the nominal five-cell wall.
    for dy, dx in (
        (0, 0),
        (0, -1),
        (0, 1),
        (0, -2),
        (0, 2),
        (-1, 0),
        (1, 0),
        (-2, 0),
        (2, 0),
    ):
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
                    "Bulkhead is not two cells thick on every side of its "
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
    hard_lookup = np.asarray(sorted(hard_zone_ids), dtype=np.int64) + 1
    for phase in ("filling", "slack"):
        if np.any(states[phase][74, hard_lookup] != dry):
            raise AssertionError(
                f"{phase} state wets a bulkhead before 7.5 ft NAVD88"
            )

    physics = header.get("physics") or {}
    if not str(physics.get("stormDrains", "")).startswith("disabled"):
        raise AssertionError("State package does not declare disabled storm drains")
    if float(physics.get("bulkheadElevationNavd88Ft", math.nan)) != 7.5:
        raise AssertionError("State package does not declare the 7.5-ft bulkhead")
    if int(physics.get("bulkheadNominalWidthCells", 0)) != 5:
        raise AssertionError("State package does not declare a five-cell bulkhead")
    expected_speed = math.sqrt(2.0) * 25.0 / 60.0
    expected_travel = expected_speed * 15.0 * 60.0
    if not math.isclose(
        float(physics.get("maximumOverlandFrontSpeedFtPerSecond", math.nan)),
        expected_speed,
        rel_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong propagation speed limit")
    if not math.isclose(
        float(
            physics.get(
                "maximumOverlandFrontTravelPer15MinutesFt",
                math.nan,
            )
        ),
        expected_travel,
        rel_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong 15-minute travel limit")

    print(
        json.dumps(
            {
                "status": "passed",
                "graphSchema": manifest["schema"],
                "zoneCount": zone_count,
                "bulkheadPixels": hard_pixels,
                "bulkheadCenterlinePixels": centerline_pixels,
                "bulkheadNominalWidthCells": 5,
                "bulkheadZones": len(hard_zone_ids),
                "bulkheadEdgeRecords": hard_edge_records,
                "bulkheadSharedEdgeWidthFt": hard_edge_width_ft,
                "minimumBulkheadEdgeCrestNavd88Ft": 7.5,
                "stormDrainPixels": grate_pixels,
                "stormDrainExchange": "disabled",
                "maximumOverlandFrontSpeedFtPerSecond": expected_speed,
                "maximumOverlandFrontTravelPer15MinutesFt": expected_travel,
                "statePhases": list(states),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
