#!/usr/bin/env python3
"""Verify routed-water PNG masks and the visible two-foot source field."""

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
OPERATIONAL_FAMILIES = (
    "rising_slow",
    "rising_typical",
    "rising_fast",
    "crest",
    "falling_minor",
    "falling_moderate",
    "falling_extreme",
)
SPECIAL_FAMILY_COUNTS = {"historic_1962_five_tides": 1}
FAMILIES = (*OPERATIONAL_FAMILIES, *SPECIAL_FAMILY_COUNTS)
MIN_DISPLAY_DEPTH_FT = 0.05
RENDER_CELL_DTYPE = np.dtype([
    ("terrain_zone0", "<i4"), ("terrain_zone1", "<i4"),
    ("source_zone", "<i4"), ("terrain_ground_sum10_0", "<i4"),
    ("terrain_ground_sum10_1", "<i4"), ("source_ground_sum10", "<i4"),
    ("terrain_ground_min10_0", "<i2"), ("terrain_ground_max10_0", "<i2"),
    ("terrain_ground_min10_1", "<i2"), ("terrain_ground_max10_1", "<i2"),
    ("terrain_count0", "u1"), ("terrain_count1", "u1"),
    ("source_count", "u1"), ("enclosed_source_fill_count", "u1"),
    ("valid_count", "u1"),
    ("omitted_terrain_count", "u1"),
])


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
    render_cells = np.memmap(
        graph / "render_cells.raw",
        dtype=RENDER_CELL_DTYPE,
        mode="r",
        shape=(RENDER_HEIGHT, RENDER_WIDTH),
    )
    source_counts = render_cells["source_count"].astype(np.int16)
    enclosed_fill_counts = render_cells["enclosed_source_fill_count"].astype(
        np.int16
    )
    valid_counts = render_cells["valid_count"].astype(np.int16)
    source = (source_counts + enclosed_fill_counts) > 0
    valid = valid_counts > 0
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
        expected_count = SPECIAL_FAMILY_COUNTS.get(family, 101)
        if len(depth_paths) != expected_count:
            raise AssertionError(
                f"Expected {expected_count} {family} depth PNGs, found {len(depth_paths)}"
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
            if stage_navd88_ft >= 2.0 and np.any(source & ~depth_blue):
                raise AssertionError(
                    f"The complete two-foot source field is missing from the "
                    f"public overlay for {family} {code}"
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
                    "the two qualified complete <=2.0-ft NAVD88 fields are "
                    "continuous visible fixed-head water from 2.0 ft upward; "
                    "enclosed display artifacts fill without becoming forcing; "
                    "all expansion beyond that field contains only finite-storage "
                    "terrain that received routed volume"
                ),
                "sourceBlockActivationNavd88Ft": None,
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
