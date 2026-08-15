#!/usr/bin/env python3
"""Verify every phase-aware render against the conditional-connectivity mask."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import label as ndimage_label


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


def pool_developed(path: Path) -> np.ndarray:
    raw = np.memmap(path, dtype=np.uint8, mode="r", shape=(HEIGHT, WIDTH))
    count = np.zeros((RENDER_HEIGHT, RENDER_WIDTH), dtype=np.uint8)
    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            count += (
                raw[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE] != 0
            ).astype(np.uint8)
    return count >= 13


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


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
    source = pool_source(graph / "source_flag.raw")
    developed = pool_developed(graph / "developed_flag.raw")
    elevation10 = np.memmap(
        graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    connection10 = np.memmap(
        graph / "connection10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    valid = elevation10 != np.iinfo(np.int16).min
    ground = elevation10.astype(np.float32) / 10.0
    connection = connection10.astype(np.float32) / 10.0
    records = []
    maximum_components = 0
    maximum_blue_pixels = 0
    uncertainty_pixel_instances = 0
    recession_retained_pixel_instances = 0

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
                if np.any(component_sizes[1:] < 2):
                    raise AssertionError(
                        f"Isolated one-pixel blue component in {phase} {code}"
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
            baseline_candidate = (
                valid
                & (ground < stage - 0.005)
                & (connection <= stage + 1e-9)
            )
            baseline = retain_source_connected(baseline_candidate, source)
            adjustment = vertical_penalty(stage)
            adjusted_stage = np.full(ground.shape, stage, dtype=np.float32)
            if phase == "draining":
                adjusted_stage[developed] += adjustment
            else:
                adjusted_stage[developed] -= adjustment
            adjusted_candidate = (
                valid
                & (ground < adjusted_stage - 0.005)
                & (connection <= adjusted_stage + 1e-9)
            )
            expected_blue = retain_source_connected(adjusted_candidate, source)
            expected_green = (
                np.zeros(expected_blue.shape, dtype=bool)
                if phase == "draining"
                else baseline & developed & ~expected_blue
            )
            if not np.array_equal(depth_blue, expected_blue):
                raise AssertionError(
                    f"Rendered blue mask differs from the developed-land "
                    f"conditional-connectivity mask in {phase} {code}"
                )
            if not np.array_equal(depth_codes == 12, expected_green):
                raise AssertionError(
                    f"Rendered green uncertainty differs from the polynomial "
                    f"exclusion band in {phase} {code}"
                )
            uncertainty_pixel_instances += int(np.count_nonzero(expected_green))
            if phase == "draining":
                recession_retained_pixel_instances += int(
                    np.count_nonzero(expected_blue & developed & ~baseline)
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
                    "every blue component intersects a qualified source pixel"
                ),
                "minimumBlueComponentPixels": 2,
                "developedUncertaintyPixelInstances": uncertainty_pixel_instances,
                "developedRecessionRetainedPixelInstances": recession_retained_pixel_instances,
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "phases": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
