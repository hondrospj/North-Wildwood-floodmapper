#!/usr/bin/env python3
"""Prepare North Wildwood's source blocks and DEM-integrated bulkhead.

The supplied hard-structure line is first rasterized on the exact one-foot DEM
grid. GDAL proximity then expands that centerline by two cells on every side,
giving a nominal five-cell wall. The expanded mask is burned into a new DEM at
7.5 ft NAVD88 before the hydraulic graph is built. Storm drains are recorded
for provenance but deliberately excluded from this model version.
"""

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
        "raster": "bulkheads_centerline_1ft.tif",
        "expectedFeatures": 1,
        "expectedPixels": 11_200,
    },
    "sourceManual": {
        "stem": "north_wildwood_source_blocks",
        "raster": "source_manual_1ft.tif",
        "expectedFeatures": 6,
        "expectedPixels": 254_212,
    },
}

BULKHEAD_ELEVATION_FT = 7.5
BULKHEAD_HALF_WIDTH_CELLS = 2
BULKHEAD_WIDTH_CELLS = BULKHEAD_HALF_WIDTH_CELLS * 2 + 1
IGNORED_DRAIN_STEM = "north_wildwood_storm_grates"


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


def create_byte_raster(
    destination: Path,
    width: int,
    height: int,
    transform: tuple[float, ...],
    projection: str,
) -> gdal.Dataset:
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
    return dataset


def thicken_bulkhead(
    centerline: Path,
    destination: Path,
    width: int,
    height: int,
    transform: tuple[float, ...],
    projection: str,
) -> int:
    """Expand the centerline by two pixel centers using GDAL proximity."""
    centerline_ds = gdal.Open(str(centerline))
    if centerline_ds is None:
        raise FileNotFoundError(centerline)
    with tempfile.TemporaryDirectory(prefix="north-wildwood-bulkhead-") as temp_raw:
        proximity_path = Path(temp_raw) / "bulkhead_proximity_pixels.tif"
        proximity_ds = gdal.GetDriverByName("GTiff").Create(
            str(proximity_path),
            width,
            height,
            1,
            gdal.GDT_Float32,
            options=[
                "TILED=YES",
                "BLOCKXSIZE=512",
                "BLOCKYSIZE=512",
                "COMPRESS=ZSTD",
                "SPARSE_OK=YES",
            ],
        )
        proximity_ds.SetGeoTransform(transform)
        proximity_ds.SetProjection(projection)
        proximity_band = proximity_ds.GetRasterBand(1)
        proximity_band.SetNoDataValue(-9999.0)
        proximity_band.Fill(-9999.0)
        gdal.ComputeProximity(
            centerline_ds.GetRasterBand(1),
            proximity_band,
            options=[
                "VALUES=1",
                "DISTUNITS=PIXEL",
                f"MAXDIST={BULKHEAD_HALF_WIDTH_CELLS}",
                "NODATA=-9999",
            ],
        )
        centerline_ds = None

        destination_ds = create_byte_raster(
            destination,
            width,
            height,
            transform,
            projection,
        )
        destination_band = destination_ds.GetRasterBand(1)
        pixels = 0
        for y in range(0, height, 512):
            rows = min(512, height - y)
            distance = proximity_band.ReadAsArray(0, y, width, rows)
            thick = (
                (distance >= 0.0)
                & (distance <= BULKHEAD_HALF_WIDTH_CELLS + 1e-6)
            ).astype(np.uint8)
            destination_band.WriteArray(thick, 0, y)
            pixels += int(np.count_nonzero(thick))
        destination_band.SetDescription(
            "five_cell_bulkhead_mask_two_cell_gdal_proximity_expansion"
        )
        destination_ds.SetMetadataItem(
            "NOMINAL_WIDTH_CELLS", str(BULKHEAD_WIDTH_CELLS)
        )
        destination_ds.SetMetadataItem(
            "EXPANSION_CELLS_PER_SIDE", str(BULKHEAD_HALF_WIDTH_CELLS)
        )
        destination_ds.FlushCache()
        destination_ds = None
        proximity_ds = None
    return pixels


def stitch_bulkhead_into_dem(
    source_dem: Path,
    bulkhead_mask: Path,
    destination: Path,
    width: int,
    height: int,
    transform: tuple[float, ...],
    projection: str,
) -> dict[str, int | float]:
    """Create a GDAL GeoTIFF whose bulkhead cells are at least 7.5 ft."""
    source_ds = gdal.Open(str(source_dem))
    mask_ds = gdal.Open(str(bulkhead_mask))
    if source_ds is None:
        raise FileNotFoundError(source_dem)
    if mask_ds is None:
        raise FileNotFoundError(bulkhead_mask)
    source_band = source_ds.GetRasterBand(1)
    mask_band = mask_ds.GetRasterBand(1)
    has_nodata = source_band.GetNoDataValue() is not None
    nodata = source_band.GetNoDataValue() if has_nodata else -9999.0

    output_ds = gdal.GetDriverByName("GTiff").Create(
        str(destination),
        width,
        height,
        1,
        gdal.GDT_Float32,
        options=[
            "TILED=YES",
            "BLOCKXSIZE=512",
            "BLOCKYSIZE=512",
            "COMPRESS=ZSTD",
            "PREDICTOR=3",
            "BIGTIFF=YES",
        ],
    )
    output_ds.SetGeoTransform(transform)
    output_ds.SetProjection(projection)
    output_band = output_ds.GetRasterBand(1)
    output_band.SetNoDataValue(nodata)
    output_band.SetDescription(
        "north_wildwood_ground_navd88_ft_with_five_cell_bulkhead"
    )

    raised_pixels = 0
    valid_bulkhead_pixels = 0
    invalid_bulkhead_pixels = 0
    for y in range(0, height, 512):
        rows = min(512, height - y)
        elevation = source_band.ReadAsArray(0, y, width, rows).astype(
            np.float32,
            copy=False,
        )
        hard = mask_band.ReadAsArray(0, y, width, rows) != 0
        valid = np.isfinite(elevation)
        if has_nodata:
            valid &= elevation != nodata
        invalid_bulkhead_pixels += int(np.count_nonzero(hard & ~valid))
        valid_hard = hard & valid
        valid_bulkhead_pixels += int(np.count_nonzero(valid_hard))
        needs_raise = valid_hard & (elevation < BULKHEAD_ELEVATION_FT)
        raised_pixels += int(np.count_nonzero(needs_raise))
        conditioned = elevation.copy()
        conditioned[needs_raise] = BULKHEAD_ELEVATION_FT
        output_band.WriteArray(conditioned, 0, y)

    if invalid_bulkhead_pixels:
        raise AssertionError(
            f"{invalid_bulkhead_pixels} expanded bulkhead cells fall on DEM nodata"
        )
    output_ds.SetMetadataItem(
        "BULKHEAD_ELEVATION_NAVD88_FT", str(BULKHEAD_ELEVATION_FT)
    )
    output_ds.SetMetadataItem(
        "BULKHEAD_NOMINAL_WIDTH_CELLS", str(BULKHEAD_WIDTH_CELLS)
    )
    output_ds.SetMetadataItem(
        "BULKHEAD_CONDITIONING",
        "GDAL blockwise maximum(original_dem, 7.5) within expanded mask",
    )
    output_ds.FlushCache()
    output_ds = None
    source_ds = None
    mask_ds = None
    return {
        "validBulkheadPixels": valid_bulkhead_pixels,
        "raisedBulkheadPixels": raised_pixels,
        "minimumBulkheadElevationNavd88Ft": BULKHEAD_ELEVATION_FT,
    }


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
    ignored_drain_count = 0
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

        ignored_drain_source = find_shapefile(extracted, IGNORED_DRAIN_STEM)
        ignored_drain_ds = gdal.OpenEx(str(ignored_drain_source), gdal.OF_VECTOR)
        if ignored_drain_ds is None:
            raise FileNotFoundError(ignored_drain_source)
        ignored_drain_count = ignored_drain_ds.GetLayer(0).GetFeatureCount()
        ignored_drain_ds = None
        if ignored_drain_count != 6:
            raise AssertionError(
                f"Expected six supplied storm drains, found {ignored_drain_count}"
            )

    centerline_path = output / FEATURES["bulkheads"]["raster"]
    thick_mask_path = output / "bulkheads_5cell_1ft.tif"
    if thick_mask_path.exists():
        thick_mask_path.unlink()
    thick_pixels = thicken_bulkhead(
        centerline_path,
        thick_mask_path,
        width,
        height,
        transform,
        projection,
    )
    if thick_pixels <= records["bulkheads"]["rasterPixelCount"]:
        raise AssertionError("Five-cell bulkhead expansion did not add any pixels")
    records["bulkheads"]["centerlineRaster"] = records["bulkheads"].pop("raster")
    records["bulkheads"]["centerlineRasterPixelCount"] = records["bulkheads"].pop(
        "rasterPixelCount"
    )
    records["bulkheads"]["raster"] = thick_mask_path.name
    records["bulkheads"]["rasterPixelCount"] = thick_pixels
    records["bulkheads"]["nominalWidthCells"] = BULKHEAD_WIDTH_CELLS
    records["bulkheads"]["expansionCellsPerSide"] = BULKHEAD_HALF_WIDTH_CELLS

    conditioned_dem_path = (
        output / "NorthWildwoodDEM_Bulkhead5Cell_1ft_NAVD88.tif"
    )
    if conditioned_dem_path.exists():
        conditioned_dem_path.unlink()
    conditioning = stitch_bulkhead_into_dem(
        dem_path,
        thick_mask_path,
        conditioned_dem_path,
        width,
        height,
        transform,
        projection,
    )

    manifest = {
        "schema": "north-wildwood-hydraulic-feature-inputs-v2",
        "generatedUtc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "sourceZip": zip_path.name,
        "sourceZipSha256": sha256(zip_path),
        "dem": {
            "source": dem_path.name,
            "conditioned": conditioned_dem_path.name,
            "width": width,
            "height": height,
            "cellSizeFt": 1,
            "projection": "EPSG:6527",
            "conditioning": conditioning,
        },
        "rasterization": (
            "GDAL ALL_TOUCHED centerline on the exact aligned one-foot grid, "
            "then a two-pixel GDAL proximity expansion on each side"
        ),
        "features": records,
        "ignoredFeatures": {
            "stormDrains": {
                "source": f"{IGNORED_DRAIN_STEM}.shp",
                "featureCount": ignored_drain_count,
                "modelTreatment": "disabled; no underground exchange or connectivity seed",
            }
        },
        "terrainConditioning": {
            "bulkheadElevationNavd88Ft": BULKHEAD_ELEVATION_FT,
            "bulkheadNominalWidthCells": BULKHEAD_WIDTH_CELLS,
            "bulkheadExpansionCellsPerSide": BULKHEAD_HALF_WIDTH_CELLS,
            "method": "GDAL-conditioned DEM created before graph construction",
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
