#!/usr/bin/env python3
"""Render an ANUGA forecast as compact visible and browser-queryable PNGs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.warp import reproject
from scipy.spatial import cKDTree


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
METRES_TO_FEET = 3.280839895013123
QUERY_MAX_DEPTH_MM = 65535

DEPTH_BREAKS_FT = np.array(
    [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00],
    dtype=np.float32,
)
DEPTH_COLORS = [
    "#7DF9FF",
    "#5DE7FF",
    "#38D3FF",
    "#1BB7F5",
    "#168CEB",
    "#156BE0",
    "#1853C6",
    "#173EA8",
    "#132F84",
    "#0B1E5B",
    "#050E33",
]
IMPACT_COLORS = {
    1: "#D58A00",
    2: "#D84B67",
    3: "#7C5CE0",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def compact_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc).strftime("%Y%m%dT%H%MZ")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_record(path: Path, public_root: Path) -> dict[str, Any]:
    return {
        "path": path.relative_to(public_root).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def visible_palette() -> tuple[list[int], bytes]:
    palette = [0] * (256 * 3)
    alpha = bytearray([0] * 256)
    for index, color in enumerate(DEPTH_COLORS, start=1):
        palette[index * 3 : index * 3 + 3] = hex_rgb(color)
        alpha[index] = 224
    return palette, bytes(alpha)


def write_visible_png(path: Path, depth_m: np.ndarray, wet: np.ndarray) -> None:
    codes = np.zeros(depth_m.shape, dtype=np.uint8)
    depths_ft = depth_m[wet] * METRES_TO_FEET
    codes[wet] = np.digitize(
        depths_ft,
        DEPTH_BREAKS_FT,
        right=False,
    ).astype(np.uint8) + 1
    image = Image.fromarray(codes, mode="P")
    palette, transparency = visible_palette()
    image.putpalette(palette)
    image.info["transparency"] = transparency
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", compress_level=7)


def write_query_png(path: Path, depth_m: np.ndarray, wet: np.ndarray) -> None:
    """Encode depth millimetres as R=high byte, G=low byte, B=wet flag."""
    depth_mm = np.zeros(depth_m.shape, dtype=np.uint16)
    rounded = np.rint(np.maximum(depth_m[wet], 0.0) * 1000.0)
    depth_mm[wet] = np.clip(rounded, 0, QUERY_MAX_DEPTH_MM).astype(np.uint16)
    encoded = np.zeros((*depth_m.shape, 3), dtype=np.uint8)
    encoded[..., 0] = (depth_mm >> 8).astype(np.uint8)
    encoded[..., 1] = (depth_mm & 255).astype(np.uint8)
    encoded[..., 2] = wet.astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(encoded, mode="RGB").save(
        path,
        format="PNG",
        compress_level=7,
    )


def write_impact_png(path: Path, impact_codes: np.ndarray, wet: np.ndarray) -> None:
    """Write the modeled flood-stage band at which each wet cell arrived."""
    visible_codes = np.where(wet, impact_codes, 0).astype(np.uint8)
    image = Image.fromarray(visible_codes, mode="P")
    palette = [0] * (256 * 3)
    alpha = bytearray([0] * 256)
    for code, color in IMPACT_COLORS.items():
        palette[code * 3 : code * 3 + 3] = hex_rgb(color)
        alpha[code] = 224
    image.putpalette(palette)
    image.info["transparency"] = bytes(alpha)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", compress_level=7)


def impact_code(boundary_stage_navd88_ft: float, thresholds: dict[str, Any]) -> int:
    if boundary_stage_navd88_ft < float(thresholds["moderate"]):
        return 1
    if boundary_stage_navd88_ft < float(thresholds["major"]):
        return 2
    return 3


def display_mask_on_computational_grid(
    display_dem_path: Path,
    destination_profile: dict[str, Any],
) -> np.ndarray:
    with rasterio.open(display_dem_path) as source:
        source_mask = (source.dataset_mask() > 0).astype(np.uint8)
        destination = np.zeros(
            (destination_profile["height"], destination_profile["width"]),
            dtype=np.uint8,
        )
        reproject(
            source=source_mask,
            destination=destination,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=0,
            dst_transform=destination_profile["transform"],
            dst_crs=destination_profile["crs"],
            dst_nodata=0,
            resampling=Resampling.nearest,
            num_threads=4,
        )
    return destination.astype(bool)


def crop_for_mask(mask: np.ndarray) -> tuple[slice, slice]:
    rows, columns = np.nonzero(mask)
    if rows.size == 0:
        raise RuntimeError("The display DEM has no valid cells in the model domain")
    return (
        slice(int(rows.min()), int(rows.max()) + 1),
        slice(int(columns.min()), int(columns.max()) + 1),
    )


def image_bounds_wgs84(
    transform: rasterio.Affine,
    row_slice: slice,
    column_slice: slice,
    source_crs: str,
) -> list[list[float]]:
    left = transform.c + column_slice.start * transform.a
    right = transform.c + column_slice.stop * transform.a
    top = transform.f + row_slice.start * transform.e
    bottom = transform.f + row_slice.stop * transform.e
    transformer = Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)
    corners = [
        transformer.transform(left, bottom),
        transformer.transform(left, top),
        transformer.transform(right, bottom),
        transformer.transform(right, top),
    ]
    west = min(point[0] for point in corners)
    east = max(point[0] for point in corners)
    south = min(point[1] for point in corners)
    north = max(point[1] for point in corners)
    return [[south, west], [north, east]]


def grid_centres(
    transform: rasterio.Affine,
    row_slice: slice,
    column_slice: slice,
) -> np.ndarray:
    columns = np.arange(column_slice.start, column_slice.stop, dtype=np.float64)
    rows = np.arange(row_slice.start, row_slice.stop, dtype=np.float64)
    x = transform.c + (columns + 0.5) * transform.a
    y = transform.f + (rows + 0.5) * transform.e
    x_grid, y_grid = np.meshgrid(x, y)
    return np.column_stack((x_grid.ravel(), y_grid.ravel()))


def load_guidance_frames(
    guidance: dict[str, Any],
    scenario: str,
    frame_count: int,
) -> list[dict[str, Any]]:
    frames = guidance["scenarios"][scenario][:frame_count]
    if len(frames) != frame_count:
        raise RuntimeError(
            f"Run has {frame_count} frames but guidance has only {len(frames)}"
        )
    return frames


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--petss", type=Path, default=ROOT / "model/state/latest_petss.json")
    parser.add_argument("--scenario", default="mean")
    parser.add_argument(
        "--run-dir",
        type=Path,
        help="Defaults to model/runs/<current cycle>/<scenario>",
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
    guidance = json.loads(args.petss.resolve().read_text(encoding="utf-8"))
    cycle_id = guidance["cycleId"]
    run_directory = (
        args.run_dir.resolve()
        if args.run_dir
        else ROOT / "model/runs" / cycle_id / args.scenario
    )
    run_manifest_path = run_directory / "run_manifest.json"
    if not run_manifest_path.is_file():
        raise FileNotFoundError(f"Missing complete model run: {run_manifest_path}")
    run_manifest = json.loads(run_manifest_path.read_text(encoding="utf-8"))
    if run_manifest["cycleId"] != cycle_id:
        raise RuntimeError(
            f"Run cycle {run_manifest['cycleId']} does not match guidance {cycle_id}"
        )
    if run_manifest["scenario"] != args.scenario:
        raise RuntimeError("Run scenario does not match requested render scenario")

    final_public = run_directory / "public"
    incomplete_public = run_directory / "public.incomplete"
    if final_public.exists():
        if not args.force:
            print(f"Completed render already exists: {final_public}")
            return
        shutil.rmtree(final_public)
    if incomplete_public.exists():
        shutil.rmtree(incomplete_public)
    incomplete_public.mkdir(parents=True)

    hydraulic_directory = run_directory / "hydraulic"
    mesh = np.load(hydraulic_directory / "mesh.npz")
    centroid_coordinates = mesh["centroid_coordinates"]
    bed_centroid = mesh["bed_elevation_m"]
    stage_frames = np.load(
        hydraulic_directory / "stage_centroid_m.npy",
        mmap_mode="r",
    )
    frame_count, triangle_count = stage_frames.shape
    if triangle_count != len(centroid_coordinates):
        raise RuntimeError("Stage array and hydraulic mesh do not align")
    guidance_frames = load_guidance_frames(
        guidance,
        args.scenario,
        frame_count,
    )

    computational_path = ROOT / config["terrain"]["computationalDem"]
    with rasterio.open(computational_path) as terrain_source:
        terrain = terrain_source.read(1).astype(np.float32)
        terrain_profile = {
            "height": terrain_source.height,
            "width": terrain_source.width,
            "transform": terrain_source.transform,
            "crs": str(terrain_source.crs),
        }
    display_path = ROOT / config["terrain"]["displayDem"]
    full_display_mask = display_mask_on_computational_grid(
        display_path,
        terrain_profile,
    )
    row_slice, column_slice = crop_for_mask(full_display_mask)
    display_mask = full_display_mask[row_slice, column_slice]
    terrain = terrain[row_slice, column_slice]
    render_shape = terrain.shape
    bounds = image_bounds_wgs84(
        terrain_profile["transform"],
        row_slice,
        column_slice,
        terrain_profile["crs"],
    )

    index_cache = (
        ROOT
        / "model/cache"
        / (
            f"nearest_triangle_{triangle_count}_"
            f"{row_slice.start}_{row_slice.stop}_"
            f"{column_slice.start}_{column_slice.stop}.npy"
        )
    )
    if index_cache.is_file():
        nearest_triangle = np.load(index_cache, mmap_mode="r")
        if nearest_triangle.shape != render_shape:
            raise RuntimeError(f"Stale nearest-triangle cache: {index_cache}")
    else:
        print(
            f"Mapping {render_shape[0] * render_shape[1]:,} render cells "
            f"to {triangle_count:,} hydraulic triangles."
        )
        centres = grid_centres(
            terrain_profile["transform"],
            row_slice,
            column_slice,
        )
        tree = cKDTree(centroid_coordinates)
        _, indices = tree.query(centres, workers=-1)
        nearest_triangle = indices.reshape(render_shape).astype(np.int32)
        index_cache.parent.mkdir(parents=True, exist_ok=True)
        temporary_cache = index_cache.with_suffix(".npy.incomplete")
        with temporary_cache.open("wb") as stream:
            np.save(stream, nearest_triangle)
        os.replace(temporary_cache, index_cache)

    render_config = config["render"]
    visible_directory = incomplete_public / render_config["visibleDirectoryName"]
    impact_directory = incomplete_public / render_config["impactDirectoryName"]
    query_directory = incomplete_public / render_config["queryDirectoryName"]
    daily_directory = incomplete_public / render_config["dailyMaximumDirectoryName"]
    impact_thresholds = render_config["impactThresholdsNavd88Ft"]
    minimum_depth = float(render_config["minimumWetDepthM"])
    local_time_zone_name = render_config["dailyMaximumTimeZone"]
    local_time_zone = ZoneInfo(local_time_zone_name)

    frame_records: list[dict[str, Any]] = []
    daily_records: list[dict[str, Any]] = []
    current_day: str | None = None
    current_day_maximum = np.zeros(render_shape, dtype=np.float32)
    current_day_impact = np.zeros(render_shape, dtype=np.uint8)
    current_day_first_time: str | None = None
    current_day_last_time: str | None = None
    impact_arrival_codes = np.zeros(render_shape, dtype=np.uint8)

    def flush_daily_maximum() -> None:
        nonlocal current_day_maximum, current_day_impact
        if current_day is None:
            return
        wet = display_mask & (current_day_maximum >= minimum_depth)
        visible_path = daily_directory / f"{current_day}.png"
        impact_path = daily_directory / f"{current_day}.impact.png"
        query_path = daily_directory / f"{current_day}.query.png"
        write_visible_png(visible_path, current_day_maximum, wet)
        write_impact_png(impact_path, current_day_impact, wet)
        write_query_png(query_path, current_day_maximum, wet)
        daily_records.append(
            {
                "dateLocal": current_day,
                "timeZone": local_time_zone_name,
                "firstFrameUtc": current_day_first_time,
                "lastFrameUtc": current_day_last_time,
                "visible": file_record(visible_path, incomplete_public),
                "impact": file_record(impact_path, incomplete_public),
                "query": file_record(query_path, incomplete_public),
                "maximumDepthM": round(
                    float(np.max(current_day_maximum[display_mask])),
                    4,
                ),
            }
        )
        current_day_maximum = np.zeros(render_shape, dtype=np.float32)
        current_day_impact = np.zeros(render_shape, dtype=np.uint8)

    print(
        f"Rendering {frame_count} frames at "
        f"{render_shape[1]}x{render_shape[0]} pixels."
    )
    for frame_index, guidance_frame in enumerate(guidance_frames):
        stage_centroid = np.asarray(stage_frames[frame_index], dtype=np.float32)
        hydraulic_depth = np.maximum(stage_centroid - bed_centroid, 0.0)
        hydraulic_wet = hydraulic_depth >= minimum_depth
        mapped_stage = stage_centroid[nearest_triangle]
        mapped_hydraulic_wet = hydraulic_wet[nearest_triangle]
        depth = np.maximum(mapped_stage - terrain, 0.0).astype(np.float32)
        wet = display_mask & mapped_hydraulic_wet & (depth >= minimum_depth)
        depth[~wet] = 0.0

        filename = compact_timestamp(guidance_frame["timeUtc"]) + ".png"
        visible_path = visible_directory / filename
        impact_path = impact_directory / filename
        query_path = query_directory / filename
        newly_wet = wet & (impact_arrival_codes == 0)
        impact_arrival_codes[newly_wet] = impact_code(
            float(guidance_frame["navd88Ft"]),
            impact_thresholds,
        )
        write_visible_png(visible_path, depth, wet)
        write_impact_png(impact_path, impact_arrival_codes, wet)
        write_query_png(query_path, depth, wet)
        frame_records.append(
            {
                "frameIndex": frame_index,
                "modelTimeSeconds": guidance_frame["secondsFromModelStart"],
                "timeUtc": guidance_frame["timeUtc"],
                "boundaryStageNavd88M": guidance_frame["navd88M"],
                "boundaryStageNavd88Ft": guidance_frame["navd88Ft"],
                "isHourlySourcePoint": guidance_frame["isHourlySourcePoint"],
                "visible": file_record(visible_path, incomplete_public),
                "impact": file_record(impact_path, incomplete_public),
                "query": file_record(query_path, incomplete_public),
                "wetPixelCount": int(np.count_nonzero(wet)),
                "maximumDepthM": round(float(np.max(depth)), 4),
            }
        )

        frame_time = datetime.fromisoformat(
            guidance_frame["timeUtc"].replace("Z", "+00:00")
        )
        frame_day = frame_time.astimezone(local_time_zone).date().isoformat()
        if current_day is not None and frame_day != current_day:
            flush_daily_maximum()
            current_day_first_time = None
        if current_day != frame_day:
            current_day = frame_day
            current_day_first_time = guidance_frame["timeUtc"]
        current_day_last_time = guidance_frame["timeUtc"]
        np.maximum(current_day_maximum, depth, out=current_day_maximum)
        np.maximum(
            current_day_impact,
            np.where(wet, impact_arrival_codes, 0),
            out=current_day_impact,
        )

        if frame_index % 24 == 0 or frame_index == frame_count - 1:
            print(
                f"rendered {frame_index + 1}/{frame_count}: "
                f"{guidance_frame['timeUtc']}, "
                f"{np.count_nonzero(wet):,} wet pixels"
            )
    flush_daily_maximum()

    public_manifest = {
        "schema": "north-wildwood-physics-forecast-v1",
        "status": "complete",
        "modelId": config["modelId"],
        "town": config["town"],
        "cycleId": cycle_id,
        "scenario": args.scenario,
        "generatedUtc": utc_now(),
        "forecastStartUtc": guidance_frames[0]["timeUtc"],
        "forecastEndUtc": guidance_frames[-1]["timeUtc"],
        "frameIntervalSeconds": run_manifest["output"]["intervalSeconds"],
        "frameCount": frame_count,
        "boundsWgs84": bounds,
        "image": {
            "width": render_shape[1],
            "height": render_shape[0],
            "sourceCrs": terrain_profile["crs"],
            "sourcePixelSizeM": abs(terrain_profile["transform"].a),
            "leafletPlacement": "geographic bounding rectangle",
            "displayMask": "valid footprint of the municipal North Wildwood DEM",
        },
        "visibleEncoding": {
            "quantity": "water depth above 5 m terrain",
            "units": "feet",
            "minimumWetDepthM": minimum_depth,
            "breaksFt": DEPTH_BREAKS_FT.tolist(),
            "colorsShallowToDeep": DEPTH_COLORS,
            "opacity": 224 / 255,
        },
        "queryEncoding": {
            "format": "RGB PNG readable through a CORS-enabled canvas",
            "red": "high byte of unsigned 16-bit depth millimetres",
            "green": "low byte of unsigned 16-bit depth millimetres",
            "blue": "1 when hydraulically wet, 0 when dry or outside display mask",
            "decodeDepthM": "(red * 256 + green) / 1000",
            "maximumRepresentableDepthM": QUERY_MAX_DEPTH_MM / 1000,
        },
        "impactEncoding": {
            "quantity": (
                "flood-impact band of the modeled boundary stage at which each "
                "currently wet cell first became hydraulically connected"
            ),
            "units": "feet NAVD88",
            "moderateThresholdFt": float(impact_thresholds["moderate"]),
            "majorThresholdFt": float(impact_thresholds["major"]),
            "codes": {
                "1": {"label": "minor", "color": IMPACT_COLORS[1]},
                "2": {"label": "moderate", "color": IMPACT_COLORS[2]},
                "3": {"label": "major", "color": IMPACT_COLORS[3]},
            },
            "opacity": 224 / 255,
        },
        "physics": run_manifest["physics"],
        "hydraulicDomain": run_manifest["domain"],
        "petssSource": run_manifest["petssSource"],
        "frames": frame_records,
        "dailyMaximums": daily_records,
    }
    manifest_path = incomplete_public / "manifest.json"
    manifest_path.write_text(
        json.dumps(public_manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(incomplete_public, final_public)
    print(f"Wrote {final_public}")
    print(
        f"Rendered {len(frame_records)} frames and "
        f"{len(daily_records)} local-calendar daily maxima."
    )


if __name__ == "__main__":
    main()
