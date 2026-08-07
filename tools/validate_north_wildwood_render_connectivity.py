#!/usr/bin/env python3
"""Verify finite-volume PNG masks without rejecting a moving wetting front."""

from __future__ import annotations

import argparse
import hashlib
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
# At five-foot render resolution this is 62,500 square feet (1.43 acres),
# consistent with the declared 15-minute front-travel bound and far below a
# basin- or city-scale component promotion.
MAX_CONNECTED_WET_CHANGE_PIXELS = 2_500


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
    maximum_connected_flood_growth_pixels = 0
    maximum_connected_flood_growth_frame = None
    maximum_connected_drying_pixels = 0
    maximum_connected_drying_frame = None
    eligible_green_touching_blue = 0
    phase_mask_hashes: dict[str, list[bytes]] = {}

    for phase in ("slack", "filling", "draining"):
        relative = "" if phase == "slack" else phase
        depth_dir = assets / "DepthPNGs" / "North Wildwood" / relative
        stage_dir = assets / "StagePNGs" / "North Wildwood" / relative
        depth_paths = sorted(depth_dir.glob("NorthWildwoodDepth*.png"))
        if len(depth_paths) != 221:
            raise AssertionError(
                f"Expected 221 {phase} depth PNGs, found {len(depth_paths)}"
            )
        phase_mask_hashes[phase] = []
        previous_depth_blue = None
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
            if previous_depth_blue is not None:
                for direction, changed in (
                    ("added", depth_blue & ~previous_depth_blue),
                    ("removed", previous_depth_blue & ~depth_blue),
                ):
                    # Open-water boundary pixels are fixed-head forcing, not
                    # city inundation. Measure connected growth only on the
                    # finite-storage terrain reached through source faces.
                    changed = changed & ~source
                    changed_labels, changed_count = ndimage_label(
                        changed,
                        structure=FOUR_NEIGHBOUR_STRUCTURE,
                    )
                    if not changed_count:
                        continue
                    largest_change = int(
                        np.bincount(changed_labels.ravel())[1:].max()
                    )
                    is_flood_growth = (
                        (phase != "draining" and direction == "added")
                        or (phase == "draining" and direction == "removed")
                    )
                    if (
                        is_flood_growth
                        and largest_change > maximum_connected_flood_growth_pixels
                    ):
                        maximum_connected_flood_growth_pixels = largest_change
                        maximum_connected_flood_growth_frame = {
                            "phase": phase,
                            "code": code,
                            "direction": direction,
                        }
                    if (
                        not is_flood_growth
                        and largest_change > maximum_connected_drying_pixels
                    ):
                        maximum_connected_drying_pixels = largest_change
                        maximum_connected_drying_frame = {
                            "phase": phase,
                            "code": code,
                            "direction": direction,
                        }
            previous_depth_blue = depth_blue
            phase_mask_hashes[phase].append(
                hashlib.sha256(depth_blue.tobytes()).digest()
            )
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
                # The routed state has source provenance at graph resolution.
                # At five-foot display resolution, thin channels can disappear,
                # and falling-tide storage can legitimately remain as a
                # disconnected puddle. Filling frames must nevertheless retain
                # at least one visible contact with the qualified source.
                if phase == "filling" and not np.any(depth_blue & source):
                    raise AssertionError(
                        f"Filling water has no visible source contact in {code}"
                    )
            sign = -1.0 if code.startswith("m") else 1.0
            stage = sign * int(code[1:]) / 100.0
            hydraulically_eligible = (
                valid
                & (ground < stage - 0.005)
                & (connection <= stage + 1e-9)
            )
            blue_neighbour = binary_dilation(
                depth_blue,
                structure=FOUR_NEIGHBOUR_STRUCTURE,
            ) & ~depth_blue
            routed_front = (
                (depth_codes == 12)
                & hydraulically_eligible
                & blue_neighbour
            )
            eligible_green_touching_blue += int(np.count_nonzero(routed_front))
            maximum_components = max(maximum_components, int(component_count))
            maximum_blue_pixels = max(
                maximum_blue_pixels,
                int(np.count_nonzero(depth_blue)),
            )
        records.append({"phase": phase, "validatedStageCount": len(depth_paths)})

    if eligible_green_touching_blue == 0:
        raise AssertionError(
            "No finite wetting front was found; assets appear to have reverted "
            "to instantaneous connectivity"
        )
    if phase_mask_hashes["filling"] == phase_mask_hashes["slack"]:
        raise AssertionError("Filling and short-slack rendered masks are identical")
    if phase_mask_hashes["filling"] == phase_mask_hashes["draining"]:
        raise AssertionError("Filling and draining rendered masks are identical")
    if maximum_connected_flood_growth_pixels > MAX_CONNECTED_WET_CHANGE_PIXELS:
        raise AssertionError(
            "An adjacent 0.1-ft frame changes a connected water patch by "
            f"{maximum_connected_flood_growth_pixels:,} pixels in the "
            "phase-time flood-growth direction at "
            f"{maximum_connected_flood_growth_frame}; limit is "
            f"{MAX_CONNECTED_WET_CHANGE_PIXELS:,}"
        )

    print(
        json.dumps(
            {
                "status": "passed",
                "connectivity": "four-neighbour/shared-side only",
                "sourceRequirement": "filling frames retain visible source contact",
                "retainedPuddles": "allowed during draining",
                "minimumBlueComponentPixels": 1,
                "finiteFrontPixelsTouchingBlue": (
                    eligible_green_touching_blue
                ),
                "maximumComponentsInAnyFrame": maximum_components,
                "maximumBluePixelsInAnyFrame": maximum_blue_pixels,
                "maximumConnectedInteriorFloodGrowthPixels": (
                    maximum_connected_flood_growth_pixels
                ),
                "maximumConnectedInteriorFloodGrowthFrame": (
                    maximum_connected_flood_growth_frame
                ),
                "maximumConnectedInteriorFloodGrowthLimitPixels": (
                    MAX_CONNECTED_WET_CHANGE_PIXELS
                ),
                "maximumConnectedInteriorDryingPixels": (
                    maximum_connected_drying_pixels
                ),
                "maximumConnectedInteriorDryingFrame": (
                    maximum_connected_drying_frame
                ),
                "phases": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
