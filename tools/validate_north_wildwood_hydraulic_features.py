#!/usr/bin/env python3
"""Fail-fast checks for the one-foot conditional-connectivity model."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal
from scipy.ndimage import label as ndimage_label


MAGIC = b"NWHYD2\x00\x00"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--states", type=Path, required=True)
    parser.add_argument("--centerline", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
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
        byte_length = int(record["length"])
        if header.get("valueType") == "int16-le":
            arrays[phase] = np.frombuffer(
                raw,
                dtype="<i2",
                count=byte_length // 2,
                offset=payload_start + int(record["offset"]),
            ).reshape(int(header["stageCount"]), expected_stride)
        else:
            encoded = np.frombuffer(
                raw,
                dtype=np.uint8,
                count=byte_length,
                offset=payload_start + int(record["offset"]),
            ).reshape(int(header["stageCount"]), expected_stride)
            arrays[phase] = (
                encoded.astype(np.int16)
                + int(header["surfaceOffsetDecifeet"])
            ) * 10
            arrays[phase][encoded == int(header["drySentinel"])] = -32768
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
    if float(manifest.get("sourceStageNavd88Ft", math.nan)) != 2.0:
        raise AssertionError("Graph does not declare the exact 2.00-ft source stage")
    if int(manifest.get("sourceMinComponentCells", 0)) != 101:
        raise AssertionError("Graph does not require a source plus 100 other cells")
    if manifest.get("sourceConnectivity") != "four-neighbour/shared-side only":
        raise AssertionError("Graph does not declare four-neighbour source connectivity")

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

    dem_ds = gdal.Open(str(args.dem.resolve()))
    if dem_ds is None:
        raise FileNotFoundError(args.dem)
    raw_elevation = dem_ds.GetRasterBand(1).ReadAsArray()
    raw_nodata = dem_ds.GetRasterBand(1).GetNoDataValue()
    dem_ds = None
    source = np.memmap(
        graph / "source_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(height, width),
    )
    eligible = np.isfinite(raw_elevation) & (raw_elevation <= 2.0000001)
    if raw_nodata is not None:
        eligible &= raw_elevation != raw_nodata
    labels, component_count = ndimage_label(
        eligible,
        structure=np.asarray(((0, 1, 0), (1, 1, 1), (0, 1, 0)), dtype=np.uint8),
    )
    component_sizes = np.bincount(labels.ravel(), minlength=component_count + 1)
    qualifying = component_sizes >= 101
    qualifying[0] = False
    expected_source = qualifying[labels]
    if not np.array_equal(source != 0, expected_source):
        raise AssertionError(
            "Source raster does not exactly match the unrounded <=2.00-ft, "
            "four-neighbour, >=101-cell rule"
        )
    source_components = int(np.count_nonzero(qualifying))
    source_pixels = int(np.count_nonzero(expected_source))
    del labels, expected_source, eligible, raw_elevation

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
    dry = int(header.get("drySentinelCentift", -32768))
    if not np.array_equal(states["filling"], states["slack"]):
        raise AssertionError("Unadjusted filling/slack audit states differ")
    if not np.array_equal(states["filling"], states["draining"]):
        raise AssertionError("Unadjusted filling/draining audit states differ")
    hard_lookup = np.asarray(sorted(hard_zone_ids), dtype=np.int64) + 1
    for phase in ("filling", "slack", "draining"):
        if np.any(states[phase][74, hard_lookup] != dry):
            raise AssertionError(
                f"{phase} state wets a bulkhead before 7.5 ft NAVD88"
            )

    physics = header.get("physics") or {}
    if physics.get("modelKind") != "phase-aware developed-land conditional connectivity":
        raise AssertionError("State package declares the wrong model")
    if physics.get("phaseInvariant") is not False:
        raise AssertionError("State package incorrectly declares phase invariance")
    if not str(physics.get("stormDrains", "")).startswith("disabled"):
        raise AssertionError("State package does not declare disabled storm drains")
    if float(physics.get("bulkheadElevationNavd88Ft", math.nan)) != 7.5:
        raise AssertionError("State package does not declare the 7.5-ft bulkhead")
    if int(physics.get("bulkheadNominalWidthCells", 0)) != 21:
        raise AssertionError("State package does not declare a 21-cell bulkhead")
    penalty = physics.get("verticalPenalty") or {}
    anchors = penalty.get("anchors") or []
    expected_anchors = ((3.25, 0.75), (4.25, 0.25), (5.25, 0.0))
    if len(anchors) != len(expected_anchors):
        raise AssertionError("State package has the wrong number of penalty anchors")
    for anchor, (stage, value) in zip(anchors, expected_anchors):
        if not math.isclose(float(anchor.get("stageNavd88Ft", math.nan)), stage) or not math.isclose(
            float(anchor.get("penaltyFt", math.nan)), value
        ):
            raise AssertionError("State package has a wrong polynomial anchor")
    if penalty.get("curve") != "quadratic through all three anchors":
        raise AssertionError("State package has the wrong penalty curve")
    if "TYPE15 = URBAN" not in str(penalty.get("spatialMask", "")):
        raise AssertionError("State package does not constrain the penalty to developed land")
    if "positive offset" not in str(penalty.get("draining", "")):
        raise AssertionError("State package does not declare drainage retention")

    # State connectivity is evaluated at the full gauge stage. The compact
    # state format stores centifeet, so a wet zone at 3.0 ft must encode the
    # unpenalized 3.0-ft connectivity surface. Local depth attenuation is
    # applied after the one-foot cell has been admitted to the wet footprint.
    low_stage = states["slack"][30]
    low_wet = low_stage != dry
    if np.any(low_wet) and int(low_stage[low_wet].max()) != 300:
        raise AssertionError("Low-stage states do not preserve full-stage connectivity")

    print(
        json.dumps(
            {
                "status": "passed",
                "graphSchema": manifest["schema"],
                "zoneCount": zone_count,
                "sourceComponents": source_components,
                "sourcePixels": source_pixels,
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
