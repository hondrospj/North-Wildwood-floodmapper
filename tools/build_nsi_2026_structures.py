#!/usr/bin/env python3
"""Build the North Wildwood USACE NSI 2026 structure/floor asset.

NSI foundation height is fused with the mapper's local bare-earth LiDAR ground
elevation. The resulting modeled first-floor elevation is an impact threshold,
not hydraulic terrain. The public NSI ``bid`` (a UBID bounding-envelope
identifier) is retained as structure provenance and for future footprint-aware
impact work.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from osgeo import ogr

from build_parcel_alerts import DemSampler


NSI_STRUCTURES_URL = "https://nsi.sec.usace.army.mil/nsiapi/structures?fmt=fc"
MUNICIPAL_BOUNDARY_URL = (
    "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/"
    "NJ_Municipalities_3857/FeatureServer/0/query"
)
MUNICIPAL_WHERE = "MUN_LABEL = 'North Wildwood City'"
PARCEL_INDEX_CELL_DEGREES = 0.002
FOUNDATION_NAMES = {
    "B": "Basement",
    "C": "Crawlspace",
    "F": "Fill",
    "I": "Pile",
    "P": "Pier",
    "S": "Slab",
    "W": "Solid wall",
}


def fetch_json(url: str, params: dict | None = None, body: dict | None = None) -> dict:
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    encoded = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/geo+json,application/json",
        "User-Agent": "North-Wildwood-floodmapper-NSI-2026/1.0",
    }
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=encoded, headers=headers)
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.loads(response.read().decode("utf-8"))


def load_or_fetch_boundary(path: Path | None) -> dict:
    if path:
        return json.loads(path.read_text(encoding="utf-8"))
    payload = fetch_json(
        MUNICIPAL_BOUNDARY_URL,
        {
            "f": "geojson",
            "where": MUNICIPAL_WHERE,
            "outFields": "NAME,COUNTY,MUN_LABEL,MUN_CODE",
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "7",
        },
    )
    if len(payload.get("features", [])) != 1:
        raise RuntimeError("The official NJGIS North Wildwood boundary query did not return one feature")
    return payload


def load_or_fetch_nsi(path: Path | None, boundary: dict) -> dict:
    if path:
        return json.loads(path.read_text(encoding="utf-8"))
    # The documented complex-polygon POST currently returns HTTP 500 for the
    # detailed North Wildwood coastline. Query its small enclosing rectangle
    # and apply the exact official polygon in clip_and_model_structures instead.
    boundary_geometry = geometry_from_feature(boundary["features"][0])
    west, east, south, north = boundary_geometry.GetEnvelope()
    bbox_ring = ",".join(
        str(value)
        for value in (
            west,
            south,
            east,
            south,
            east,
            north,
            west,
            north,
            west,
            south,
        )
    )
    return fetch_json(NSI_STRUCTURES_URL, {"bbox": bbox_ring})


def geometry_from_feature(feature: dict) -> ogr.Geometry:
    geometry = ogr.CreateGeometryFromJson(json.dumps(feature.get("geometry")))
    if geometry is None or geometry.IsEmpty():
        raise ValueError("Feature has no usable geometry")
    return geometry


def finite_number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rounded(value: float | None, digits: int = 2):
    return round(value, digits) if value is not None and math.isfinite(value) else None


def clip_and_model_structures(
    nsi_payload: dict,
    boundary_payload: dict,
    sampler: DemSampler,
) -> tuple[list[dict], dict]:
    boundary = geometry_from_feature(boundary_payload["features"][0])
    grouped: dict[str, list[dict]] = defaultdict(list)
    input_count = 0
    inside_count = 0
    for feature in nsi_payload.get("features", []):
        input_count += 1
        try:
            point = geometry_from_feature(feature)
        except ValueError:
            continue
        if not boundary.Intersects(point):
            continue
        inside_count += 1
        properties = feature.get("properties") or {}
        footprint_id = str(properties.get("ftprntid") or "").strip()
        fallback_id = str(properties.get("fd_id") or input_count)
        grouped[footprint_id or f"record-{fallback_id}"].append(feature)

    structures: list[dict] = []
    skipped_no_height = 0
    skipped_no_dem = 0
    for footprint_id, records in sorted(grouped.items()):
        candidates: list[dict] = []
        for record in records:
            properties = record.get("properties") or {}
            coordinates = record.get("geometry", {}).get("coordinates") or []
            if len(coordinates) < 2:
                continue
            lon, lat = finite_number(coordinates[0]), finite_number(coordinates[1])
            foundation_height = finite_number(properties.get("found_ht"))
            if lon is None or lat is None or foundation_height is None or foundation_height < 0:
                continue
            local_ground, sample_method = sampler.sample(lon, lat)
            if local_ground is None:
                continue
            nsi_ground = finite_number(properties.get("ground_elv"))
            candidates.append(
                {
                    "feature": record,
                    "properties": properties,
                    "lon": lon,
                    "lat": lat,
                    "foundation_height": foundation_height,
                    "local_ground": local_ground,
                    "nsi_ground": nsi_ground,
                    "first_floor": local_ground + foundation_height,
                    "sample_method": sample_method,
                }
            )
        if not candidates:
            has_foundation_height = any(
                finite_number((record.get("properties") or {}).get("found_ht")) is not None
                for record in records
            )
            if has_foundation_height:
                skipped_no_dem += 1
            else:
                skipped_no_height += 1
            continue

        # Stacked NSI records share a footprint.  Use the lowest modeled floor
        # so parcel screening does not hide the first potentially affected use.
        selected = min(candidates, key=lambda candidate: candidate["first_floor"])
        p = selected["properties"]
        damage_categories = sorted(
            {str((record.get("properties") or {}).get("st_damcat") or "").strip() for record in records}
            - {""}
        )
        occupancy_types = sorted(
            {str((record.get("properties") or {}).get("occtype") or "").strip() for record in records}
            - {""}
        )
        residential_units = sum(
            max(0, int(finite_number((record.get("properties") or {}).get("resunits")) or 0))
            for record in records
        )
        nsi_first_floor = (
            selected["nsi_ground"] + selected["foundation_height"]
            if selected["nsi_ground"] is not None
            else None
        )
        foundation_code = str(p.get("found_type") or "").strip().upper()
        structures.append(
            {
                "type": "Feature",
                "id": p.get("fd_id") or footprint_id,
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(selected["lon"], 7), round(selected["lat"], 7)],
                },
                "properties": {
                    "footprintId": footprint_id,
                    "buildingId": p.get("bid"),
                    "nsiRecordCount": len(records),
                    "damageCategory": ",".join(damage_categories),
                    "occupancyType": ",".join(occupancy_types),
                    "residentialUnits": residential_units,
                    "foundationType": foundation_code or None,
                    "foundationTypeName": FOUNDATION_NAMES.get(foundation_code, "Unknown"),
                    "foundationHeightFt": rounded(selected["foundation_height"]),
                    "localGroundNavd88Ft": rounded(selected["local_ground"]),
                    "nsiGroundNavd88Ft": rounded(selected["nsi_ground"]),
                    "modeledFirstFloorNavd88Ft": rounded(selected["first_floor"]),
                    "nsiFirstFloorNavd88Ft": rounded(nsi_first_floor),
                    "groundDeltaFt": rounded(
                        selected["local_ground"] - selected["nsi_ground"]
                        if selected["nsi_ground"] is not None
                        else None
                    ),
                    "localGroundSampleMethod": selected["sample_method"],
                    "stories": rounded(finite_number(p.get("num_story")), 1),
                    "footprintSqFt": rounded(finite_number(p.get("ftprntsqft")), 0),
                    "source": p.get("source"),
                    "footprintSource": p.get("ftprntsrc"),
                    "method": "localLiDARGroundPlusNSIFoundationHeight",
                },
            }
        )

    first_floors = [feature["properties"]["modeledFirstFloorNavd88Ft"] for feature in structures]
    foundation_counts = Counter(feature["properties"]["foundationType"] or "unknown" for feature in structures)
    metadata = {
        "inputRecordCount": input_count,
        "municipalRecordCount": inside_count,
        "uniqueFootprintCount": len(grouped),
        "modeledStructureCount": len(structures),
        "collapsedStackedRecordCount": inside_count - len(grouped),
        "skippedNoFoundationHeightCount": skipped_no_height,
        "skippedNoLocalDemCount": skipped_no_dem,
        "modeledFirstFloorRangeNavd88Ft": [min(first_floors), max(first_floors)] if first_floors else [],
        "foundationTypeCounts": dict(sorted(foundation_counts.items())),
    }
    return structures, metadata


def parcel_grid_cells(envelope: tuple[float, float, float, float]):
    min_lon, max_lon, min_lat, max_lat = envelope
    col_min = math.floor(min_lon / PARCEL_INDEX_CELL_DEGREES)
    col_max = math.floor(max_lon / PARCEL_INDEX_CELL_DEGREES)
    row_min = math.floor(min_lat / PARCEL_INDEX_CELL_DEGREES)
    row_max = math.floor(max_lat / PARCEL_INDEX_CELL_DEGREES)
    for col in range(col_min, col_max + 1):
        for row in range(row_min, row_max + 1):
            yield col, row


def model_elevation_record(first_floor: float, cdf: dict) -> tuple[float, int, int | None]:
    grid = [float(value) for value in cdf.get("elevationGridFtNavd88", [])]
    if not grid:
        return round(first_floor, 1), -1, None
    index = min(range(len(grid)), key=lambda candidate: abs(grid[candidate] - first_floor))
    counts = cdf.get("historicFloodEventCountByElevation") or []
    historic_count = int(counts[index]) if index < len(counts) else None
    return grid[index], index, historic_count


def augment_parcels(parcel_payload: dict, structures: list[dict], cdf: dict) -> dict:
    parcel_features = parcel_payload.get("features", [])
    parcel_geometries: list[ogr.Geometry | None] = []
    spatial_index: dict[tuple[int, int], list[int]] = defaultdict(list)
    for index, feature in enumerate(parcel_features):
        try:
            geometry = geometry_from_feature(feature)
        except ValueError:
            geometry = None
        parcel_geometries.append(geometry)
        if geometry is not None:
            for cell in parcel_grid_cells(geometry.GetEnvelope()):
                spatial_index[cell].append(index)

    matches: dict[int, list[dict]] = defaultdict(list)
    unmatched = 0
    for structure in structures:
        lon, lat = structure["geometry"]["coordinates"]
        point = ogr.Geometry(ogr.wkbPoint)
        point.AddPoint(float(lon), float(lat))
        cell = (
            math.floor(float(lon) / PARCEL_INDEX_CELL_DEGREES),
            math.floor(float(lat) / PARCEL_INDEX_CELL_DEGREES),
        )
        containing = [
            index
            for index in spatial_index.get(cell, [])
            if parcel_geometries[index] is not None and parcel_geometries[index].Intersects(point)
        ]
        if not containing:
            unmatched += 1
            continue
        structure["properties"]["parcelMatchCount"] = len(containing)
        matched_properties = [parcel_features[index].get("properties") or {} for index in containing]
        labeled_parcel = next(
            (properties for properties in matched_properties if str(properties.get("address") or "").strip()),
            matched_properties[0],
        )
        structure["properties"]["parcelId"] = labeled_parcel.get("parcelId")
        structure["properties"]["address"] = labeled_parcel.get("address")
        for index in containing:
            matches[index].append(structure)

    matched_parcels = 0
    residential_parcels = 0
    for index, feature in enumerate(parcel_features):
        candidates = matches.get(index, [])
        if not candidates:
            continue
        matched_parcels += 1
        residential = [
            candidate
            for candidate in candidates
            if "RES" in str(candidate["properties"].get("damageCategory") or "").split(",")
        ]
        eligible = residential or candidates
        if residential:
            residential_parcels += 1
        selected = min(eligible, key=lambda candidate: candidate["properties"]["modeledFirstFloorNavd88Ft"])
        structure_properties = selected["properties"]
        first_floor = float(structure_properties["modeledFirstFloorNavd88Ft"])
        model_elevation, model_index, historic_count = model_elevation_record(first_floor, cdf)
        properties = feature.setdefault("properties", {})
        properties.update(
            {
                "nsi2026StructureCount": len(candidates),
                "nsi2026RecordCount": sum(int(candidate["properties"].get("nsiRecordCount") or 1) for candidate in candidates),
                "nsi2026ResidentialStructureCount": len(residential),
                "nsi2026FootprintId": structure_properties.get("footprintId"),
                "nsi2026DamageCategory": structure_properties.get("damageCategory"),
                "nsi2026OccupancyType": structure_properties.get("occupancyType"),
                "nsi2026FoundationType": structure_properties.get("foundationType"),
                "nsi2026FoundationTypeName": structure_properties.get("foundationTypeName"),
                "nsi2026FoundationHeightFt": structure_properties.get("foundationHeightFt"),
                "nsi2026LocalGroundNavd88Ft": structure_properties.get("localGroundNavd88Ft"),
                "nsi2026GroundNavd88Ft": structure_properties.get("nsiGroundNavd88Ft"),
                "nsi2026ModeledFirstFloorNavd88Ft": structure_properties.get("modeledFirstFloorNavd88Ft"),
                "nsi2026ModelElevationNavd88Ft": model_elevation,
                "nsi2026ModelElevationIndex": model_index,
                "nsi2026HistoricFirstFloorExceedanceCount": historic_count,
                "nsi2026Method": "localLiDARGroundPlusNSIFoundationHeight",
            }
        )

    metadata = parcel_payload.setdefault("metadata", {})
    metadata["nsi2026"] = {
        "source": "USACE National Structure Inventory 2026 Base",
        "method": "local 2019 bare-earth LiDAR ground plus NSI modeled foundation height",
        "matchedParcelCount": matched_parcels,
        "matchedResidentialParcelCount": residential_parcels,
        "unmatchedStructureCount": unmatched,
        "firstFloorThresholdUse": (
            "structure-impact screening without modifying hydraulic terrain"
        ),
    }
    return {
        "matchedParcelCount": matched_parcels,
        "matchedResidentialParcelCount": residential_parcels,
        "unmatchedStructureCount": unmatched,
    }


def build(args: argparse.Namespace) -> dict:
    boundary = load_or_fetch_boundary(args.boundary.resolve() if args.boundary else None)
    nsi_payload = load_or_fetch_nsi(args.nsi.resolve() if args.nsi else None, boundary)
    sampler = DemSampler(args.dem.resolve())
    structures, structure_summary = clip_and_model_structures(nsi_payload, boundary, sampler)

    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    feature_collection = {
        "type": "FeatureCollection",
        "name": "North Wildwood modeled first-floor elevations from USACE NSI 2026",
        "metadata": {
            "schema": "north-wildwood-nsi-2026-first-floor-v1",
            "generatedUtc": generated_utc,
            "source": "USACE National Structure Inventory 2026 Base",
            "sourceUrl": "https://nsi.sec.usace.army.mil/",
            "apiUrl": NSI_STRUCTURES_URL,
            "municipality": "North Wildwood City, New Jersey",
            "municipalityCode": "0507",
            "elevationDatum": "NAVD88 feet",
            "localGroundSource": "2019 South Jersey five-foot bare-earth LiDAR resampled to the mapper one-foot grid",
            "firstFloorFormula": "localGroundNavd88Ft + NSI found_ht",
            "hydraulicTerrainModified": False,
            "hydraulicTerrainMethod": (
                "not burned; bulkhead-conditioned bare-earth DEM remains the "
                "hydraulic surface"
            ),
            "limitations": "Modeled screening estimates, not surveys, elevation certificates, insurance determinations, or verified structure-level observations.",
            **structure_summary,
        },
        "features": structures,
    }
    parcel_summary = {}
    if not args.no_update_parcels:
        parcel_path = args.parcels.resolve()
        cdf = json.loads(args.cdf.resolve().read_text(encoding="utf-8"))
        parcel_payload = json.loads(parcel_path.read_text(encoding="utf-8"))
        parcel_summary = augment_parcels(parcel_payload, structures, cdf)
        feature_collection["metadata"].update(parcel_summary)
        parcel_path.write_text(json.dumps(parcel_payload, separators=(",", ":")) + "\n", encoding="utf-8")

    structure_path = output_dir / "NorthWildwoodNSI2026Structures.geojson"
    structure_path.write_text(json.dumps(feature_collection, separators=(",", ":")) + "\n", encoding="utf-8")

    if not args.no_update_parcels:
        manifest_path = parcel_path.parent / "NorthWildwoodParcelAlertManifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
        manifest["nsi2026"] = {
            **structure_summary,
            **parcel_summary,
            "structureGeoJsonBytes": structure_path.stat().st_size,
            "generatedUtc": generated_utc,
        }
        manifest["parcelGeoJsonBytes"] = parcel_path.stat().st_size
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    summary = {
        **structure_summary,
        **parcel_summary,
        "structureGeoJsonBytes": structure_path.stat().st_size,
        "output": str(structure_path),
    }
    (output_dir / "NorthWildwoodNSI2026Manifest.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", type=Path, required=True, help="Mapper bare-earth DEM in NAVD88 feet")
    parser.add_argument("--nsi", type=Path, help="Optional cached NSI GeoJSON; otherwise POST the city boundary to the API")
    parser.add_argument("--boundary", type=Path, help="Optional cached official North Wildwood boundary GeoJSON")
    parser.add_argument("--output", type=Path, default=Path("assets/nsi-2026"))
    parser.add_argument("--parcels", type=Path, default=Path("assets/parcel-history-v2/NorthWildwoodParcels.geojson"))
    parser.add_argument("--cdf", type=Path, default=Path("assets/parcel-history-v2/NorthWildwoodHouseAlertCDF.json"))
    parser.add_argument("--no-update-parcels", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
