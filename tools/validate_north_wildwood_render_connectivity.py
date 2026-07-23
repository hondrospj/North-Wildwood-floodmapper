#!/usr/bin/env python3
"""Verify that every rendered blue component is side-connected to a source."""

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


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
    source = pool_source(graph / "source_flag.raw")
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
    eligible_green_touching_blue = 0

    for phase in ("slack", "filling", "draining"):
        relative = "" if phase == "slack" else phase
        depth_dir = assets / "DepthPNGs" / "North Wildwood" / relative
        stage_dir = assets / "StagePNGs" / "North Wildwood" / relative
        depth_paths = sorted(depth_dir.glob("NorthWildwoodDepth*.png"))
        if len(depth_paths) != 141:
            raise AssertionError(
                f"Expected 141 {phase} depth PNGs, found {len(depth_paths)}"
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
            stage = sign * int(code[1:]) / 10.0
            hydraulically_eligible = (
                valid
                & (ground < stage - 0.005)
                & (connection <= stage + 1e-9)
            )
            blue_neighbour = binary_dilation(
                depth_blue,
                structure=FOUR_NEIGHBOUR_STRUCTURE,
            ) & ~depth_blue
            invalid_green = (
                (depth_codes == 12)
                & hydraulically_eligible
                & blue_neighbour
            )
            invalid_green_count = int(np.count_nonzero(invalid_green))
            eligible_green_touching_blue += invalid_green_count
            if invalid_green_count:
                raise AssertionError(
                    f"{invalid_green_count} hydraulically eligible green pixels "
                    f"touch blue by a side in {phase} {code}"
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
                "eligibleGreenPixelsTouchingBlue": (
                    eligible_green_touching_blue
                ),
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "phases": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
