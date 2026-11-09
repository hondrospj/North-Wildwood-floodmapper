#!/usr/bin/env python3
"""Build compact all-stage contact sheets for visual atlas QA."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


LEGACY_FAMILIES = (
    "rising_slow",
    "rising_typical",
    "rising_fast",
    "crest",
    "falling_minor",
    "falling_moderate",
    "falling_extreme",
)
ATLAS_PHASES = {
    "filling": "filling",
    "slack": "",
    "draining-release-15": "draining-release-15",
    "draining-release-30": "draining-release-30",
    "draining": "draining",
}
TILE_WIDTH = 164
TILE_HEIGHT = 212
LABEL_HEIGHT = 18
COLUMNS = 11


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def collect_frames(depth_root: Path) -> dict[str, list[tuple[float, Path]]]:
    if (depth_root / "filling").is_dir() or (depth_root / "NorthWildwoodDepthp0000.png").is_file():
        phases = {
            phase: [
                (code / 100, depth_root / directory / f"NorthWildwoodDepthp{code:04d}.png")
                for code in range(0, 2001, 10)
            ]
            for phase, directory in ATLAS_PHASES.items()
        }
        for frames in phases.values():
            for _, path in frames:
                if not path.is_file():
                    raise RuntimeError(f"Missing atlas frame {path}")
        return phases

    phases = {}
    for family in LEGACY_FAMILIES:
        directory = depth_root / family
        paths = list(directory.glob("NorthWildwoodDepth*.png"))
        if len(paths) != 101:
            raise RuntimeError(f"Expected 101 {family} frames, found {len(paths)}")
        frames = [
            (code / 100, directory / f"NorthWildwoodDepthp{code:04d}.png")
            for code in range(0, 1001, 10)
        ]
        for _, path in frames:
            if not path.is_file():
                raise RuntimeError(f"Missing atlas frame {path}")
        phases[family] = frames
    return phases


def main() -> None:
    args = parse_args()
    phases = collect_frames(args.assets / "DepthPNGs" / "North Wildwood")
    args.output.mkdir(parents=True, exist_ok=True)
    for family, frames in phases.items():
        rows = math.ceil(len(frames) / COLUMNS)
        sheet = Image.new(
            "RGB",
            (COLUMNS * TILE_WIDTH, rows * (TILE_HEIGHT + LABEL_HEIGHT)),
            (232, 235, 238),
        )
        draw = ImageDraw.Draw(sheet)
        for index, (stage, path) in enumerate(frames):
            with Image.open(path) as frame:
                rgba = frame.convert("RGBA")
            rgba.thumbnail((TILE_WIDTH, TILE_HEIGHT), Image.Resampling.BILINEAR)
            column = index % COLUMNS
            row = index // COLUMNS
            x = column * TILE_WIDTH + (TILE_WIDTH - rgba.width) // 2
            y = row * (TILE_HEIGHT + LABEL_HEIGHT)
            tile = Image.new("RGB", rgba.size, (245, 247, 249))
            tile.paste(rgba, mask=rgba.getchannel("A"))
            sheet.paste(tile, (x, y))
            draw.text(
                (column * TILE_WIDTH + 4, y + TILE_HEIGHT),
                f"{stage:0.1f} ft",
                fill=(20, 25, 30),
            )
        output = args.output / f"{family}.png"
        sheet.save(output, optimize=True)
        print(output)


if __name__ == "__main__":
    main()
