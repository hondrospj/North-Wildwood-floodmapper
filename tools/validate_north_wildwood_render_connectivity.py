#!/usr/bin/env python3
"""Verify v20 history-family PNG masks and hidden forcing boundaries."""

from __future__ import annotations

import argparse
import hashlib
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
    ((0, 1, 0), (1, 1, 1), (0, 1, 0)),
    dtype=np.uint8,
)
# 62,500 square feet (1.43 acres) at five-foot display resolution. This limit
# applies to a single connected change, not the many small cells that may
# redistribute water simultaneously across the city.
MAX_CONNECTED_WET_CHANGE_PIXELS = 2_500
FAMILIES = (
    "rising_slow",
    "rising_typical",
    "rising_fast",
    "crest",
    "falling_minor",
    "falling_moderate",
    "falling_extreme",
)
NORMAL_TIDE_DISPLAY_BASELINE_NAVD88_FT = 2.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    return parser.parse_args()


def sample_source(path: Path) -> np.ndarray:
    raw = np.memmap(path, dtype=np.uint8, mode="r", shape=(HEIGHT, WIDTH))
    return raw[
        RENDER_STRIDE // 2 :: RENDER_STRIDE,
        RENDER_STRIDE // 2 :: RENDER_STRIDE,
    ] != 0


def largest_connected(mask: np.ndarray) -> int:
    labels, count = ndimage_label(mask, structure=FOUR_NEIGHBOUR_STRUCTURE)
    if not count:
        return 0
    return int(np.bincount(labels.ravel())[1:].max())


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
    source = sample_source(graph / "source_flag.raw")
    elevation10 = np.memmap(
        graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    valid = elevation10 != np.iinfo(np.int16).min

    records = []
    family_hashes: dict[str, list[bytes]] = {}
    maximum_components = 0
    maximum_blue_pixels = 0
    maximum_connected_change = 0
    maximum_connected_change_frame = None
    transparent_dry_pixel_frame_sum = 0

    for family in FAMILIES:
        depth_dir = assets / "DepthPNGs" / "North Wildwood" / family
        stage_dir = assets / "StagePNGs" / "North Wildwood" / family
        depth_paths = sorted(depth_dir.glob("NorthWildwoodDepth*.png"))
        if len(depth_paths) != 101:
            raise AssertionError(
                f"Expected 101 {family} depth PNGs, found {len(depth_paths)}"
            )
        family_hashes[family] = []
        previous_blue = None
        for depth_path in depth_paths:
            code = depth_path.stem.removeprefix("NorthWildwoodDepth")
            stage_path = stage_dir / f"NorthWildwoodStage{code}.png"
            if not stage_path.is_file():
                raise FileNotFoundError(stage_path)
            depth_codes = np.asarray(Image.open(depth_path))
            stage_codes = np.asarray(Image.open(stage_path))
            if depth_codes.shape != (RENDER_HEIGHT, RENDER_WIDTH):
                raise AssertionError(f"Unexpected render dimensions for {depth_path}")
            if np.any(depth_codes > 11):
                raise AssertionError(f"Potential/equilibrium color leaked into {depth_path}")
            if np.any(stage_codes > 3):
                raise AssertionError(f"Potential/equilibrium color leaked into {stage_path}")

            depth_blue = (depth_codes >= 1) & (depth_codes <= 11)
            stage_blue = (stage_codes >= 1) & (stage_codes <= 3)
            if not np.array_equal(depth_blue, stage_blue):
                raise AssertionError(
                    f"Depth/stage water masks differ for {family} {code}"
                )
            if np.any(depth_blue & source):
                raise AssertionError(
                    f"Fixed-head forcing pixels leaked into {family} {code}"
                )
            stage_navd88_ft = int(code.removeprefix("p")) / 100.0
            if (
                family in ("rising_slow", "rising_typical", "rising_fast", "crest")
                and stage_navd88_ft <= NORMAL_TIDE_DISPLAY_BASELINE_NAVD88_FT
                and np.any(depth_blue)
            ):
                raise AssertionError(
                    f"Ordinary tidal water leaked into land-inundation frame "
                    f"{family} {code}"
                )
            if previous_blue is not None:
                for direction, changed in (
                    ("added", depth_blue & ~previous_blue & ~source),
                    ("removed", previous_blue & ~depth_blue & ~source),
                ):
                    largest = largest_connected(changed)
                    if largest > maximum_connected_change:
                        maximum_connected_change = largest
                        maximum_connected_change_frame = {
                            "family": family,
                            "code": code,
                            "direction": direction,
                        }
            previous_blue = depth_blue
            family_hashes[family].append(hashlib.sha256(depth_blue.tobytes()).digest())
            _, component_count = ndimage_label(
                depth_blue,
                structure=FOUR_NEIGHBOUR_STRUCTURE,
            )
            maximum_components = max(maximum_components, int(component_count))
            maximum_blue_pixels = max(maximum_blue_pixels, int(depth_blue.sum()))
            transparent_dry_pixel_frame_sum += int(np.count_nonzero(valid & ~depth_blue))
        records.append({"family": family, "validatedStageCount": len(depth_paths)})

    if transparent_dry_pixel_frame_sum == 0:
        raise AssertionError("Dry low terrain is not transparent")
    if family_hashes["rising_slow"] == family_hashes["rising_fast"]:
        raise AssertionError("Slow and fast rising histories are identical")
    if family_hashes["rising_typical"] == family_hashes["falling_moderate"]:
        raise AssertionError("Rising and falling histories are identical")
    if maximum_connected_change > MAX_CONNECTED_WET_CHANGE_PIXELS:
        raise AssertionError(
            "An adjacent 0.1-ft frame changes one connected water patch by "
            f"{maximum_connected_change:,} pixels at "
            f"{maximum_connected_change_frame}; limit is "
            f"{MAX_CONNECTED_WET_CHANGE_PIXELS:,}"
        )

    print(
        json.dumps(
            {
                "status": "passed",
                "connectivity": "four-neighbour/shared-side only",
                "sourceRequirement": (
                    "fixed-head forcing pixels remain hydraulically active but are "
                    "absent from rendered flood footprints"
                ),
                "normalTideDisplayBaselineNavd88Ft": (
                    NORMAL_TIDE_DISPLAY_BASELINE_NAVD88_FT
                ),
                "normalTideRequirement": (
                    "rising and crest land-inundation frames through the ordinary "
                    "2.0-ft NAVD88 baseline contain no painted water"
                ),
                "equilibriumPotentialPixels": 0,
                "transparentDryPixelFrameSum": transparent_dry_pixel_frame_sum,
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "maximumConnectedInteriorChangePixels": maximum_connected_change,
                "maximumConnectedInteriorChangeFrame": maximum_connected_change_frame,
                "maximumConnectedInteriorChangeLimitPixels": (
                    MAX_CONNECTED_WET_CHANGE_PIXELS
                ),
                "families": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
