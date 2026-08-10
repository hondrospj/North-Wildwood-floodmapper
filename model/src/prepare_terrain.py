#!/usr/bin/env python3
"""Create one continuous NAVD88 terrain/bathymetry surface for ANUGA."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
NODATA = -9999.0
US_SURVEY_FOOT_TO_METRE = 1200.0 / 3937.0


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def target_geometry(config: dict[str, Any]) -> tuple[Any, int, int]:
    domain = config["domain"]
    resolution = float(domain["terrainGridM"])
    width = int(round((float(domain["xmax"]) - float(domain["xmin"])) / resolution))
    height = int(round((float(domain["ymax"]) - float(domain["ymin"])) / resolution))
    transform = from_origin(
        float(domain["xmin"]),
        float(domain["ymax"]),
        resolution,
        resolution,
    )
    return transform, width, height


def reproject_band(
    source: rasterio.io.DatasetReader,
    transform: Any,
    width: int,
    height: int,
    destination_crs: str,
    resampling: Resampling,
) -> np.ndarray:
    destination = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=rasterio.band(source, 1),
        destination=destination,
        src_transform=source.transform,
        src_crs=source.crs,
        src_nodata=source.nodata,
        dst_transform=transform,
        dst_crs=destination_crs,
        dst_nodata=np.nan,
        resampling=resampling,
        num_threads=4,
    )
    return destination


def write_float_geotiff(
    path: Path,
    array: np.ndarray,
    transform: Any,
    crs: str,
    description: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "height": array.shape[0],
        "width": array.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "nodata": NODATA,
        "compress": "deflate",
        "predictor": 3,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "bigtiff": "IF_SAFER",
    }
    output = np.where(np.isfinite(array), array, NODATA).astype(np.float32)
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(output, 1)
        dataset.set_band_description(1, description)
        factors = [factor for factor in (2, 4, 8, 16) if min(array.shape) // factor >= 64]
        if factors:
            dataset.build_overviews(factors, Resampling.average)
            dataset.update_tags(ns="rio_overview", resampling="average")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()

    config = read_json(args.config.resolve())
    transform, width, height = target_geometry(config)
    destination_crs = config["modelCrs"]
    terrain_config = config["terrain"]
    domain_cell_count = width * height

    fallback_path = ROOT / terrain_config["seamlessLandFallback"]
    if not fallback_path.is_file():
        raise FileNotFoundError(
            f"Missing seamless NOAA fallback window: {fallback_path}. "
            "Run the terrain acquisition step first."
        )
    with rasterio.open(fallback_path) as source:
        seamless = reproject_band(
            source,
            transform,
            width,
            height,
            destination_crs,
            Resampling.bilinear,
        )
    fallback_valid = np.isfinite(seamless)
    ocean_placeholder = fallback_valid & (
        seamless <= float(terrain_config["seamlessOceanPlaceholderBelowM"])
    )
    seamless[ocean_placeholder] = float(terrain_config["fallbackOceanBedM"])
    seamless[~fallback_valid] = float(terrain_config["fallbackOceanBedM"])

    tile_directory = ROOT / terrain_config["topobathyDirectory"]
    manifest = read_json(tile_directory / "acquisition_manifest.json")
    topobathy = np.full((height, width), np.nan, dtype=np.float32)
    tile_hits = 0
    for tile_record in manifest["tiles"]:
        tile_path = ROOT / tile_record["path"]
        with rasterio.open(tile_path) as source:
            warped = reproject_band(
                source,
                transform,
                width,
                height,
                destination_crs,
                Resampling.average,
            )
        valid = np.isfinite(warped) & (warped > -50.0) & (warped < 50.0)
        if np.any(valid):
            topobathy[valid] = warped[valid]
            tile_hits += 1

    local_path = ROOT / terrain_config["localDem"]
    if not local_path.is_file():
        raise FileNotFoundError(f"Missing local North Wildwood DEM: {local_path}")
    with rasterio.open(local_path) as local_source:
        local_native = local_source.read(1, masked=True).filled(np.nan).astype(np.float32)
        local_native *= US_SURVEY_FOOT_TO_METRE
        local_for_model = np.full((height, width), np.nan, dtype=np.float32)
        reproject(
            source=local_native,
            destination=local_for_model,
            src_transform=local_source.transform,
            src_crs=local_source.crs,
            src_nodata=np.nan,
            dst_transform=transform,
            dst_crs=destination_crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
            num_threads=4,
        )
        display_transform = local_source.transform
        display_crs = local_source.crs

    bulkhead_path = ROOT / terrain_config["localBulkheadMask"]
    if not bulkhead_path.is_file():
        raise FileNotFoundError(
            f"Missing North Wildwood bulkhead mask: {bulkhead_path}"
        )
    with rasterio.open(bulkhead_path) as bulkhead_source:
        bulkhead_for_model = reproject_band(
            bulkhead_source,
            transform,
            width,
            height,
            destination_crs,
            Resampling.max,
        )
    bulkhead_for_model = np.isfinite(bulkhead_for_model) & (
        bulkhead_for_model > 0.0
    )

    local_valid = np.isfinite(local_for_model) & (local_for_model > -50.0)
    topo_valid = np.isfinite(topobathy)
    authoritative = topo_valid | local_valid | fallback_valid
    authoritative_coverage_percent = (
        float(np.count_nonzero(authoritative)) * 100.0 / domain_cell_count
    )
    minimum_coverage = float(
        config["domain"]["minimumAuthoritativeTerrainCoveragePercent"]
    )
    if authoritative_coverage_percent < minimum_coverage:
        raise RuntimeError(
            "Authoritative local/NOAA terrain covers only "
            f"{authoritative_coverage_percent:.3f}% of the domain; "
            f"{minimum_coverage:.3f}% is required. Refusing to turn data gaps "
            "into artificial open water."
        )

    merged = seamless.copy()
    merged[topo_valid] = topobathy[topo_valid]

    # The municipal raster has the best local terrestrial grading. NOAA's
    # topobathy remains authoritative below NAVD88 zero in channels and ocean.
    use_local = local_valid & ((local_for_model >= 0.0) | ~topo_valid)
    merged[use_local] = local_for_model[use_local]
    merged[bulkhead_for_model] = np.maximum(
        merged[bulkhead_for_model],
        float(terrain_config["bulkheadCrestNavd88M"]),
    )
    if not np.all(np.isfinite(merged)):
        raise RuntimeError("Computational terrain still contains non-finite cells")

    computational_path = ROOT / terrain_config["computationalDem"]
    write_float_geotiff(
        computational_path,
        merged,
        transform,
        destination_crs,
        "bed_elevation_navd88_m",
    )

    display_path = ROOT / terrain_config["displayDem"]
    write_float_geotiff(
        display_path,
        local_native,
        display_transform,
        str(display_crs),
        "ground_elevation_navd88_m",
    )

    bulkhead_output_path = ROOT / terrain_config["bulkheadMask"]
    write_float_geotiff(
        bulkhead_output_path,
        bulkhead_for_model.astype(np.float32),
        transform,
        destination_crs,
        "north_wildwood_bulkhead_mask",
    )

    source_counts = {
        "localMunicipal": int(np.count_nonzero(use_local)),
        "noaa2020Topobathy": int(np.count_nonzero(topo_valid & ~use_local)),
        "noaaSeamlessOrOceanFallback": int(
            domain_cell_count - np.count_nonzero(use_local | topo_valid)
        ),
    }
    terrain_manifest = {
        "schema": "north-wildwood-computational-terrain-v1",
        "modelCrs": destination_crs,
        "verticalDatum": config["verticalDatum"],
        "verticalUnits": config["verticalUnits"],
        "domain": config["domain"],
        "shape": {"width": width, "height": height},
        "sourceTileCount": len(manifest["tiles"]),
        "sourceTilesWithData": tile_hits,
        "sourceCellCounts": source_counts,
        "sourceCoveragePercent": {
            key: round(count * 100.0 / domain_cell_count, 4)
            for key, count in source_counts.items()
        },
        "authoritativeCoveragePercent": round(
            authoritative_coverage_percent,
            4,
        ),
        "elevationM": {
            "minimum": float(np.min(merged)),
            "maximum": float(np.max(merged)),
            "mean": float(np.mean(merged)),
        },
        "inputs": {
            "localDem": {
                "path": terrain_config["localDem"],
                "sha256": sha256(local_path),
                "verticalConversion": US_SURVEY_FOOT_TO_METRE,
            },
            "localBulkheadMask": {
                "path": terrain_config["localBulkheadMask"],
                "sha256": sha256(bulkhead_path),
                "cellCountAtModelTerrainResolution": int(
                    np.count_nonzero(bulkhead_for_model)
                ),
                "crestNavd88M": terrain_config["bulkheadCrestNavd88M"],
            },
            "topobathyAcquisitionManifest": {
                "path": str(
                    (tile_directory / "acquisition_manifest.json").relative_to(ROOT)
                ),
                "sha256": sha256(tile_directory / "acquisition_manifest.json"),
            },
            "seamlessLandFallback": {
                "path": terrain_config["seamlessLandFallback"],
                "sha256": sha256(fallback_path),
                "oceanPlaceholderRule": (
                    f"values <= "
                    f"{terrain_config['seamlessOceanPlaceholderBelowM']} m "
                    f"replaced with "
                    f"{terrain_config['fallbackOceanBedM']} m"
                ),
            },
        },
        "outputs": {
            "computationalDem": {
                "path": terrain_config["computationalDem"],
                "sha256": sha256(computational_path),
            },
            "displayDem": {
                "path": terrain_config["displayDem"],
                "sha256": sha256(display_path),
            },
            "bulkheadMask": {
                "path": terrain_config["bulkheadMask"],
                "sha256": sha256(bulkhead_output_path),
            },
        },
    }
    manifest_path = ROOT / "model/cache/terrain_manifest.json"
    manifest_path.write_text(
        json.dumps(terrain_manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(terrain_manifest["sourceCoveragePercent"], indent=2))
    print(
        "Terrain elevation range: "
        f"{terrain_manifest['elevationM']['minimum']:.3f} to "
        f"{terrain_manifest['elevationM']['maximum']:.3f} m NAVD88"
    )
    print(f"Wrote {computational_path}")
    print(f"Wrote {display_path}")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
