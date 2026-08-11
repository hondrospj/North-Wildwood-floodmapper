#!/usr/bin/env python3
"""Reconstruct a component marker from the published v26 source-zone query.

The marker does not define or paint the v27 boundary. It only identifies which
complete four-neighbour <=2.0-ft DEM components are tidal when one component is
separated from the raster exterior by nodata. The graph builder independently
reconstructs the literal complete low-elevation field from the one-foot DEM.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image


gdal.UseExceptions()

SOURCE_MAX_NAVD88_FT = 2.0
SOURCE_ZONE_CODES = (1, 2)  # packed zone ID + 1 for v26 source zones 0 and 1
QUERY_STRIDE = 5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--zone-query", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rgb = np.asarray(Image.open(args.zone_query).convert("RGB"), dtype=np.uint32)
    packed = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    source_5ft = np.isin(packed, SOURCE_ZONE_CODES)

    dem = gdal.Open(str(args.dem), gdal.GA_ReadOnly)
    if dem is None:
        raise RuntimeError(f"Could not open DEM: {args.dem}")
    if (
        dem.RasterXSize != source_5ft.shape[1] * QUERY_STRIDE
        or dem.RasterYSize != source_5ft.shape[0] * QUERY_STRIDE
    ):
        raise RuntimeError(
            "Five-foot zone query does not align with the one-foot DEM: "
            f"query={source_5ft.shape[::-1]}, DEM="
            f"{dem.RasterXSize}x{dem.RasterYSize}"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    driver = gdal.GetDriverByName("GTiff")
    output = driver.Create(
        str(args.output),
        dem.RasterXSize,
        dem.RasterYSize,
        1,
        gdal.GDT_Byte,
        options=[
            "TILED=YES",
            "BLOCKXSIZE=512",
            "BLOCKYSIZE=512",
            "COMPRESS=DEFLATE",
            "PREDICTOR=2",
            "BIGTIFF=IF_SAFER",
        ],
    )
    output.SetProjection(dem.GetProjection())
    output.SetGeoTransform(dem.GetGeoTransform())
    band = output.GetRasterBand(1)
    band.SetNoDataValue(0)
    band.SetDescription("v26_tidal_component_marker_filtered_to_dem_le_2ft")

    nodata = dem.GetRasterBand(1).GetNoDataValue()
    marked = 0
    block_rows = 500
    for y in range(0, dem.RasterYSize, block_rows):
        height = min(block_rows, dem.RasterYSize - y)
        elevation = dem.GetRasterBand(1).ReadAsArray(0, y, dem.RasterXSize, height)
        query_start = y // QUERY_STRIDE
        query_end = (y + height + QUERY_STRIDE - 1) // QUERY_STRIDE
        expanded = np.repeat(
            source_5ft[query_start:query_end],
            QUERY_STRIDE,
            axis=0,
        )
        expanded = expanded[y % QUERY_STRIDE : y % QUERY_STRIDE + height]
        expanded = np.repeat(expanded, QUERY_STRIDE, axis=1)
        valid = elevation != nodata if nodata is not None else np.isfinite(elevation)
        marker = (
            expanded
            & valid
            & (elevation <= SOURCE_MAX_NAVD88_FT)
        ).astype(np.uint8)
        band.WriteArray(marker, 0, y)
        marked += int(marker.sum())
    band.SetMetadataItem("ROLE", "component marker only; never boundary geometry")
    band.SetMetadataItem("MAX_SOURCE_ELEVATION_NAVD88_FT", "2.0")
    output.FlushCache()
    output = None
    dem = None
    print(f"Wrote {marked:,} one-foot component-marker cells to {args.output}")


if __name__ == "__main__":
    main()
