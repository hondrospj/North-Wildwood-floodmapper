#!/usr/bin/env python3
"""Build the five-foot public-road corridor mask used by visible feeders.

The input is an Overpass JSON response containing OSM highway ways. Only
public motor-vehicle roads are retained. Footways, paths, tracks, parking
aisles, driveways, and private/service-only ways are deliberately excluded.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr


gdal.UseExceptions()

RENDER_STRIDE = 5
PUBLIC_ROAD_CLASSES = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "residential",
    "unclassified",
    "living_street",
}
EXCLUDED_ACCESS = {"private", "no"}
EXCLUDED_SERVICE = {"driveway", "parking_aisle", "parking", "drive-through"}
DEFAULT_FULL_WIDTH_FT = {
    "primary": 42.0,
    "primary_link": 28.0,
    "secondary": 38.0,
    "secondary_link": 26.0,
    "tertiary": 34.0,
    "tertiary_link": 24.0,
    "residential": 30.0,
    "unclassified": 26.0,
    "living_street": 24.0,
    "service": 14.0,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--overpass", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def parse_width_ft(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip().lower()
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(m|meter|meters|ft|feet|')?", text)
    if not match:
        return None
    width = float(match.group(1))
    unit = match.group(2) or "m"
    return width * 3.280839895 if unit in {"m", "meter", "meters"} else width


def road_width_ft(tags: dict[str, str]) -> float:
    explicit = parse_width_ft(tags.get("width"))
    if explicit is not None:
        return min(80.0, max(12.0, explicit))
    lanes_text = tags.get("lanes", "").strip()
    if lanes_text.isdigit():
        # Eleven-foot travel lanes plus a modest total shoulder/parking margin.
        return min(80.0, max(14.0, int(lanes_text) * 11.0 + 6.0))
    return DEFAULT_FULL_WIDTH_FT[tags["highway"]]


def is_public_road(tags: dict[str, str]) -> bool:
    highway = tags.get("highway", "")
    if tags.get("access", "") in EXCLUDED_ACCESS:
        return False
    if highway in PUBLIC_ROAD_CLASSES:
        return True
    if highway != "service":
        return False
    # Retain only named public service streets/alleys. This keeps real roads
    # such as Hoffman Canal Avenue without admitting driveways and parking lots.
    return bool(tags.get("name")) and tags.get("service", "") not in EXCLUDED_SERVICE


def spatial_reference(epsg: int) -> osr.SpatialReference:
    reference = osr.SpatialReference()
    reference.ImportFromEPSG(epsg)
    reference.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return reference


def main() -> None:
    args = parse_args()
    payload = json.loads(args.overpass.read_text(encoding="utf-8"))
    source_reference = spatial_reference(4326)
    target_reference = spatial_reference(6527)
    transform = osr.CoordinateTransformation(source_reference, target_reference)

    dem = gdal.Open(str(args.dem))
    if dem is None:
        raise FileNotFoundError(args.dem)
    if dem.RasterXSize % RENDER_STRIDE or dem.RasterYSize % RENDER_STRIDE:
        raise RuntimeError("DEM dimensions are not divisible by the render stride")
    dem_transform = dem.GetGeoTransform()
    output_transform = (
        dem_transform[0],
        dem_transform[1] * RENDER_STRIDE,
        dem_transform[2],
        dem_transform[3],
        dem_transform[4],
        dem_transform[5] * RENDER_STRIDE,
    )
    output_width = dem.RasterXSize // RENDER_STRIDE
    output_height = dem.RasterYSize // RENDER_STRIDE
    projection = dem.GetProjection()
    dem = None

    memory_driver = ogr.GetDriverByName("Memory")
    vector = memory_driver.CreateDataSource("public-road-corridors")
    layer = vector.CreateLayer("corridors", target_reference, ogr.wkbPolygon)
    retained = 0
    retained_by_class: dict[str, int] = {}
    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        geometry = element.get("geometry", [])
        if element.get("type") != "way" or len(geometry) < 2 or not is_public_road(tags):
            continue
        line = ogr.Geometry(ogr.wkbLineString)
        for point in geometry:
            line.AddPoint_2D(float(point["lon"]), float(point["lat"]))
        line.Transform(transform)
        corridor = line.Buffer(road_width_ft(tags) / 2.0, 8)
        if corridor is None or corridor.IsEmpty():
            continue
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetGeometry(corridor)
        layer.CreateFeature(feature)
        retained += 1
        highway = tags["highway"]
        retained_by_class[highway] = retained_by_class.get(highway, 0) + 1

    if retained < 300:
        raise RuntimeError(f"Only {retained} public road ways survived filtering")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    driver = gdal.GetDriverByName("GTiff")
    raster = driver.Create(
        str(args.output),
        output_width,
        output_height,
        1,
        gdal.GDT_Byte,
        options=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=2"],
    )
    raster.SetProjection(projection)
    raster.SetGeoTransform(output_transform)
    band = raster.GetRasterBand(1)
    band.Fill(0)
    band.SetNoDataValue(0)
    gdal.RasterizeLayer(raster, [1], layer, burn_values=[1])
    road = band.ReadAsArray().astype(bool)
    road_pixels = int(np.count_nonzero(road))
    if road_pixels < 100_000:
        raise RuntimeError(f"Road mask is unexpectedly sparse: {road_pixels:,} pixels")
    band.SetDescription("openstreetmap_public_motor_vehicle_road_corridor")
    raster.SetMetadata(
        {
            "SOURCE": "OpenStreetMap contributors via Overpass API",
            "SOURCE_FILE": args.overpass.name,
            "GENERATED_UTC": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "FILTER": (
                "public primary/secondary/tertiary/residential/unclassified/"
                "living_street plus named public service streets; excludes "
                "footways, paths, tracks, parking aisles, driveways, private ways"
            ),
            "RENDER_CELL_SIZE_FT": str(RENDER_STRIDE),
            "ROAD_PIXEL_COUNT": str(road_pixels),
            "RETAINED_WAY_COUNT": str(retained),
        }
    )
    raster.FlushCache()
    raster = None
    vector = None

    print(
        json.dumps(
            {
                "status": "passed",
                "output": str(args.output),
                "width": output_width,
                "height": output_height,
                "renderCellSizeFt": RENDER_STRIDE,
                "retainedWays": retained,
                "retainedByClass": retained_by_class,
                "roadPixels": road_pixels,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
