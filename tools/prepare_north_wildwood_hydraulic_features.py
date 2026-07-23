#!/usr/bin/env python3
"""Project and rasterize the user-supplied North Wildwood hydraulic ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal


FEATURES = {
    "bulkheads": {
        "stem": "north_wildwood_hard_structures",
        "raster": "bulkheads_1ft.tif",
        "expectedFeatures": 1,
        "expectedPixels": 11_200,
    },
    "grates": {
        "stem": "north_wildwood_storm_grates",
        "raster": "grates_1ft.tif",
        "expectedFeatures": 6,
        "expectedPixels": 6,
    },
    "sourceManual": {
        "stem": "north_wildwood_source_blocks",
        "raster": "source_manual_1ft.tif",
        "expectedFeatures": 6,
        "expectedPixels": 254_212,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def find_shapefile(root: Path, stem: str) -> Path:
    matches = list(root.rglob(f"{stem}.shp"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected one {stem}.shp in ZIP, found {len(matches)}")
    return matches[0]


def rasterize(
    vector_path: Path,
    destination: Path,
    width: int,
    height: int,
    transform: tuple[float, ...],
    projection: str,
) -> int:
    driver = gdal.GetDriverByName("GTiff")
    dataset = driver.Create(
        str(destination),
        width,
        height,
        1,
        gdal.GDT_Byte,
        options=[
            "TILED=YES",
            "BLOCKXSIZE=512",
            "BLOCKYSIZE=512",
            "COMPRESS=ZSTD",
            "SPARSE_OK=YES",
        ],
    )
    dataset.SetGeoTransform(transform)
    dataset.SetProjection(projection)
    band = dataset.GetRasterBand(1)
    band.SetNoDataValue(0)
    band.Fill(0)
    gdal.Rasterize(
        dataset,
        str(vector_path),
        options=gdal.RasterizeOptions(
            burnValues=[1],
            allTouched=True,
        ),
    )
    dataset.FlushCache()
    pixels = 0
    for y in range(0, height, 512):
        block = band.ReadAsArray(0, y, width, min(512, height - y))
        pixels += int(np.count_nonzero(block))
    dataset = None
    return pixels


def main() -> None:
    gdal.UseExceptions()
    args = parse_args()
    zip_path = args.zip.resolve()
    dem_path = args.dem.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    dem = gdal.Open(str(dem_path))
    if dem is None:
        raise FileNotFoundError(dem_path)
    width = dem.RasterXSize
    height = dem.RasterYSize
    transform = dem.GetGeoTransform()
    projection = dem.GetProjection()
    if (
        width != 10_930
        or height != 14_120
        or abs(transform[1] - 1.0) > 1e-9
        or abs(transform[5] + 1.0) > 1e-9
    ):
        raise RuntimeError("DEM is not the aligned North Wildwood one-foot grid")
    dem = None

    records = {}
    with tempfile.TemporaryDirectory(prefix="north-wildwood-features-") as temp_raw:
        extracted = Path(temp_raw)
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(extracted)
        for name, spec in FEATURES.items():
            source = find_shapefile(extracted, spec["stem"])
            projected = output / f"{spec['stem']}_epsg6527.gpkg"
            if projected.exists():
                projected.unlink()
            result = gdal.VectorTranslate(
                str(projected),
                str(source),
                options=gdal.VectorTranslateOptions(
                    format="GPKG",
                    dstSRS=projection,
                    layerName=spec["stem"],
                    geometryType=(
                        "MULTILINESTRING" if name == "bulkheads" else None
                    ),
                ),
            )
            if result is None:
                raise RuntimeError(f"Could not project {source}")
            layer = result.GetLayer(0)
            feature_count = layer.GetFeatureCount()
            result = None
            raster = output / spec["raster"]
            if raster.exists():
                raster.unlink()
            pixel_count = rasterize(
                projected,
                raster,
                width,
                height,
                transform,
                projection,
            )
            if feature_count != spec["expectedFeatures"]:
                raise AssertionError(
                    f"{name}: expected {spec['expectedFeatures']} features, "
                    f"found {feature_count}"
                )
            if pixel_count != spec["expectedPixels"]:
                raise AssertionError(
                    f"{name}: expected {spec['expectedPixels']} pixels, "
                    f"found {pixel_count}"
                )
            records[name] = {
                "source": source.name,
                "projected": projected.name,
                "raster": raster.name,
                "featureCount": feature_count,
                "rasterPixelCount": pixel_count,
            }

    manifest = {
        "schema": "north-wildwood-hydraulic-feature-inputs-v1",
        "generatedUtc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "sourceZip": zip_path.name,
        "sourceZipSha256": sha256(zip_path),
        "dem": {
            "name": dem_path.name,
            "width": width,
            "height": height,
            "cellSizeFt": 1,
            "projection": "EPSG:6527",
        },
        "rasterization": "GDAL ALL_TOUCHED on the exact aligned one-foot grid",
        "features": records,
        "physicsOverrides": {
            "bulkheadElevationNavd88Ft": 7.5,
            "stormGrateDiameterInches": 48,
            "note": "The explicit 48-inch modeling assumption overrides the 18-inch descriptive DBF values.",
        },
    }
    manifest_path = output / "NorthWildwoodHydraulicFeatureInputManifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(manifest_path)


if __name__ == "__main__":
    main()
