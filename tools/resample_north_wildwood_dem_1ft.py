#!/usr/bin/env python3
"""Create a feature-preserving one-foot computational DEM.

The five-foot LiDAR raster is upsampled with cubic convolution and then bounded
to the finite extrema in each output cell's local 5x5 source neighbourhood.
This retains curved terrain gradients without allowing cubic overshoot to
invent pits or ridges that could change a connectivity result. The output is a
one-foot computational grid, not a claim of one-foot measured accuracy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal
from scipy.ndimage import maximum_filter, minimum_filter


SOURCE_CELL_FT = 5.0
OUTPUT_CELL_FT = 1.0
FACTOR = 5
BLOCK_ROWS = 256


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    gdal.UseExceptions()
    args = parse_args()
    source_path = args.input.resolve()
    output_path = args.output.resolve()
    manifest_path = (
        args.manifest.resolve()
        if args.manifest
        else output_path.with_suffix(".manifest.json")
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    source_ds = gdal.Open(str(source_path))
    if source_ds is None:
        raise FileNotFoundError(source_path)
    transform = source_ds.GetGeoTransform()
    if not (
        abs(transform[1] - SOURCE_CELL_FT) < 1e-8
        and abs(transform[5] + SOURCE_CELL_FT) < 1e-8
        and abs(transform[2]) < 1e-12
        and abs(transform[4]) < 1e-12
    ):
        raise AssertionError(f"Expected an unrotated five-foot DEM, got {transform}")

    source_band = source_ds.GetRasterBand(1)
    nodata = source_band.GetNoDataValue()
    if nodata is None:
        nodata = -9999.0
    source = source_band.ReadAsArray().astype(np.float32)
    source_valid = np.isfinite(source) & (source != nodata)
    if not np.any(source_valid):
        raise AssertionError("Source DEM has no valid cells")

    local_min = minimum_filter(
        np.where(source_valid, source, np.inf), size=5, mode="nearest"
    )
    local_max = maximum_filter(
        np.where(source_valid, source, -np.inf), size=5, mode="nearest"
    )
    source_width = source_ds.RasterXSize
    source_height = source_ds.RasterYSize
    output_width = source_width * FACTOR
    output_height = source_height * FACTOR
    projection = source_ds.GetProjection()
    output_transform = (
        transform[0], OUTPUT_CELL_FT, 0.0, transform[3], 0.0, -OUTPUT_CELL_FT
    )

    with tempfile.TemporaryDirectory(prefix="north-wildwood-bounded-cubic-") as raw:
        cubic_path = Path(raw) / "cubic.tif"
        cubic_ds = gdal.Warp(
            str(cubic_path),
            source_ds,
            options=gdal.WarpOptions(
                format="GTiff",
                width=output_width,
                height=output_height,
                outputBounds=(
                    transform[0],
                    transform[3] + transform[5] * source_height,
                    transform[0] + transform[1] * source_width,
                    transform[3],
                ),
                resampleAlg="cubic",
                srcNodata=nodata,
                dstNodata=nodata,
                multithread=True,
                warpOptions=["NUM_THREADS=ALL_CPUS"],
                creationOptions=[
                    "TILED=YES", "BLOCKXSIZE=512", "BLOCKYSIZE=512",
                    "COMPRESS=ZSTD", "PREDICTOR=3", "BIGTIFF=YES",
                ],
            ),
        )
        if cubic_ds is None:
            raise RuntimeError("GDAL cubic resampling failed")
        cubic_ds = None
        cubic_ds = gdal.Open(str(cubic_path))
        cubic_band = cubic_ds.GetRasterBand(1)

        output_ds = gdal.GetDriverByName("GTiff").Create(
            str(output_path), output_width, output_height, 1, gdal.GDT_Float32,
            options=[
                "TILED=YES", "BLOCKXSIZE=512", "BLOCKYSIZE=512",
                "COMPRESS=ZSTD", "PREDICTOR=3", "BIGTIFF=YES",
            ],
        )
        output_ds.SetGeoTransform(output_transform)
        output_ds.SetProjection(projection)
        output_band = output_ds.GetRasterBand(1)
        output_band.SetNoDataValue(nodata)
        output_band.SetDescription(
            "bounded_cubic_2019_south_jersey_lidar_dem_navd88_ft"
        )

        clamped_low = 0
        clamped_high = 0
        valid_output = 0
        source_x = np.minimum(source_width - 1, np.arange(output_width) // FACTOR)
        for y0 in range(0, output_height, BLOCK_ROWS):
            rows = min(BLOCK_ROWS, output_height - y0)
            cubic = cubic_band.ReadAsArray(0, y0, output_width, rows).astype(
                np.float32, copy=False
            )
            source_y = np.minimum(
                source_height - 1, np.arange(y0, y0 + rows) // FACTOR
            )
            block_min = local_min[np.ix_(source_y, source_x)]
            block_max = local_max[np.ix_(source_y, source_x)]
            valid = np.isfinite(cubic) & (cubic != nodata)
            valid &= np.isfinite(block_min) & np.isfinite(block_max)
            clamped_low += int(np.count_nonzero(valid & (cubic < block_min)))
            clamped_high += int(np.count_nonzero(valid & (cubic > block_max)))
            bounded = np.full(cubic.shape, nodata, dtype=np.float32)
            bounded[valid] = np.clip(cubic[valid], block_min[valid], block_max[valid])
            valid_output += int(np.count_nonzero(valid))
            output_band.WriteArray(bounded, 0, y0)
            if y0 % 2048 == 0:
                print(f"Bounded cubic row {y0:,}/{output_height:,}")

        output_ds.SetMetadataItem("SOURCE_CELL_SIZE_FT", "5")
        output_ds.SetMetadataItem("OUTPUT_CELL_SIZE_FT", "1")
        output_ds.SetMetadataItem("RESAMPLING", "bounded cubic convolution")
        output_ds.SetMetadataItem(
            "LIMITATION",
            "one-foot computational spacing interpolated from five-foot measurements",
        )
        output_ds.FlushCache()
        output_ds = None
        cubic_ds = None

    output_ds = gdal.Open(str(output_path))
    output_band = output_ds.GetRasterBand(1)
    maximum_center_error = 0.0
    # Original five-foot cell centres align with output offsets 2, 7, 12, ...
    # Cubic convolution must reproduce those measured values.
    for row in range(source_height):
        values = output_band.ReadAsArray(
            2, row * FACTOR + 2, output_width - 2, 1
        )[0, ::FACTOR]
        count = min(values.size, source_width)
        valid = source_valid[row, :count] & np.isfinite(values[:count])
        if np.any(valid):
            maximum_center_error = max(
                maximum_center_error,
                float(np.max(np.abs(values[:count][valid] - source[row, :count][valid]))),
            )
    output_ds = None
    source_ds = None

    manifest = {
        "schema": "north-wildwood-dem-resampling-v1",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0)
        .isoformat().replace("+00:00", "Z"),
        "source": source_path.name,
        "sourceSha256": sha256(source_path),
        "sourceCellSizeFt": SOURCE_CELL_FT,
        "output": output_path.name,
        "outputSha256": sha256(output_path),
        "outputCellSizeFt": OUTPUT_CELL_FT,
        "method": "cubic convolution bounded to local 5x5 finite source extrema",
        "validOutputCells": valid_output,
        "cubicValuesClampedLow": clamped_low,
        "cubicValuesClampedHigh": clamped_high,
        "maximumSourceCenterAbsoluteErrorFt": maximum_center_error,
        "accuracyStatement": (
            "one-foot computational spacing; measurement support remains the "
            "five-foot source raster"
        ),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
