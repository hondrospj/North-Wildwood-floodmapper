#!/usr/bin/env python3
"""Verify every phase-aware render against the conditional-connectivity mask."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, label as ndimage_label


WIDTH = 10_930
HEIGHT = 14_120
RENDER_STRIDE = 5
RENDER_WIDTH = WIDTH // RENDER_STRIDE
RENDER_HEIGHT = HEIGHT // RENDER_STRIDE
FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    (
        (0, 1, 0),
        (1, 1, 1),
        (0, 1, 0),
    ),
    dtype=np.uint8,
)
VISIBLE_FEEDER_WIDTH_STRUCTURE = FOUR_NEIGHBOUR_STRUCTURE


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
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
    if stage <= 3.25:
        return 0.75
    if stage >= 5.25:
        return 0.0
    x = stage - 3.25
    return 0.125 * x * x - 0.625 * x + 0.75


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
) -> tuple[np.ndarray, np.ndarray]:
    """Reproduce the renderer's shortest source-feeder construction."""
    labels, component_count = ndimage_label(
        adjusted,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return adjusted, np.zeros(adjusted.shape, dtype=bool)
    source_labels = np.unique(labels[adjusted & source])
    source_labels = source_labels[source_labels > 0]
    detached = np.setdiff1d(
        np.arange(1, component_count + 1, dtype=np.int32),
        source_labels,
        assume_unique=True,
    )
    if detached.size == 0:
        return adjusted, np.zeros(adjusted.shape, dtype=bool)

    source_lookup = np.zeros(component_count + 1, dtype=bool)
    source_lookup[source_labels] = True
    routed_source = adjusted & source_lookup[labels]
    distance = np.full(adjusted.shape, -1, dtype=np.int16)
    distance[routed_source] = 0
    frontier = routed_source
    unresolved = set(int(value) for value in detached)
    first_hits: dict[int, int] = {}
    for step in range(1, np.iinfo(np.int16).max):
        new = (
            binary_dilation(frontier, structure=FOUR_NEIGHBOUR_STRUCTURE)
            & baseline
            & (distance < 0)
        )
        if not np.any(new):
            break
        distance[new] = step
        positions = np.flatnonzero(new & (labels > 0))
        if positions.size:
            values = labels.ravel()[positions]
            for value in np.unique(values):
                label_id = int(value)
                if label_id in unresolved:
                    first = int(np.flatnonzero(values == label_id)[0])
                    first_hits[label_id] = int(positions[first])
                    unresolved.remove(label_id)
        if not unresolved:
            break
        frontier = new
    if unresolved:
        raise AssertionError(f"Validator could not route feeders: {unresolved}")

    paths = np.zeros(adjusted.shape, dtype=bool)
    height, width = adjusted.shape
    for position in first_hits.values():
        y, x = divmod(position, width)
        while distance[y, x] > 0:
            paths[y, x] = True
            previous = int(distance[y, x]) - 1
            for candidate_y, candidate_x in (
                (y - 1, x),
                (y, x - 1),
                (y, x + 1),
                (y + 1, x),
            ):
                if (
                    0 <= candidate_y < height
                    and 0 <= candidate_x < width
                    and distance[candidate_y, candidate_x] == previous
                ):
                    y, x = candidate_y, candidate_x
                    break
            else:
                raise AssertionError("Validator feeder trace is discontinuous")
        paths[y, x] = True
    feeder = (
        binary_dilation(paths, structure=VISIBLE_FEEDER_WIDTH_STRUCTURE)
        & baseline
        & ~adjusted
    )
    return adjusted | feeder, feeder


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
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
    records = []
    maximum_components = 0
    maximum_blue_pixels = 0
    minimum_blue_component_pixels = None
    isolated_source_pixel_instances = 0
    uncertainty_pixel_instances = 0
    disconnected_pixel_instances = 0
    recession_retained_pixel_instances = 0
    feeder_pixel_instances = 0

    for phase in ("slack", "filling", "draining"):
        relative = "" if phase == "slack" else phase
        depth_dir = assets / "DepthPNGs" / "North Wildwood" / relative
        stage_dir = assets / "StagePNGs" / "North Wildwood" / relative
        depth_paths = sorted(depth_dir.glob("NorthWildwoodDepth*.png"))
        if len(depth_paths) != 201:
            raise AssertionError(
                f"Expected 201 {phase} depth PNGs, found {len(depth_paths)}"
            )
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
                if phase != "draining" and source_labels.size != component_count:
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
            if phase == "draining":
                developed_stage = stage + adjustment
                developed_blue = (
                    activation_developed <= developed_stage + 1e-9
                )
            else:
                phase_adjustment = adjustment if phase == "filling" else 0.0
                developed_stage = stage - phase_adjustment
                developed_blue = (
                    (activation_developed <= stage + 1e-9)
                    & (ground_developed <= developed_stage + 1e-9)
                )
            adjusted_blue = valid & (
                developed_blue
                | (activation_undeveloped <= stage + 1e-9)
            )
            if phase == "draining":
                expected_blue = adjusted_blue
                feeder = np.zeros(expected_blue.shape, dtype=bool)
            else:
                expected_blue, feeder = add_visible_source_feeders(
                    adjusted_blue,
                    baseline,
                    source,
                )
            disconnected = valid & (ground < stage - 0.005) & ~baseline
            penalized = baseline & ~expected_blue
            expected_green = ~expected_blue & (disconnected | penalized)
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
            disconnected_pixel_instances += int(np.count_nonzero(disconnected))
            if phase != "draining":
                uncertainty_pixel_instances += int(np.count_nonzero(penalized))
                feeder_pixel_instances += int(np.count_nonzero(feeder))
            if phase == "draining":
                recession_retained_pixel_instances += int(
                    np.count_nonzero(expected_blue & ~baseline)
                )
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
                "sourceRequirement": (
                    "every filling/slack blue component intersects a qualified "
                    "source; draining may retain isolated developed-land lag"
                ),
                "minimumBlueComponentPixels": minimum_blue_component_pixels,
                "isolatedSourcePixelInstances": isolated_source_pixel_instances,
                "disconnectedGreenPixelInstances": disconnected_pixel_instances,
                "developedUncertaintyPixelInstances": uncertainty_pixel_instances,
                "developedRecessionRetainedPixelInstances": recession_retained_pixel_instances,
                "visibleFeederPixelInstances": feeder_pixel_instances,
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "phases": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
