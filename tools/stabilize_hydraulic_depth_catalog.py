#!/usr/bin/env python3
"""Stabilize one or more indexed hydraulic-PNG catalogs without adding frames.

The command is intentionally site-neutral: callers provide catalog folders and
an optional packed ground-query PNG.  Indexed palette codes default to the
shared floodmapper convention (0 dry, 1-11 wet, 12 uncertainty), but can be
overridden for another site family.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

from hydraulic_mask_sequence import (
    HydraulicMaskSequence,
    assert_temporal_invariant,
    repair_small_nodata_values,
)


DEFAULT_DEPTH_BREAKS_FT = np.asarray(
    [0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00],
    dtype=np.float32,
)
STAGE_PATTERN = re.compile(r"([mp])(\d{4})$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog",
        action="append",
        required=True,
        type=Path,
        help="Indexed hydraulic-PNG directory; repeat for phase families.",
    )
    parser.add_argument(
        "--query",
        type=Path,
        help=(
            "Optional RGBA PNG with ground encoded as unsigned red/green "
            "big-endian tenths plus 32768; zero is NoData."
        ),
    )
    parser.add_argument("--wet-code-min", type=int, default=1)
    parser.add_argument("--wet-code-max", type=int, default=11)
    parser.add_argument("--uncertainty-code", type=int, default=12)
    parser.add_argument("--mode", choices=("depth", "stage"), default="depth")
    parser.add_argument(
        "--mask-catalog",
        action="append",
        type=Path,
        help=(
            "Optional authoritative depth-mask folder paired by --catalog "
            "order; useful for making stage and depth footprints identical."
        ),
    )
    parser.add_argument("--mask-wet-code-max", type=int, default=11)
    parser.add_argument("--mask-uncertainty-code", type=int, default=12)
    parser.add_argument(
        "--stage-thresholds",
        type=float,
        nargs=2,
        default=(3.25, 4.25),
        metavar=("MINOR", "MODERATE"),
    )
    parser.add_argument("--max-hole-pixels", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def stage_from_path(path: Path) -> float:
    match = STAGE_PATTERN.search(path.stem)
    if not match:
        raise ValueError(f"Cannot parse a stage code from {path.name}")
    sign = -1.0 if match.group(1) == "m" else 1.0
    return sign * int(match.group(2)) / 100.0


def load_query(
    path: Path | None,
) -> tuple[np.ndarray | None, np.ndarray | None, int]:
    if path is None:
        return None, None, 0
    pixels = np.asarray(Image.open(path).convert("RGBA"))
    encoded = (
        pixels[:, :, 0].astype(np.uint16) * 256
        + pixels[:, :, 1].astype(np.uint16)
    )
    ground = np.full(encoded.shape, np.nan, dtype=np.float32)
    valid = encoded != 0
    ground[valid] = (encoded[valid].astype(np.float32) - 32768.0) / 10.0
    ground, repaired = repair_small_nodata_values(
        ground,
        max_hole_pixels=4,
    )
    activation = np.full(encoded.shape, np.inf, dtype=np.float32)
    connected = pixels[:, :, 2] != 255
    activation[connected] = (
        pixels[:, :, 2][connected].astype(np.float32) - 50.0
    ) / 10.0
    return ground, activation, repaired


def save_indexed(path: Path, codes: np.ndarray, source: Image.Image) -> None:
    palette = source.getpalette()
    transparency = source.info.get("transparency")
    output = Image.fromarray(codes.astype(np.uint8, copy=False), mode="P")
    if palette is not None:
        output.putpalette(palette)
    if transparency is not None:
        output.info["transparency"] = transparency
    output.save(path, format="PNG", optimize=False, compress_level=7)


def stabilize_catalog(
    directory: Path,
    ground: np.ndarray | None,
    activation: np.ndarray | None,
    wet_code_min: int,
    wet_code_max: int,
    uncertainty_code: int,
    max_hole_pixels: int,
    mode: str,
    stage_thresholds: tuple[float, float],
    mask_directory: Path | None,
    mask_wet_code_max: int,
    mask_uncertainty_code: int,
    dry_run: bool,
) -> dict[str, int | float | str | None]:
    paths = sorted(directory.glob("*.png"), key=stage_from_path)
    if not paths:
        raise FileNotFoundError(f"No stage-coded PNGs found in {directory}")
    sequence = HydraulicMaskSequence(max_hole_pixels=max_hole_pixels)
    changed_frames = 0
    changed_pixels = 0
    previous = None
    authoritative_paths = {}
    if mask_directory is not None:
        authoritative_paths = {
            stage_from_path(path): path
            for path in mask_directory.glob("*.png")
        }

    for path in paths:
        stage = stage_from_path(path)
        image = Image.open(path)
        if image.mode != "P":
            raise ValueError(f"Expected an indexed PNG: {path}")
        codes = np.asarray(image).copy()
        if ground is not None and ground.shape != codes.shape:
            raise ValueError(
                f"Query grid {ground.shape} does not match {path} {codes.shape}"
            )
        wet = (codes >= wet_code_min) & (codes <= wet_code_max)
        authoritative_uncertainty = None
        if mask_directory is not None:
            authoritative_path = authoritative_paths.get(stage)
            if authoritative_path is None:
                raise FileNotFoundError(
                    f"No authoritative mask for {stage:.2f} ft in "
                    f"{mask_directory}"
                )
            mask_codes = np.asarray(Image.open(authoritative_path))
            if mask_codes.shape != codes.shape:
                raise ValueError(
                    f"Authoritative mask {mask_codes.shape} does not match "
                    f"{path} {codes.shape}"
                )
            wet = (mask_codes >= 1) & (mask_codes <= mask_wet_code_max)
            authoritative_uncertainty = mask_codes == mask_uncertainty_code
        eligible = None if ground is None else np.isfinite(ground) & (ground < stage - 0.005)
        # When a paired depth catalog is supplied, its stabilized footprint is
        # authoritative.  Do not run a second repair pass that could make the
        # stage and depth products disagree by even one pixel.
        stable = (
            wet.copy()
            if mask_directory is not None
            else sequence.update(wet, "filling", eligible)
        )
        if previous is not None:
            assert_temporal_invariant(previous, stable, "filling")
        previous = stable
        if authoritative_uncertainty is not None:
            synchronized = codes.copy()
            synchronized[~stable & ~authoritative_uncertainty] = 0
            synchronized[authoritative_uncertainty & ~stable] = uncertainty_code
            added_to_stage = stable & ~(
                (codes >= wet_code_min) & (codes <= wet_code_max)
            )
            if activation is None:
                synchronized[added_to_stage] = wet_code_min
            else:
                local_activation = activation[added_to_stage]
                minor, moderate = stage_thresholds
                synchronized[added_to_stage] = np.where(
                    local_activation < minor,
                    wet_code_min,
                    np.where(
                        local_activation < moderate,
                        min(wet_code_min + 1, wet_code_max),
                        wet_code_max,
                    ),
                ).astype(np.uint8)
            code_changes = int(np.count_nonzero(synchronized != codes))
            if code_changes:
                changed_frames += 1
                changed_pixels += code_changes
                if not dry_run:
                    save_indexed(path, synchronized, image)
            continue
        added = stable & ~wet
        added_count = int(np.count_nonzero(added))
        if not added_count:
            continue
        if ground is None:
            # Without terrain, preserve the preceding wet class.  The common
            # production path supplies the packed query and gets exact depth.
            codes[added] = wet_code_min
        elif mode == "depth":
            depth = np.maximum(stage - ground[added], 0.005)
            codes[added] = (
                np.digitize(depth, DEFAULT_DEPTH_BREAKS_FT, right=False)
                + wet_code_min
            ).astype(np.uint8)
        else:
            if activation is None:
                codes[added] = wet_code_min
            else:
                local_activation = activation[added]
                minor, moderate = stage_thresholds
                codes[added] = np.where(
                    local_activation < minor,
                    wet_code_min,
                    np.where(
                        local_activation < moderate,
                        min(wet_code_min + 1, wet_code_max),
                        wet_code_max,
                    ),
                ).astype(np.uint8)
        changed_frames += 1
        changed_pixels += added_count
        if not dry_run:
            save_indexed(path, codes, image)

    return {
        "catalog": str(directory),
        "mode": mode,
        "authoritativeMaskCatalog": (
            str(mask_directory) if mask_directory is not None else None
        ),
        "inputFrames": len(paths),
        "outputFrames": len(paths),
        "frameMultiplier": 1.0,
        "changedFrames": changed_frames,
        "changedPixels": changed_pixels,
        "fillingPixelsPreserved": (
            sequence.diagnostics.filling_pixels_preserved
        ),
        "enclosedHolePixelsRepaired": (
            sequence.diagnostics.enclosed_hole_pixels_repaired
        ),
    }


def main() -> None:
    args = parse_args()
    if args.mask_catalog and len(args.mask_catalog) != len(args.catalog):
        raise ValueError(
            "Repeat --mask-catalog once for every --catalog directory"
        )
    ground, activation, repaired_nodata = load_query(
        args.query.resolve() if args.query else None
    )
    records = [
        stabilize_catalog(
            directory.resolve(),
            ground,
            activation,
            args.wet_code_min,
            args.wet_code_max,
            args.uncertainty_code,
            args.max_hole_pixels,
            args.mode,
            tuple(args.stage_thresholds),
            (
                args.mask_catalog[index].resolve()
                if args.mask_catalog
                else None
            ),
            args.mask_wet_code_max,
            args.mask_uncertainty_code,
            args.dry_run,
        )
        for index, directory in enumerate(args.catalog)
    ]
    print(
        json.dumps(
            {
                "status": "passed",
                "dryRun": bool(args.dry_run),
                "queryNodataPixelsRepaired": repaired_nodata,
                "catalogs": records,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
