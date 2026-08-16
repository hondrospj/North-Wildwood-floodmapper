#!/usr/bin/env python3
"""Validate the committed North Wildwood NSI 2026 structure integration."""

from __future__ import annotations

import json
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STRUCTURES_PATH = ROOT / "assets/nsi-2026/NorthWildwoodNSI2026Structures.geojson"
PARCELS_PATH = ROOT / "assets/parcel-history-v2/NorthWildwoodParcels.geojson"
CDF_PATH = ROOT / "assets/parcel-history-v2/NorthWildwoodHouseAlertCDF.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    structures = json.loads(STRUCTURES_PATH.read_text(encoding="utf-8"))
    parcels = json.loads(PARCELS_PATH.read_text(encoding="utf-8"))
    cdf = json.loads(CDF_PATH.read_text(encoding="utf-8"))

    metadata = structures.get("metadata") or {}
    features = structures.get("features") or []
    require(metadata.get("schema") == "north-wildwood-nsi-2026-first-floor-v1", "Unexpected NSI schema")
    require(
        metadata.get("hydraulicTerrainModified") is False,
        "NSI floors must remain impact thresholds, not hydraulic terrain",
    )
    require(len(features) == metadata.get("modeledStructureCount"), "Structure count metadata mismatch")
    require(len(features) >= 3800, "North Wildwood NSI footprint coverage unexpectedly fell below 3,800")

    footprint_ids: set[str] = set()
    building_id_count = 0
    for feature in features:
        require(feature.get("geometry", {}).get("type") == "Point", "NSI feature must be a point")
        properties = feature.get("properties") or {}
        footprint_id = str(properties.get("footprintId") or "")
        require(footprint_id and footprint_id not in footprint_ids, "Stacked or duplicate footprint remained")
        footprint_ids.add(footprint_id)
        local_ground = float(properties["localGroundNavd88Ft"])
        foundation_height = float(properties["foundationHeightFt"])
        first_floor = float(properties["modeledFirstFloorNavd88Ft"])
        require(
            math.isclose(first_floor, local_ground + foundation_height, abs_tol=0.011),
            f"First-floor formula failed for {footprint_id}",
        )
        require(properties.get("method") == "localLiDARGroundPlusNSIFoundationHeight", "Unexpected floor method")
        require(int(properties.get("parcelMatchCount") or 0) >= 1, "Structure was not joined to a parcel")
        if properties.get("buildingId"):
            building_id_count += 1

    require(building_id_count >= 3700, "NSI UBID coverage unexpectedly fell below 3,700 footprints")
    elevation_grid = cdf.get("elevationGridFtNavd88") or []
    historic_counts = cdf.get("historicFloodEventCountByElevation") or []
    require(len(elevation_grid) == len(historic_counts) and elevation_grid, "CDF grid is incomplete")

    matched_parcels = 0
    fallback_parcels = 0
    for feature in parcels.get("features", []):
        properties = feature.get("properties") or {}
        floor = properties.get("nsi2026ModeledFirstFloorNavd88Ft")
        if floor is None:
            fallback_parcels += 1
            continue
        matched_parcels += 1
        index = int(properties["nsi2026ModelElevationIndex"])
        require(0 <= index < len(elevation_grid), "Parcel NSI CDF index is outside the grid")
        require(
            properties.get("nsi2026HistoricFirstFloorExceedanceCount") == historic_counts[index],
            "Parcel NSI historic count does not match the CDF grid",
        )
        require(
            properties.get("nsi2026Method") == "localLiDARGroundPlusNSIFoundationHeight",
            "Parcel floor method is missing",
        )
        require("historicFloodEventCount" in properties, "Original parcel-ground history was removed")

    require(matched_parcels == metadata.get("matchedParcelCount"), "Matched parcel count metadata mismatch")
    require(matched_parcels >= 3600, "Matched parcel coverage unexpectedly fell below 3,600")
    require(fallback_parcels > 0, "Parcel fallback path is no longer represented")
    print(
        f"NSI 2026 integration validated: {len(features):,} footprints, "
        f"{matched_parcels:,} matched parcels, {fallback_parcels:,} parcel-ground fallbacks"
    )


if __name__ == "__main__":
    main()
