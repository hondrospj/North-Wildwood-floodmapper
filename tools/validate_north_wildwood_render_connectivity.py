#!/usr/bin/env python3
"""Verify routed-water PNG masks while keeping source forcing invisible."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_cdt
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
# Each simultaneous one-minute flux update can activate no more than one
# control volume. The longest atlas transition is the eight-minute typical
# 0.1-foot rise followed by the explicit 15-minute crest hold. The graph
# manifest supplies the selected resolution so the travel envelope remains a
# physical time/distance check rather than a hard-coded legacy-mesh allowance.
MAX_TRANSITION_MINUTES = 23
FAMILIES = (
    "rising_slow",
    "rising_typical",
    "rising_fast",
    "crest",
    "falling_minor",
    "falling_moderate",
    "falling_extreme",
)
SOURCE_BLOCK_ACTIVATION_NAVD88_FT = 2.0
MIN_DISPLAY_DEPTH_FT = 0.05


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    return parser.parse_args()


def aggregate_any(raw: np.ndarray) -> np.ndarray:
    return raw.reshape(
        RENDER_HEIGHT,
        RENDER_STRIDE,
        RENDER_WIDTH,
        RENDER_STRIDE,
    ).any(axis=(1, 3))


def largest_connected(mask: np.ndarray) -> int:
    labels, count = ndimage_label(mask, structure=FOUR_NEIGHBOUR_STRUCTURE)
    if not count:
        return 0
    return int(np.bincount(labels.ravel())[1:].max())


def main() -> None:
    args = parse_args()
    graph = args.graph.resolve()
    assets = args.assets.resolve()
    graph_manifest = json.loads(
        (graph / "graph_manifest.json").read_text(encoding="utf-8")
    )
    control_volume_size_ft = float(graph_manifest["controlVolumeSizeFt"])
    max_new_water_distance_pixels = int(
        np.ceil(
            MAX_TRANSITION_MINUTES
            * control_volume_size_ft
            / RENDER_STRIDE
        )
    )
    source_flag = np.memmap(
        graph / "source_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    source = aggregate_any(source_flag != 0)
    elevation10 = np.memmap(
        graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    valid_raw = elevation10 != np.iinfo(np.int16).min
    valid = aggregate_any(valid_raw)
    source_counts = (source_flag != 0).reshape(
        RENDER_HEIGHT,
        RENDER_STRIDE,
        RENDER_WIDTH,
        RENDER_STRIDE,
    ).sum(axis=(1, 3))
    valid_counts = valid_raw.reshape(
        RENDER_HEIGHT,
        RENDER_STRIDE,
        RENDER_WIDTH,
        RENDER_STRIDE,
    ).sum(axis=(1, 3))
    source_only = (valid_counts > 0) & (source_counts == valid_counts)
    records = []
    family_hashes: dict[str, list[bytes]] = {}
    maximum_components = 0
    maximum_blue_pixels = 0
    maximum_connected_change = 0
    maximum_connected_change_frame = None
    maximum_new_water_distance_pixels = 0.0
    maximum_new_water_distance_frame = None
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
            if np.any(depth_codes > 11 * 4):
                raise AssertionError(f"Potential/equilibrium color leaked into {depth_path}")
            if np.any(stage_codes > 3 * 4):
                raise AssertionError(f"Potential/equilibrium color leaked into {stage_path}")

            depth_blue = depth_codes >= 1
            stage_blue = stage_codes >= 1
            if not np.array_equal(depth_blue, stage_blue):
                raise AssertionError(
                    f"Depth/stage water masks differ for {family} {code}"
                )
            stage_navd88_ft = int(code.removeprefix("p")) / 100.0
            if (
                family in ("rising_slow", "rising_typical", "rising_fast", "crest")
                and stage_navd88_ft <= SOURCE_BLOCK_ACTIVATION_NAVD88_FT
                and np.any(depth_blue)
            ):
                raise AssertionError(
                    f"Rendered terrain water appears at or before zero-head "
                    f"source activation in "
                    f"{family} {code}"
                )
            if np.any(depth_blue & source_only):
                raise AssertionError(
                    f"Fixed-head-only forcing cells leaked into the public overlay "
                    f"for {family} {code}"
                )
            if previous_blue is not None:
                arrival_distance = distance_transform_cdt(
                    ~(previous_blue | source),
                    metric="taxicab",
                )
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
                    if direction == "added" and np.any(changed):
                        farthest = float(np.max(arrival_distance[changed]))
                        if farthest > maximum_new_water_distance_pixels:
                            maximum_new_water_distance_pixels = farthest
                            maximum_new_water_distance_frame = {
                                "family": family,
                                "code": code,
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
    if maximum_new_water_distance_pixels > max_new_water_distance_pixels:
        raise AssertionError(
            "An adjacent 0.1-ft frame creates water "
            f"{maximum_new_water_distance_pixels:.1f} five-foot pixels from "
            f"previous water at {maximum_new_water_distance_frame}; physical "
            f"travel envelope is {max_new_water_distance_pixels} pixels"
        )

    print(
        json.dumps(
            {
                "status": "passed",
                "controlVolumeSizeFt": control_volume_size_ft,
                "maximumAllowedNewWaterDistancePixels": max_new_water_distance_pixels,
                "connectivity": "four-neighbour/shared-side only",
                "sourceRequirement": (
                    "the two qualified complete <=2.0-ft NAVD88 fields and their "
                    "enclosed valid pockets are fixed-head forcing only and never "
                    "rendered; public overlays contain only "
                    "finite-storage terrain that received routed volume, and the "
                    "2.0-ft rising and crest frames are transparent"
                ),
                "sourceBlockActivationNavd88Ft": (
                    SOURCE_BLOCK_ACTIVATION_NAVD88_FT
                ),
                "equilibriumPotentialPixels": 0,
                "transparentDryPixelFrameSum": transparent_dry_pixel_frame_sum,
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "maximumConnectedInteriorChangePixels": maximum_connected_change,
                "maximumConnectedInteriorChangeFrame": maximum_connected_change_frame,
                "maximumNewWaterDistancePixels": round(
                    maximum_new_water_distance_pixels,
                    3,
                ),
                "maximumNewWaterDistanceFrame": maximum_new_water_distance_frame,
                "maximumNewWaterDistanceLimitPixels": (
                    max_new_water_distance_pixels
                ),
                "families": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
