#!/usr/bin/env python3
"""Fail-fast checks for the conditioned DEM and finite-volume routed states."""

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
    families = tuple(header.get("familyOrder") or ())
    if len(families) != 7:
        raise AssertionError("Hydraulic states do not contain seven history families")
    for phase in families:
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
    if manifest.get("schema") != "north-wildwood-one-foot-hydraulic-graph-v7":
        raise AssertionError("Graph does not use the exterior-connected v7 source schema")

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
    source_pixels = int(
        np.memmap(
            graph / "source_flag.raw",
            dtype=np.uint8,
            mode="r",
            shape=(height, width),
        ).sum(dtype=np.uint64)
    )
    expected_source_pixels = int(manifest["qualifiedSourceBoundaryPixelCount"])
    manual_source_pixels = int(manifest["manualSourcePixelCount"])
    if manifest.get("sourceZonesIsolatedFromTerrain") is not True:
        raise AssertionError("Graph does not isolate fixed-head source zones")
    if not math.isclose(
        float(manifest.get("sourceStageNavd88Ft", math.nan)),
        2.0,
        abs_tol=1e-12,
    ):
        raise AssertionError("Graph does not define the source footprint at 2.0 ft")
    if "complete four-neighbour <=2.0 ft components" not in str(
        manifest.get("sourceBoundaryDefinition", "")
    ):
        raise AssertionError("Graph does not promote the complete 2.0-ft footprint")
    if "exterior DEM boundary" not in str(
        manifest.get("sourceBoundaryDefinition", "")
    ):
        raise AssertionError("Source is not selected from the open DEM boundary")
    if int(manifest.get("qualifiedSourceComponentCount", -1)) != 1:
        raise AssertionError("Expected one genuine exterior-connected source component")
    if "provenance only" not in str(manifest.get("manualSourceTreatment", "")):
        raise AssertionError("Manual polygons can still qualify source components")
    if source_pixels != expected_source_pixels:
        raise AssertionError(
            f"Expected {expected_source_pixels} source pixels, found {source_pixels}"
        )
    if source_pixels <= manual_source_pixels:
        raise AssertionError(
            "Source does not contain the complete exterior-connected 2.0-ft footprint"
        )
    if int(manifest.get("bulkheadNominalWidthCells", 0)) != 21:
        raise AssertionError("Graph does not declare a 21-cell bulkhead")

    hard_zone_ids: set[int] = set()
    source_zone_ids: set[int] = set()
    source_zone_ids_with_positive_depth_at_2ft: set[int] = set()
    grate_zone_count = 0
    row_count = 0
    with (graph / "zones.csv").open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            row_count += 1
            zone_id = int(row["zone_id"])
            cell_count = int(row["cell_count"])
            hard_cells = int(row["hard_cells"])
            source_cells = int(row["source_cells"])
            grate_cells = int(row["grate_cells"])
            histogram = [int(value) for value in row["hist_counts"].split(":")]
            histogram_total = sum(histogram)
            if histogram_total != cell_count:
                raise AssertionError(f"Zone {zone_id} hypsometry does not match cell count")
            if hard_cells:
                hard_zone_ids.add(zone_id)
                if hard_cells != cell_count:
                    raise AssertionError(
                        f"Bulkhead zone {zone_id} also contains non-bulkhead terrain"
                    )
            if source_cells:
                source_zone_ids.add(zone_id)
                if source_cells != cell_count:
                    raise AssertionError(
                        f"Source zone {zone_id} also contains interior terrain"
                    )
                hist_min10 = int(row["hist_min10"])
                below_2ft_bins = max(0, min(len(histogram), 20 - hist_min10))
                if sum(histogram[:below_2ft_bins]) > 0:
                    source_zone_ids_with_positive_depth_at_2ft.add(zone_id)
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
    source_flag = np.memmap(
        graph / "source_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(height, width),
    )
    if int(elevation10[source_flag != 0].max()) > 20:
        raise AssertionError("A fixed-head source cell is above 2.0 ft NAVD88")

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
    source_edge_records = 0
    source_shared_edge_width_ft = 0
    with (graph / "edges.csv").open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            a_is_source = int(row["zone_a"]) in source_zone_ids
            b_is_source = int(row["zone_b"]) in source_zone_ids
            crosses_source_perimeter = a_is_source != b_is_source
            if crosses_source_perimeter:
                source_edge_records += 1
                source_shared_edge_width_ft += int(row["width_ft"])
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
    if not source_edge_records or not source_shared_edge_width_ft:
        raise AssertionError("Source zones have no explicit shared-edge exchange")

    header, states = load_states(args.states.resolve(), zone_count + 1)
    dry = int(header.get("drySentinelCentift", -32768))
    if int(header.get("stageCount", 0)) != 101:
        raise AssertionError("State package does not contain 101 operational stage levels")
    if not math.isclose(float(header.get("stageMinNavd88Ft", math.nan)), 0.0):
        raise AssertionError("State package does not start at 0.0 ft NAVD88")
    if not math.isclose(float(header.get("stageMaxNavd88Ft", math.nan)), 10.0):
        raise AssertionError("State package does not end at 10.0 ft NAVD88")
    if not math.isclose(float(header.get("stageStepFt", math.nan)), 0.1):
        raise AssertionError("State package does not use 0.1-ft increments")
    if np.array_equal(states["rising_slow"], states["rising_fast"]):
        raise AssertionError("Slow and fast rising states are identical")
    if np.array_equal(states["rising_typical"], states["falling_moderate"]):
        raise AssertionError("Rising and falling states did not retain history")
    hard_lookup = np.asarray(sorted(hard_zone_ids), dtype=np.int64) + 1
    source_lookup = np.asarray(sorted(source_zone_ids), dtype=np.int64) + 1
    source_positive_depth_lookup = (
        np.asarray(
            sorted(source_zone_ids_with_positive_depth_at_2ft),
            dtype=np.int64,
        )
        + 1
    )
    source_zero_depth_lookup = (
        np.asarray(
            sorted(source_zone_ids - source_zone_ids_with_positive_depth_at_2ft),
            dtype=np.int64,
        )
        + 1
    )
    terrain_lookup = (
        np.asarray(
            sorted(set(range(zone_count)) - source_zone_ids),
            dtype=np.int64,
        )
        + 1
    )
    for phase in ("rising_slow", "rising_typical", "rising_fast", "crest"):
        if np.any(states[phase][74, hard_lookup] != dry):
            raise AssertionError(
                f"{phase} state wets a bulkhead before 7.5 ft NAVD88"
            )
        if np.any(states[phase][19, source_lookup] != dry):
            raise AssertionError(f"{phase} activates a source block below 2.0 ft")
        if np.any(states[phase][20, source_positive_depth_lookup] == dry):
            raise AssertionError(
                f"{phase} omits positive-depth source storage at 2.0 ft"
            )
        if source_zero_depth_lookup.size and np.any(
            states[phase][20, source_zero_depth_lookup] != dry
        ):
            raise AssertionError(
                f"{phase} invents water volume in zero-depth source zones at 2.0 ft"
            )
        if np.any(states[phase][20, terrain_lookup] != dry):
            raise AssertionError(f"{phase} wets exterior terrain at 2.0 ft")
        if np.any(states[phase][21, source_lookup] == dry):
            raise AssertionError(
                f"{phase} does not fill the complete source footprint by 2.1 ft"
            )

    physics = header.get("physics") or {}
    if physics.get("modelKind") != "history-aware subgrid diffusive-wave finite-volume response atlas":
        raise AssertionError("State package does not declare finite-volume routing")
    if physics.get("historyInvariant") is not False:
        raise AssertionError("State package does not declare history-aware states")
    if "Manning diffusive-wave" not in str(physics.get("terrainFlow", "")):
        raise AssertionError("State package does not declare diffusive-wave flow")
    if physics.get("sourceZoneIsolation") is not True:
        raise AssertionError("State package does not declare source-zone isolation")
    if int(physics.get("sourceBoundaryPixelCount", -1)) != source_pixels:
        raise AssertionError("State package source footprint does not match graph")
    if "explicit shared-edge flux" not in str(physics.get("sourceExchange", "")):
        raise AssertionError("State package still declares component-wide source flow")
    if not math.isclose(
        float(physics.get("freeOverflowWeirCoefficientCfs", math.nan)),
        3.10,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong weir coefficient")
    if not math.isclose(
        float(physics.get("urbanOverlandManningN", math.nan)),
        0.12,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package has the wrong overland Manning n")
    if not math.isclose(
        float(physics.get("sourceBlockActivationNavd88Ft", math.nan)),
        2.0,
        abs_tol=1e-12,
    ):
        raise AssertionError("State package does not activate source blocks at 2.0 ft")
    if "directionally gated" not in str(physics.get("sourceInterfaceTreatment", "")):
        raise AssertionError("State package does not declare directional source inflow")
    if "recession flow" not in str(physics.get("sourceInterfaceTreatment", "")):
        raise AssertionError("State package does not preserve source drainage")
    if "minimum mobile depth" not in str(physics.get("frontPropagation", "")):
        raise AssertionError("State package does not enforce finite front propagation")
    if not str(physics.get("stormDrains", "")).startswith("disabled"):
        raise AssertionError("State package does not declare disabled storm drains")
    if float(physics.get("bulkheadElevationNavd88Ft", math.nan)) != 7.5:
        raise AssertionError("State package does not declare the 7.5-ft bulkhead")
    if int(physics.get("bulkheadNominalWidthCells", 0)) != 21:
        raise AssertionError("State package does not declare a 21-cell bulkhead")
    diagnostics = header.get("diagnostics") or {}
    if diagnostics.get("historyInvariant") is not False:
        raise AssertionError("Diagnostics do not declare history-aware routing")
    if float(diagnostics.get("maximumInternalConservationResidualFt3", math.inf)) > 1e-5:
        raise AssertionError("Internal finite-volume routing is not conservative")
    if int(diagnostics.get("diagnosticStepCount", 0)) < 101:
        raise AssertionError("Finite-volume diagnostics are incomplete")

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
                "manualSourcePixels": manual_source_pixels,
                "qualifiedSourceBoundaryPixels": source_pixels,
                "qualifiedSourceComponents": int(
                    manifest["qualifiedSourceComponentCount"]
                ),
                "sourceZones": len(source_zone_ids),
                "sourceSharedEdgeRecords": source_edge_records,
                "sourceSharedEdgeWidthFt": source_shared_edge_width_ft,
                "sourceZonesMixedWithTerrain": 0,
                "modelKind": physics["modelKind"],
                "historyInvariant": physics["historyInvariant"],
                "maximumInternalConservationResidualFt3": diagnostics[
                    "maximumInternalConservationResidualFt3"
                ],
                "stateFamilies": list(states),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
