#!/usr/bin/env python3
"""Audit North Wildwood's source interfaces and static graph bottlenecks.

This diagnostic intentionally does not run a flood simulation. It answers two
questions that must be settled before choosing a routing scheme:

* how much source perimeter is exposed to terrain at each crest elevation; and
* which finite-storage components become statically connected through small
  cross-sections as the boundary stage rises.

The report is derived from the actual one-foot/25-foot graph used to build the
public atlas, not from hand-entered representative basins.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from osgeo import osr


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--top", type=int, default=30)
    return parser.parse_args()


def load_zone_summary(path: Path) -> dict[str, np.ndarray]:
    cell_count: list[int] = []
    source_cells: list[int] = []
    connection10: list[int] = []
    with path.open(newline="", encoding="utf-8") as stream:
        for expected, row in enumerate(csv.DictReader(stream)):
            zone_id = int(row["zone_id"])
            if zone_id != expected:
                raise RuntimeError("Zone IDs are not contiguous")
            cell_count.append(int(row["cell_count"]))
            source_cells.append(int(row["source_cells"]))
            connection10.append(int(row["connection10"]))
    return {
        "cell_count": np.asarray(cell_count, dtype=np.int64),
        "source": np.asarray(source_cells, dtype=np.int64) > 0,
        "connection10": np.asarray(connection10, dtype=np.int16),
    }


def load_edges(path: Path) -> dict[str, np.ndarray]:
    values = np.loadtxt(path, delimiter=",", skiprows=1, dtype=np.float64)
    return {
        "a": values[:, 0].astype(np.int32),
        "b": values[:, 1].astype(np.int32),
        "crest10": values[:, 2].astype(np.int16),
        "width_ft": values[:, 3].astype(np.float64),
    }


class UnionFind:
    def __init__(self, cell_count: np.ndarray, source: np.ndarray):
        self.parent = np.arange(cell_count.size, dtype=np.int32)
        self.size = np.ones(cell_count.size, dtype=np.int32)
        self.cells = cell_count.copy()
        self.source = source.copy()

    def find(self, item: int) -> int:
        root = item
        while self.parent[root] != root:
            root = int(self.parent[root])
        while self.parent[item] != item:
            parent = int(self.parent[item])
            self.parent[item] = root
            item = parent
        return root

    def union(self, first: int, second: int) -> int:
        a = self.find(first)
        b = self.find(second)
        if a == b:
            return a
        if self.size[a] < self.size[b]:
            a, b = b, a
        self.parent[b] = a
        self.size[a] += self.size[b]
        self.cells[a] += self.cells[b]
        self.source[a] = self.source[a] or self.source[b]
        return a


def projected_to_wgs84(x: float, y: float) -> tuple[float, float]:
    source = osr.SpatialReference()
    source.ImportFromEPSG(6527)
    target = osr.SpatialReference()
    target.ImportFromEPSG(4326)
    source.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    longitude, latitude, _ = osr.CoordinateTransformation(source, target).TransformPoint(x, y)
    return float(longitude), float(latitude)


def locate_zones(
    graph_dir: Path,
    manifest: dict,
    zone_ids: set[int],
) -> dict[int, dict[str, float]]:
    if not zone_ids:
        return {}
    width = int(manifest["width"])
    height = int(manifest["height"])
    raster = np.memmap(
        graph_dir / "zone_id.raw",
        dtype="<i4",
        mode="r",
        shape=(height, width),
    )
    targets = np.asarray(sorted(zone_ids), dtype=np.int32)
    accum = {
        int(zone): {
            "count": 0,
            "sumRow": 0.0,
            "sumCol": 0.0,
            "minRow": height,
            "maxRow": -1,
            "minCol": width,
            "maxCol": -1,
        }
        for zone in targets
    }
    for row0 in range(0, height, 256):
        block = np.asarray(raster[row0 : min(height, row0 + 256)])
        present = np.isin(block, targets)
        if not np.any(present):
            continue
        local_rows, columns = np.nonzero(present)
        rows = local_rows + row0
        values = block[local_rows, columns]
        for zone in np.unique(values):
            chosen = values == zone
            selected_rows = rows[chosen]
            selected_columns = columns[chosen]
            record = accum[int(zone)]
            record["count"] += int(chosen.sum())
            record["sumRow"] += float(selected_rows.sum())
            record["sumCol"] += float(selected_columns.sum())
            record["minRow"] = min(record["minRow"], int(selected_rows.min()))
            record["maxRow"] = max(record["maxRow"], int(selected_rows.max()))
            record["minCol"] = min(record["minCol"], int(selected_columns.min()))
            record["maxCol"] = max(record["maxCol"], int(selected_columns.max()))

    origin_x, pixel_x, _, origin_y, _, pixel_y = manifest["geotransform"]
    result: dict[int, dict[str, float]] = {}
    for zone, record in accum.items():
        if not record["count"]:
            continue
        center_col = record["sumCol"] / record["count"] + 0.5
        center_row = record["sumRow"] / record["count"] + 0.5
        x = origin_x + center_col * pixel_x
        y = origin_y + center_row * pixel_y
        longitude, latitude = projected_to_wgs84(x, y)
        result[zone] = {
            "pixelCount": int(record["count"]),
            "centerEastingFt": round(x, 2),
            "centerNorthingFt": round(y, 2),
            "longitude": round(longitude, 7),
            "latitude": round(latitude, 7),
            "minRow": int(record["minRow"]),
            "maxRow": int(record["maxRow"]),
            "minColumn": int(record["minCol"]),
            "maxColumn": int(record["maxCol"]),
        }
    return result


def audit_sources(
    zones: dict[str, np.ndarray],
    edges: dict[str, np.ndarray],
) -> tuple[list[dict], dict[int, int]]:
    source = zones["source"]
    source_ids = np.flatnonzero(source)
    source_index = {int(zone): index for index, zone in enumerate(source_ids)}
    source_uf = UnionFind(
        zones["cell_count"][source_ids],
        np.ones(source_ids.size, dtype=bool),
    )
    both_source = source[edges["a"]] & source[edges["b"]]
    for a, b in zip(edges["a"][both_source], edges["b"][both_source]):
        source_uf.union(source_index[int(a)], source_index[int(b)])
    root_for_zone = {
        int(zone): source_uf.find(source_index[int(zone)])
        for zone in source_ids
    }
    interface = source[edges["a"]] ^ source[edges["b"]]
    records: dict[int, dict] = {}
    for a, b, crest10, width in zip(
        edges["a"][interface],
        edges["b"][interface],
        edges["crest10"][interface],
        edges["width_ft"][interface],
    ):
        source_zone = int(a if source[a] else b)
        terrain_zone = int(b if source[a] else a)
        root = root_for_zone[source_zone]
        record = records.setdefault(
            root,
            {
                "sourceZones": set(),
                "terrainZones": set(),
                "sourceCells": 0,
                "interfaceWidthFt": 0.0,
                "widthByCrest10": defaultdict(float),
            },
        )
        record["sourceZones"].add(source_zone)
        record["terrainZones"].add(terrain_zone)
        record["interfaceWidthFt"] += float(width)
        record["widthByCrest10"][int(crest10)] += float(width)
    for root, record in records.items():
        members = [zone for zone, member_root in root_for_zone.items() if member_root == root]
        record["sourceZones"].update(members)
        record["sourceCells"] = int(zones["cell_count"][members].sum())

    output: list[dict] = []
    source_component_for_zone: dict[int, int] = {}
    for component_id, (_, record) in enumerate(
        sorted(records.items(), key=lambda item: -item[1]["sourceCells"]),
        start=1,
    ):
        for zone in record["sourceZones"]:
            source_component_for_zone[zone] = component_id
        width_by_crest = [
            {
                "crestNavd88Ft": crest10 / 10.0,
                "widthFt": round(width, 3),
            }
            for crest10, width in sorted(record["widthByCrest10"].items())
        ]
        output.append(
            {
                "componentId": component_id,
                "sourceCellCount": record["sourceCells"],
                "sourceZoneCount": len(record["sourceZones"]),
                "adjacentTerrainZoneCount": len(record["terrainZones"]),
                "totalInterfaceWidthFt": round(record["interfaceWidthFt"], 3),
                "interfaceWidthAtOrBelow2Ft": round(
                    sum(item["widthFt"] for item in width_by_crest if item["crestNavd88Ft"] <= 2.0),
                    3,
                ),
                "widthByCrest": width_by_crest,
                "representativeSourceZone": min(record["sourceZones"]),
            }
        )
    return output, source_component_for_zone


def audit_static_connections(
    zones: dict[str, np.ndarray],
    edges: dict[str, np.ndarray],
) -> list[dict]:
    uf = UnionFind(zones["cell_count"], zones["source"])
    order = np.argsort(edges["crest10"], kind="stable")
    records: list[dict] = []
    cursor = 0
    while cursor < order.size:
        crest10 = int(edges["crest10"][order[cursor]])
        end = cursor + 1
        while end < order.size and int(edges["crest10"][order[end]]) == crest10:
            end += 1
        batch = order[cursor:end]
        area_before = sum(
            int(uf.cells[index])
            for index in range(uf.parent.size)
            if uf.parent[index] == index and uf.source[index]
        )
        crossing: list[tuple[int, int, float, int]] = []
        for edge_index in batch:
            a = int(edges["a"][edge_index])
            b = int(edges["b"][edge_index])
            root_a = uf.find(a)
            root_b = uf.find(b)
            if root_a == root_b:
                continue
            if uf.source[root_a] ^ uf.source[root_b]:
                dry_root = root_b if uf.source[root_a] else root_a
                crossing.append(
                    (a, b, float(edges["width_ft"][edge_index]), int(uf.cells[dry_root]))
                )
        for edge_index in batch:
            uf.union(int(edges["a"][edge_index]), int(edges["b"][edge_index]))
        area_after = sum(
            int(uf.cells[index])
            for index in range(uf.parent.size)
            if uf.parent[index] == index and uf.source[index]
        )
        added = area_after - area_before
        if added > 0:
            initiating_width = sum(item[2] for item in crossing)
            representative = max(crossing, key=lambda item: item[3]) if crossing else None
            records.append(
                {
                    "connectionStageNavd88Ft": crest10 / 10.0,
                    "newlyConnectedCellCount": int(added),
                    "newlyConnectedAcres": round(added / 43_560.0, 5),
                    "initiatingCrossSectionWidthFt": round(initiating_width, 3),
                    "initiatingEdgeCount": len(crossing),
                    "representativeEdgeZoneA": representative[0] if representative else None,
                    "representativeEdgeZoneB": representative[1] if representative else None,
                    "largestPreMergeDryComponentCells": representative[3] if representative else 0,
                }
            )
        cursor = end
    return records


def main() -> None:
    args = parse_args()
    graph_dir = args.graph.resolve()
    manifest = json.loads((graph_dir / "graph_manifest.json").read_text(encoding="utf-8"))
    zones = load_zone_summary(graph_dir / "zones.csv")
    edges = load_edges(graph_dir / "edges.csv")
    sources, _ = audit_sources(zones, edges)
    connections = audit_static_connections(zones, edges)
    largest = sorted(
        connections,
        key=lambda item: item["newlyConnectedCellCount"],
        reverse=True,
    )[: args.top]
    narrow = sorted(
        (
            item
            for item in connections
            if item["initiatingCrossSectionWidthFt"] <= 10.0
            and item["newlyConnectedAcres"] >= 1.0
        ),
        key=lambda item: item["newlyConnectedCellCount"],
        reverse=True,
    )[: args.top]
    target_zones = {
        int(item[key])
        for item in (*largest, *narrow)
        for key in ("representativeEdgeZoneA", "representativeEdgeZoneB")
        if item[key] is not None
    }
    target_zones.update(int(item["representativeSourceZone"]) for item in sources)
    locations = locate_zones(graph_dir, manifest, target_zones)
    for item in (*largest, *narrow):
        item["representativeEdgeLocations"] = {
            "zoneA": locations.get(item["representativeEdgeZoneA"]),
            "zoneB": locations.get(item["representativeEdgeZoneB"]),
        }
    for item in sources:
        item["representativeLocation"] = locations.get(item["representativeSourceZone"])

    source_interface = zones["source"][edges["a"]] ^ zones["source"][edges["b"]]
    report = {
        "schema": "north-wildwood-hydraulic-graph-audit-v1",
        "graph": str(graph_dir),
        "zoneCount": int(zones["cell_count"].size),
        "edgeGroupCount": int(edges["a"].size),
        "sourceZoneCount": int(zones["source"].sum()),
        "sourceCellCount": int(zones["cell_count"][zones["source"]].sum()),
        "sourceTerrainEdgeGroupCount": int(source_interface.sum()),
        "sourceTerrainInterfaceWidthFt": round(float(edges["width_ft"][source_interface].sum()), 3),
        "sourceComponents": sources,
        "staticConnectionEventCount": len(connections),
        "largestStaticConnectionEvents": largest,
        "narrowLargeStaticConnectionEvents": narrow,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "sourceComponents": len(sources),
        "sourceTerrainInterfaceWidthFt": report["sourceTerrainInterfaceWidthFt"],
        "staticConnectionEventCount": len(connections),
        "largestStaticConnectionEvents": largest[:8],
        "narrowLargeStaticConnectionEvents": narrow[:8],
        "output": str(args.output.resolve()),
    }, indent=2))


if __name__ == "__main__":
    main()
