#!/usr/bin/env python3
"""Run the North Wildwood full nonlinear shallow-water forecast with ANUGA."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anuga
import numpy as np
import rasterio
from scipy.ndimage import label, map_coordinates, maximum_filter


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def anuga_version() -> str:
    reported = getattr(anuga, "__version__", "unknown")
    if reported not in ("unknown", "0.0.0+unknown"):
        return reported
    conda_metadata = Path(sys.prefix) / "conda-meta"
    for record_path in sorted(conda_metadata.glob("anuga-*.json")):
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if record.get("version"):
                return str(record["version"])
        except Exception:
            continue
    return reported


class RasterSampler:
    def __init__(self, path: Path):
        with rasterio.open(path) as dataset:
            self.array = dataset.read(1).astype(np.float64)
            self.transform = dataset.transform
            self.nodata = dataset.nodata
            self.crs = str(dataset.crs)
        if self.nodata is not None:
            self.array[self.array == self.nodata] = np.nan
        self.left = float(self.transform.c)
        self.top = float(self.transform.f)
        self.x_resolution = float(self.transform.a)
        self.y_resolution = abs(float(self.transform.e))

    def sample(self, x: np.ndarray, y: np.ndarray, order: int = 1) -> np.ndarray:
        x_values = np.asarray(x, dtype=np.float64)
        y_values = np.asarray(y, dtype=np.float64)
        columns = (x_values - self.left) / self.x_resolution - 0.5
        rows = (self.top - y_values) / self.y_resolution - 0.5
        values = map_coordinates(
            self.array,
            [rows, columns],
            order=order,
            mode="nearest",
            prefilter=False,
        )
        if not np.all(np.isfinite(values)):
            raise RuntimeError("Terrain sampler returned non-finite elevations")
        return values

    def initial_connected_water(
        self,
        stage_m: float,
        maximum_open_bed_m: float,
    ) -> np.ndarray:
        """Return only below-stage water connected to a qualified open edge.

        A low depression touching a reflective land edge is not an ocean source.
        This distinction prevents the initialization itself from recreating a
        connected bathtub before the transient solver has taken its first step.
        """
        wet = np.isfinite(self.array) & (self.array < stage_m)
        components, component_count = label(
            wet,
            structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8),
        )
        if component_count == 0:
            return np.zeros_like(wet)
        open_source = np.zeros_like(wet)
        open_source[0, :] = wet[0, :] & (
            self.array[0, :] <= maximum_open_bed_m
        )
        open_source[-1, :] = wet[-1, :] & (
            self.array[-1, :] <= maximum_open_bed_m
        )
        open_source[:, 0] |= wet[:, 0] & (
            self.array[:, 0] <= maximum_open_bed_m
        )
        open_source[:, -1] |= wet[:, -1] & (
            self.array[:, -1] <= maximum_open_bed_m
        )
        touching = np.unique(components[open_source])
        touching = touching[touching != 0]
        return np.isin(components, touching)

    def sample_mask(self, mask: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        x_values = np.asarray(x, dtype=np.float64)
        y_values = np.asarray(y, dtype=np.float64)
        columns = np.rint((x_values - self.left) / self.x_resolution - 0.5).astype(
            np.int64
        )
        rows = np.rint((self.top - y_values) / self.y_resolution - 0.5).astype(
            np.int64
        )
        columns = np.clip(columns, 0, mask.shape[1] - 1)
        rows = np.clip(rows, 0, mask.shape[0] - 1)
        return mask[rows, columns]


def boundary_midpoints(
    points: np.ndarray,
    triangles: np.ndarray,
    boundary: dict[tuple[int, int], str],
) -> tuple[list[tuple[int, int]], np.ndarray]:
    keys = list(boundary)
    midpoints = np.empty((len(keys), 2), dtype=np.float64)
    for index, (triangle_id, edge_id) in enumerate(keys):
        triangle = triangles[triangle_id]
        first = points[triangle[(edge_id + 1) % 3]]
        second = points[triangle[(edge_id + 2) % 3]]
        midpoints[index] = (first + second) / 2.0
    return keys, midpoints


def assign_boundary_tags(
    points: np.ndarray,
    triangles: np.ndarray,
    boundary: dict[tuple[int, int], str],
    terrain: RasterSampler,
    maximum_open_bed_m: float,
) -> dict[tuple[int, int], str]:
    keys, midpoints = boundary_midpoints(points, triangles, boundary)
    elevations = terrain.sample(midpoints[:, 0], midpoints[:, 1])
    result = dict(boundary)
    for key, elevation in zip(keys, elevations):
        result[key] = "open" if elevation <= maximum_open_bed_m else "land"
    if not any(tag == "open" for tag in result.values()):
        raise RuntimeError("No hydraulically open mesh boundary edges were identified")
    return result


def friction_from_elevation(
    elevation: np.ndarray,
    friction_config: dict[str, Any],
) -> np.ndarray:
    elevation = np.asarray(elevation)
    return np.select(
        (
            elevation < -0.15,
            elevation < 0.45,
            elevation < 3.0,
        ),
        (
            float(friction_config["openWaterManningN"]),
            float(friction_config["intertidalManningN"]),
            float(friction_config["developedManningN"]),
        ),
        default=float(friction_config["highGroundManningN"]),
    )


def barrier_mask_for_mesh(
    barrier: RasterSampler,
    mesh_cell_m: float,
) -> tuple[np.ndarray, int]:
    """Conservatively preserve a narrow crest on a coarser centroid mesh.

    ANUGA stores bed elevation at triangle centroids. A one-raster-cell crest can
    otherwise fall between every centroid and disappear hydraulically. Buffering
    by half a mesh-cell diagonal makes each triangle whose footprint intersects
    the surveyed crest inherit the configured crest elevation.
    """
    if barrier.x_resolution <= 0.0 or barrier.y_resolution <= 0.0:
        raise ValueError("Barrier raster resolution must be positive")
    radius_cells = int(
        math.ceil(
            (mesh_cell_m * math.sqrt(2.0) / 2.0)
            / min(barrier.x_resolution, barrier.y_resolution)
        )
    )
    source = np.isfinite(barrier.array) & (barrier.array > 0.0)
    if radius_cells == 0:
        return source, radius_cells
    return (
        maximum_filter(
            source.astype(np.uint8),
            size=2 * radius_cells + 1,
            mode="nearest",
        ).astype(bool),
        radius_cells,
    )


def safe_speed(
    depth: np.ndarray,
    x_momentum: np.ndarray,
    y_momentum: np.ndarray,
) -> np.ndarray:
    denominator = np.maximum(depth, 0.01)
    speed = np.hypot(x_momentum, y_momentum) / denominator
    speed[depth < 0.01] = 0.0
    return speed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--petss", type=Path, default=ROOT / "model/state/latest_petss.json")
    parser.add_argument("--scenario", default="mean")
    parser.add_argument("--mesh-cell-m", type=float)
    parser.add_argument(
        "--mesh-type",
        choices=("rectangular", "rectangularCross"),
    )
    parser.add_argument("--duration-hours", type=float)
    parser.add_argument("--output-interval-seconds", type=int)
    parser.add_argument("--threads", type=int)
    parser.add_argument(
        "--constant-stage-m",
        type=float,
        help="Diagnostic override that holds every boundary point at one NAVD88 stage",
    )
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
    guidance = json.loads(args.petss.resolve().read_text(encoding="utf-8"))
    if args.scenario not in guidance["scenarios"]:
        raise KeyError(f"PETSS guidance does not include scenario {args.scenario!r}")
    curve = guidance["scenarios"][args.scenario]
    curve_seconds = np.array(
        [frame["secondsFromModelStart"] for frame in curve],
        dtype=np.float64,
    )
    curve_stage_m = np.array([frame["navd88M"] for frame in curve], dtype=np.float64)
    if args.constant_stage_m is not None:
        curve_stage_m.fill(float(args.constant_stage_m))
    available_final_time = float(curve_seconds[-1])
    final_time = (
        min(available_final_time, float(args.duration_hours) * 3600.0)
        if args.duration_hours is not None
        else available_final_time
    )
    output_interval = int(
        args.output_interval_seconds
        or config["petss"]["outputIntervalSeconds"]
    )
    if final_time < output_interval:
        raise ValueError("Simulation duration must be at least one output interval")
    frame_count = int(math.floor(final_time / output_interval)) + 1

    cycle_id = guidance["cycleId"]
    if args.output_dir:
        final_directory = args.output_dir.resolve()
    else:
        final_directory = ROOT / "model/runs" / cycle_id / args.scenario
    if final_directory.exists():
        if not args.force:
            print(f"Completed run already exists: {final_directory}")
            return
        shutil.rmtree(final_directory)
    incomplete_directory = final_directory.with_name(final_directory.name + ".incomplete")
    if incomplete_directory.exists():
        shutil.rmtree(incomplete_directory)
    hydraulic_directory = incomplete_directory / "hydraulic"
    hydraulic_directory.mkdir(parents=True, exist_ok=True)

    domain_config = config["domain"]
    xmin = float(domain_config["xmin"])
    ymin = float(domain_config["ymin"])
    xmax = float(domain_config["xmax"])
    ymax = float(domain_config["ymax"])
    mesh_cell_m = float(args.mesh_cell_m or domain_config["meshCellM"])
    x_divisions = int(math.ceil((xmax - xmin) / mesh_cell_m))
    y_divisions = int(math.ceil((ymax - ymin) / mesh_cell_m))
    x_length = xmax - xmin
    y_length = ymax - ymin
    mesh_type = args.mesh_type or domain_config["meshType"]
    mesh_factory = (
        anuga.rectangular_cross
        if mesh_type == "rectangularCross"
        else anuga.rectangular
    )
    points, triangles, boundary = mesh_factory(
        x_divisions,
        y_divisions,
        len1=x_length,
        len2=y_length,
        origin=(xmin, ymin),
    )

    terrain_path = ROOT / config["terrain"]["computationalDem"]
    terrain = RasterSampler(terrain_path)
    barrier_path = ROOT / config["terrain"]["bulkheadMask"]
    barrier = RasterSampler(barrier_path)
    if (
        barrier.array.shape != terrain.array.shape
        or barrier.transform != terrain.transform
        or barrier.crs != terrain.crs
    ):
        raise RuntimeError("Bulkhead mask is not aligned with computational terrain")
    mesh_barrier_mask, mesh_barrier_radius_cells = barrier_mask_for_mesh(
        barrier,
        mesh_cell_m,
    )
    bulkhead_crest_m = float(config["terrain"]["bulkheadCrestNavd88M"])

    def model_bed(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        bed = terrain.sample(x, y)
        on_barrier = barrier.sample_mask(mesh_barrier_mask, x, y)
        return np.where(on_barrier, np.maximum(bed, bulkhead_crest_m), bed)

    boundary = assign_boundary_tags(
        points,
        triangles,
        boundary,
        terrain,
        float(domain_config["openBoundaryBedMaximumM"]),
    )
    domain = anuga.Domain(points, triangles, boundary, verbose=False)
    domain.set_name(f"north_wildwood_{cycle_id}_{args.scenario}")
    domain.set_datadir(str(hydraulic_directory))
    domain.set_quantities_to_be_stored(None)
    domain.set_flow_algorithm(config["solver"]["flowAlgorithm"])
    domain.set_multiprocessor_mode(1)
    threads = int(args.threads or config["solver"]["openMpThreads"])
    domain.set_omp_num_threads(threads, verbose=True)
    domain.minimum_allowed_height = float(
        config["solver"]["minimumAllowedHeightM"]
    )

    domain.set_quantity(
        "elevation",
        model_bed,
        location="centroids",
    )
    domain.set_quantity(
        "friction",
        lambda x, y: friction_from_elevation(
            model_bed(x, y),
            config["friction"],
        ),
        location="centroids",
    )
    initial_stage = float(curve_stage_m[0])
    open_boundary_bed_maximum_m = float(
        domain_config["openBoundaryBedMaximumM"]
    )
    initially_connected = terrain.initial_connected_water(
        initial_stage,
        open_boundary_bed_maximum_m,
    )

    def initial_stage_function(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        bed = model_bed(x, y)
        connected = terrain.sample_mask(initially_connected, x, y)
        return np.where(connected, np.maximum(initial_stage, bed), bed)

    domain.set_quantity("stage", initial_stage_function, location="centroids")
    domain.set_quantity("xmomentum", 0.0)
    domain.set_quantity("ymomentum", 0.0)

    def boundary_stage(seconds: float) -> float:
        return float(
            np.interp(
                seconds,
                curve_seconds,
                curve_stage_m,
                left=curve_stage_m[0],
                right=curve_stage_m[-1],
            )
        )

    open_boundary = anuga.Flather_external_stage_zero_velocity_boundary(
        domain=domain,
        function=boundary_stage,
    )
    land_boundary = anuga.Reflective_boundary(domain)
    domain.set_boundary({"open": open_boundary, "land": land_boundary})

    centroid_coordinates = domain.get_centroid_coordinates(absolute=True)
    bed_centroid = domain.quantities["elevation"].centroid_values.copy()
    friction_centroid = domain.quantities["friction"].centroid_values.copy()
    areas = domain.areas.copy()
    number_of_triangles = len(bed_centroid)
    stage_path = hydraulic_directory / "stage_centroid_m.npy"
    stage_frames = np.lib.format.open_memmap(
        stage_path,
        mode="w+",
        dtype=np.float32,
        shape=(frame_count, number_of_triangles),
    )
    maximum_depth = np.zeros(number_of_triangles, dtype=np.float32)
    maximum_speed = np.zeros(number_of_triangles, dtype=np.float32)
    arrival_time_seconds = np.full(number_of_triangles, -1.0, dtype=np.float32)
    previously_wet = np.zeros(number_of_triangles, dtype=bool)
    frame_statistics: list[dict[str, Any]] = []
    started = time.monotonic()
    output_index = 0

    print(
        f"Running {number_of_triangles:,} triangles at nominal "
        f"{mesh_cell_m:g} m for {final_time / 3600.0:.2f} h "
        f"({frame_count} output frames)."
    )
    for model_time in domain.evolve(
        yieldstep=float(output_interval),
        finaltime=final_time,
    ):
        if output_index >= frame_count:
            break
        stage = domain.quantities["stage"].centroid_values
        x_momentum = domain.quantities["xmomentum"].centroid_values
        y_momentum = domain.quantities["ymomentum"].centroid_values
        depth = np.maximum(stage - bed_centroid, 0.0)
        speed = safe_speed(depth, x_momentum, y_momentum)
        wet = depth >= 0.01
        newly_wet = wet & ~previously_wet
        arrival_time_seconds[newly_wet] = float(model_time)
        stage_frames[output_index, :] = stage.astype(np.float32)
        np.maximum(maximum_depth, depth, out=maximum_depth)
        np.maximum(maximum_speed, speed, out=maximum_speed)
        frame_statistics.append(
            {
                "frameIndex": output_index,
                "modelTimeSeconds": round(float(model_time), 6),
                "boundaryStageM": round(boundary_stage(float(model_time)), 6),
                "maximumDepthM": round(float(np.max(depth)), 6),
                "maximumSpeedMps": round(float(np.max(speed)), 6),
                "wetTriangleCount": int(np.count_nonzero(wet)),
                "newlyWetTriangleCount": int(np.count_nonzero(newly_wet)),
                "waterVolumeM3": round(float(np.sum(depth * areas)), 3),
            }
        )
        previously_wet = wet.copy()
        if output_index % 12 == 0 or output_index == frame_count - 1:
            elapsed = time.monotonic() - started
            print(
                f"frame {output_index + 1}/{frame_count}, "
                f"model hour {model_time / 3600.0:.2f}, "
                f"elapsed {elapsed:.1f}s, "
                f"max depth {np.max(depth):.3f}m, "
                f"max speed {np.max(speed):.3f}m/s"
            )
        output_index += 1

    stage_frames.flush()
    if output_index != frame_count:
        raise RuntimeError(f"Expected {frame_count} frames, wrote {output_index}")
    np.save(hydraulic_directory / "maximum_depth_centroid_m.npy", maximum_depth)
    np.save(hydraulic_directory / "maximum_speed_centroid_mps.npy", maximum_speed)
    np.save(hydraulic_directory / "arrival_time_seconds.npy", arrival_time_seconds)
    np.savez_compressed(
        hydraulic_directory / "mesh.npz",
        points=points,
        triangles=triangles,
        centroid_coordinates=centroid_coordinates,
        bed_elevation_m=bed_centroid,
        friction_manning_n=friction_centroid,
        triangle_area_m2=areas,
    )
    (hydraulic_directory / "frame_statistics.json").write_text(
        json.dumps(frame_statistics, indent=2) + "\n",
        encoding="utf-8",
    )

    elapsed_seconds = time.monotonic() - started
    algorithm_parameters = domain.get_algorithm_parameters()
    algorithm_parameters = {
        key: (
            value.item()
            if isinstance(value, np.generic)
            else value
        )
        for key, value in algorithm_parameters.items()
    }
    run_manifest = {
        "schema": "north-wildwood-anuga-run-v1",
        "status": "complete",
        "modelId": config["modelId"],
        "cycleId": cycle_id,
        "scenario": args.scenario,
        "startedUtc": guidance["forecastStartUtc"],
        "completedUtc": utc_now(),
        "petssSource": {
            "cycleUtc": guidance["petssCycleUtc"],
            "sourceUrl": guidance["sourceUrl"],
            "sourceMember": guidance["sourceMember"],
            "interpolation": guidance["interpolation"],
        },
        "physics": {
            "engine": config["solver"]["engine"],
            "engineVersion": anuga_version(),
            "equations": config["solver"]["equations"],
            "flowAlgorithm": config["solver"]["flowAlgorithm"],
            "boundaryCondition": config["solver"]["boundaryCondition"],
            "frictionLaw": "Manning semi-implicit",
            "hydrostaticWetDry": True,
            "initialWater": (
                "only below-stage components touching boundary cells whose "
                "bed qualifies as open water"
            ),
            "bulkheadTreatment": (
                "surveyed bulkhead mask burned to configured crest on the 5 m "
                "terrain and conservatively buffered for centroid-mesh support"
            ),
            "rainfall": "not applied",
            "windStress": "not applied; PETSS total water level is the boundary forcing",
            "waveSetup": "included only to the extent represented in PETSS total water level",
        },
        "domain": {
            **domain_config,
            "xDivisions": x_divisions,
            "yDivisions": y_divisions,
            "triangleCount": number_of_triangles,
            "meshType": mesh_type,
            "openBoundaryEdgeCount": sum(
                1 for value in boundary.values() if value == "open"
            ),
            "landBoundaryEdgeCount": sum(
                1 for value in boundary.values() if value == "land"
            ),
            "bulkheadCrestNavd88M": bulkhead_crest_m,
            "bulkheadMeshBufferRadiusCells": mesh_barrier_radius_cells,
            "bulkheadMeshBufferM": round(
                mesh_barrier_radius_cells * barrier.x_resolution,
                3,
            ),
            "bulkheadTriangleCount": int(
                np.count_nonzero(
                    barrier.sample_mask(
                        mesh_barrier_mask,
                        centroid_coordinates[:, 0],
                        centroid_coordinates[:, 1],
                    )
                )
            ),
        },
        "runtime": {
            "openMpThreads": threads,
            "elapsedSeconds": round(elapsed_seconds, 3),
            "simulatedSeconds": final_time,
            "simulationToWallClockRatio": round(final_time / elapsed_seconds, 3),
        },
        "output": {
            "intervalSeconds": output_interval,
            "frameCount": frame_count,
            "stageCentroidShape": [frame_count, number_of_triangles],
            "stageCentroidDtype": "float32",
        },
        "algorithmParameters": algorithm_parameters,
        "qualitySummary": {
            "maximumDepthM": round(float(np.max(maximum_depth)), 6),
            "maximumSpeedMps": round(float(np.max(maximum_speed)), 6),
            "maximumWetTriangleCount": max(
                frame["wetTriangleCount"] for frame in frame_statistics
            ),
            "maximumNewlyWetTriangleCountAfterInitialization": max(
                (
                    frame["newlyWetTriangleCount"]
                    for frame in frame_statistics[1:]
                ),
                default=0,
            ),
            "initialConnectedTerrainCellCount": int(
                np.count_nonzero(initially_connected)
            ),
        },
    }
    (incomplete_directory / "run_manifest.json").write_text(
        json.dumps(run_manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    final_directory.parent.mkdir(parents=True, exist_ok=True)
    os.replace(incomplete_directory, final_directory)
    print(f"Completed ANUGA run in {elapsed_seconds:.1f} seconds.")
    print(f"Wrote {final_directory}")


if __name__ == "__main__":
    main()
