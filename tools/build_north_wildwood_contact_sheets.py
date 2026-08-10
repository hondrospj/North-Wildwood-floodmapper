#!/usr/bin/env python3
"""Build compact all-stage contact sheets for visual atlas QA."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


FAMILIES = (
    "rising_slow",
    "rising_typical",
    "rising_fast",
    "crest",
    "falling_minor",
    "falling_moderate",
    "falling_extreme",
)
TILE_WIDTH = 164
TILE_HEIGHT = 212
LABEL_HEIGHT = 18
COLUMNS = 11


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for family in FAMILIES:
        paths = sorted(
            (args.assets / "DepthPNGs" / "North Wildwood" / family).glob(
                "NorthWildwoodDepth*.png"
            )
        )
        if len(paths) != 101:
            raise RuntimeError(f"Expected 101 {family} frames, found {len(paths)}")
        rows = math.ceil(len(paths) / COLUMNS)
        sheet = Image.new(
            "RGB",
            (COLUMNS * TILE_WIDTH, rows * (TILE_HEIGHT + LABEL_HEIGHT)),
            (232, 235, 238),
        )
        draw = ImageDraw.Draw(sheet)
        for index, path in enumerate(paths):
            rgba = Image.open(path).convert("RGBA")
            rgba.thumbnail((TILE_WIDTH, TILE_HEIGHT), Image.Resampling.BILINEAR)
            column = index % COLUMNS
            row = index // COLUMNS
            x = column * TILE_WIDTH + (TILE_WIDTH - rgba.width) // 2
            y = row * (TILE_HEIGHT + LABEL_HEIGHT)
            tile = Image.new("RGB", rgba.size, (245, 247, 249))
            tile.paste(rgba, mask=rgba.getchannel("A"))
            sheet.paste(tile, (x, y))
            stage = index / 10.0
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
