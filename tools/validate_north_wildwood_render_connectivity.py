#!/usr/bin/env python3
"""Verify every phase-aware render against the conditional-connectivity mask."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from conditional_connectivity_routes import (
    connect_penalty_basins_by_lowest_road_route,
    source_block_geodesic_distance,
)
from hydraulic_mask_sequence import HydraulicMaskSequence
from osgeo import gdal
from PIL import Image
from scipy.ndimage import label as ndimage_label


WIDTH = 10_930
HEIGHT = 14_120
RENDER_STRIDE = 5
RENDER_WIDTH = WIDTH // RENDER_STRIDE
RENDER_HEIGHT = HEIGHT // RENDER_STRIDE
PHASE_PREDECESSOR = {
    "draining-release-15": "slack",
    "draining-release-30": "draining-release-15",
}
PHASE_DIRECTORIES = {
    "filling": "filling",
    "slack": "",
    "draining-release-15": "draining-release-15",
    "draining-release-30": "draining-release-30",
    "draining": "draining",
}
FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    (
        (0, 1, 0),
        (1, 1, 1),
        (0, 1, 0),
    ),
    dtype=np.uint8,
)
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument(
        "--road-mask",
        type=Path,
        help=(
            "Aligned five-foot public-road corridor mask. Defaults to "
            "NorthWildwoodRoadCorridor5ft.tif inside --graph."
        ),
    )
    return parser.parse_args()


def pool_source(path: Path) -> np.ndarray:
    raw = np.memmap(
        path,
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    pooled = np.zeros((RENDER_HEIGHT, RENDER_WIDTH), dtype=bool)
    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            pooled |= (
                raw[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE] != 0
            )
    return pooled


def build_render_summaries(graph: Path) -> dict[str, np.ndarray]:
    elevation10 = np.memmap(
        graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    connection10 = np.memmap(
        graph / "connection10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    developed = np.memmap(
        graph / "developed_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    maximum = np.iinfo(np.int16).max
    activation_maximum = np.iinfo(np.int32).max
    nodata = np.iinfo(np.int16).min
    summary = {
        "ground10": np.full(
            (RENDER_HEIGHT, RENDER_WIDTH), maximum, dtype=np.int16
        ),
        "ground10_developed": np.full(
            (RENDER_HEIGHT, RENDER_WIDTH), maximum, dtype=np.int16
        ),
        "activation100": np.full(
            (RENDER_HEIGHT, RENDER_WIDTH),
            activation_maximum,
            dtype=np.int32,
        ),
        "activation100_developed": np.full(
            (RENDER_HEIGHT, RENDER_WIDTH),
            activation_maximum,
            dtype=np.int32,
        ),
        "activation100_undeveloped": np.full(
            (RENDER_HEIGHT, RENDER_WIDTH),
            activation_maximum,
            dtype=np.int32,
        ),
    }
    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            ground = elevation10[
                y_offset::RENDER_STRIDE,
                x_offset::RENDER_STRIDE,
            ]
            connection = connection10[
                y_offset::RENDER_STRIDE,
                x_offset::RENDER_STRIDE,
            ]
            valid = ground != nodata
            is_developed = (
                developed[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE]
                != 0
            ) & valid
            activation100 = np.maximum(
                ground.astype(np.int32) * 10,
                connection.astype(np.int32) * 10,
            )
            activation100 = np.where(
                valid,
                activation100,
                activation_maximum,
            )
            np.minimum(
                summary["ground10"],
                np.where(valid, ground, maximum),
                out=summary["ground10"],
            )
            np.minimum(
                summary["ground10_developed"],
                np.where(is_developed, ground, maximum),
                out=summary["ground10_developed"],
            )
            np.minimum(
                summary["activation100"],
                activation100,
                out=summary["activation100"],
            )
            np.minimum(
                summary["activation100_developed"],
                np.where(is_developed, activation100, activation_maximum),
                out=summary["activation100_developed"],
            )
            np.minimum(
                summary["activation100_undeveloped"],
                np.where(valid & ~is_developed, activation100, activation_maximum),
                out=summary["activation100_undeveloped"],
            )
    return summary


def vertical_penalty(stage: float) -> float:
    if stage < 3.25:
        return 0.0
    if stage >= 5.25:
        return 0.0
    x = stage - 3.25
    return 0.125 * x * x - 0.625 * x + 0.75


def penalty_remaining_fraction(stage: float, phase: str) -> float:
    if vertical_penalty(stage) <= 0 or phase == "draining":
        return 0.0
    if phase in ("filling", "slack"):
        return 1.0
    if phase == "draining-release-15":
        return 2.0 / 3.0 if stage < 4.25 else 0.5
    if phase == "draining-release-30":
        return 1.0 / 3.0 if stage < 4.25 else 0.0
    raise ValueError(phase)


def retain_source_connected(mask: np.ndarray, source: np.ndarray) -> np.ndarray:
    labels, component_count = ndimage_label(mask, structure=FOUR_NEIGHBOUR_STRUCTURE)
    if not component_count:
        return mask
    component_sizes = np.bincount(labels.ravel(), minlength=component_count + 1)
    seeded = np.unique(labels[mask & source])
    seeded = seeded[(seeded > 0) & (component_sizes[seeded] >= 2)]
    keep = np.zeros(component_count + 1, dtype=bool)
    keep[seeded] = True
    return mask & keep[labels]


def add_visible_source_feeders(
    adjusted: np.ndarray,
    baseline: np.ndarray,
    source: np.ndarray,
    road: np.ndarray,
    ground: np.ndarray,
    penalized_uncertainty: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Reproduce the renderer's portable lowest-road feeder construction."""
    flooded, feeder, _ = connect_penalty_basins_by_lowest_road_route(
        adjusted,
        baseline,
        source,
        road,
        ground,
        penalized_uncertainty=penalized_uncertainty,
        feeder_half_width_cells=1,
    )
    return flooded, feeder


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
    road_path = (
        args.road_mask.resolve()
        if args.road_mask is not None
        else graph / "NorthWildwoodRoadCorridor5ft.tif"
    )
    road_ds = gdal.Open(str(road_path))
    if road_ds is None:
        raise FileNotFoundError(road_path)
    if (
        road_ds.RasterXSize != RENDER_WIDTH
        or road_ds.RasterYSize != RENDER_HEIGHT
    ):
        raise AssertionError("Unexpected public-road mask dimensions")
    road = road_ds.GetRasterBand(1).ReadAsArray() != 0
    road_ds = None
    source = pool_source(graph / "source_flag.raw")
    summary = build_render_summaries(graph)
    valid = summary["ground10"] != np.iinfo(np.int16).max
    ground = summary["ground10"].astype(np.float32) / 10.0
    ground_developed = (
        summary["ground10_developed"].astype(np.float32) / 10.0
    )
    activation = summary["activation100"].astype(np.float64) / 100.0
    activation_developed = (
        summary["activation100_developed"].astype(np.float64) / 100.0
    )
    activation_undeveloped = (
        summary["activation100_undeveloped"].astype(np.float64) / 100.0
    )
    source_distance_ft, source_distance_diagnostics = (
        source_block_geodesic_distance(
            source,
            valid,
            cell_size_ft=RENDER_STRIDE,
        )
    )
    records = []
    maximum_components = 0
    maximum_blue_pixels = 0
    minimum_blue_component_pixels = None
    isolated_source_pixel_instances = 0
    uncertainty_pixel_instances = 0
    disconnected_pixel_instances = 0
    feeder_pixel_instances = 0

    for phase, relative in PHASE_DIRECTORIES.items():
        depth_dir = assets / "DepthPNGs" / "North Wildwood" / relative
        stage_dir = assets / "StagePNGs" / "North Wildwood" / relative
        depth_paths = sorted(depth_dir.glob("NorthWildwoodDepth*.png"))
        if len(depth_paths) != 201:
            raise AssertionError(
                f"Expected 201 {phase} depth PNGs, found {len(depth_paths)}"
            )
        previous_stage_expected = None
        previous_phase_adjustment = 0.0
        catalog_sequence = HydraulicMaskSequence(max_hole_pixels=4)
        for depth_path in depth_paths:
            code = depth_path.stem.removeprefix("NorthWildwoodDepth")
            stage_path = stage_dir / f"NorthWildwoodStage{code}.png"
            if not stage_path.is_file():
                raise FileNotFoundError(stage_path)
            depth_codes = np.asarray(Image.open(depth_path))
            stage_codes = np.asarray(Image.open(stage_path))
            if depth_codes.shape != (RENDER_HEIGHT, RENDER_WIDTH):
                raise AssertionError(
                    f"Unexpected render dimensions for {depth_path}"
                )
            depth_blue = (depth_codes >= 1) & (depth_codes <= 11)
            stage_blue = (stage_codes >= 1) & (stage_codes <= 3)
            if not np.array_equal(depth_blue, stage_blue):
                raise AssertionError(
                    f"Depth/stage water masks differ for {phase} {code}"
                )
            labels, component_count = ndimage_label(
                depth_blue,
                structure=FOUR_NEIGHBOUR_STRUCTURE,
            )
            if component_count:
                component_sizes = np.bincount(
                    labels.ravel(),
                    minlength=component_count + 1,
                )
                minimum_blue_component_pixels = min(
                    minimum_blue_component_pixels
                    if minimum_blue_component_pixels is not None
                    else int(component_sizes[1:].min()),
                    int(component_sizes[1:].min()),
                )
                isolated_source_pixel_instances += int(
                    np.count_nonzero(component_sizes[1:] == 1)
                )
                source_labels = np.unique(labels[depth_blue & source])
                source_labels = source_labels[source_labels > 0]
                if source_labels.size != component_count:
                    missing = sorted(
                        set(range(1, component_count + 1))
                        - set(int(value) for value in source_labels)
                    )
                    raise AssertionError(
                        f"Non-source-connected blue components in {phase} "
                        f"{code}: {missing[:20]}"
                    )
            sign = -1.0 if code.startswith("m") else 1.0
            stage = sign * int(code[1:]) / 100.0
            baseline = valid & (activation <= stage + 1e-9)
            adjustment = vertical_penalty(stage)
            phase_adjustment = adjustment * penalty_remaining_fraction(stage, phase)
            developed_stage = stage - phase_adjustment
            developed_eligible = activation_developed <= stage + 1e-9
            developed_blue = developed_eligible & (
                ground_developed <= developed_stage + 1e-9
            )
            adjusted_blue = valid & (
                developed_blue
                | (activation_undeveloped <= stage + 1e-9)
            )
            penalized_uncertainty = (
                valid
                & developed_eligible
                & ~adjusted_blue
                & (phase_adjustment > 0)
            )
            expected_blue, feeder = add_visible_source_feeders(
                adjusted_blue,
                baseline,
                source,
                road,
                ground,
                penalized_uncertainty,
            )
            required_blue = (
                np.zeros(expected_blue.shape, dtype=bool)
                if (
                    previous_stage_expected is None
                    or (
                        previous_phase_adjustment <= 0.0
                        and phase_adjustment > 0.0
                    )
                )
                else previous_stage_expected
            )
            predecessor = PHASE_PREDECESSOR.get(phase)
            if predecessor is not None:
                predecessor_relative = PHASE_DIRECTORIES[predecessor]
                predecessor_path = (
                    assets
                    / "DepthPNGs"
                    / "North Wildwood"
                    / predecessor_relative
                    / f"NorthWildwoodDepth{code}.png"
                )
                predecessor_codes = np.asarray(Image.open(predecessor_path))
                predecessor_blue = (
                    (predecessor_codes >= 1) & (predecessor_codes <= 11)
                )
                required_blue |= predecessor_blue
            preserved_feeder = (
                required_blue
                & penalized_uncertainty
                & road
                & ~expected_blue
            )
            expected_blue |= preserved_feeder
            feeder |= preserved_feeder
            repair_eligible = valid & (
                (
                    np.isfinite(ground_developed)
                    & (ground_developed <= developed_stage + 1e-9)
                )
                | (activation_undeveloped <= stage + 1e-9)
            )
            expected_blue = catalog_sequence.update(
                expected_blue,
                "filling",
                repair_eligible,
            )
            previous_stage_expected = expected_blue.copy()
            previous_phase_adjustment = phase_adjustment
            if np.any(feeder & ~road):
                raise AssertionError(f"Off-road visible feeder in {phase} {code}")
            if np.any(feeder & ~penalized_uncertainty):
                raise AssertionError(
                    f"Visible feeder painted non-penalty uncertainty in {phase} {code}"
                )
            disconnected = valid & (ground < stage - 0.005) & ~baseline
            penalized = penalized_uncertainty & ~expected_blue
            expected_green = (
                np.zeros(expected_blue.shape, dtype=bool)
                if stage < 3.25
                else ~expected_blue & (disconnected | penalized)
            )
            if not np.array_equal(depth_blue, expected_blue):
                raise AssertionError(
                    f"Rendered blue mask differs from the developed-land "
                    f"conditional-connectivity mask in {phase} {code}"
                )
            if not np.array_equal(depth_codes == 12, expected_green):
                raise AssertionError(
                    f"Rendered green diagnostic mask differs from the "
                    f"disconnected/penalized mask in {phase} {code}"
                )
            if np.any(depth_codes[feeder] != 1):
                raise AssertionError(
                    f"Visible feeder is not in the 0.00-0.10-ft bin in {phase} {code}"
                )
            disconnected_pixel_instances += int(np.count_nonzero(disconnected))
            uncertainty_pixel_instances += int(np.count_nonzero(penalized))
            feeder_pixel_instances += int(np.count_nonzero(feeder))
            maximum_components = max(maximum_components, int(component_count))
            maximum_blue_pixels = max(
                maximum_blue_pixels,
                int(np.count_nonzero(depth_blue)),
            )
        records.append({"phase": phase, "validatedStageCount": len(depth_paths)})

    print(
        json.dumps(
            {
                "status": "passed",
                "connectivity": "four-neighbour/shared-side only",
                "sourceRequirement": "every blue component intersects a qualified source",
                "minimumBlueComponentPixels": minimum_blue_component_pixels,
                "isolatedSourcePixelInstances": isolated_source_pixel_instances,
                "disconnectedGreenPixelInstances": disconnected_pixel_instances,
                "developedUncertaintyPixelInstances": uncertainty_pixel_instances,
                "postCrestBlueWaterSurface": "full source-block/gauge stage",
                "visibleFeederPixelInstances": feeder_pixel_instances,
                "offRoadVisibleFeederPixelInstances": 0,
                "roadCorridorPixels": int(np.count_nonzero(road)),
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "sourceDistance": source_distance_diagnostics,
                "phases": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
