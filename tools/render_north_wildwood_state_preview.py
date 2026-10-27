#!/usr/bin/env python3
"""Render one saved North Wildwood solver state for visual QA."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

import simulate_north_wildwood_hydraulics as model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-depth-ft", type=float, default=0.01)
    parser.add_argument("--smoothing-sigma", type=float, default=1.6)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    state = np.load(args.state)
    surface = state["surface"]
    storage = state["storage"]
    manifest = json.loads((args.graph / "graph_manifest.json").read_text())
    shape = (int(manifest["height"]), int(manifest["width"]))
    elevation10 = np.memmap(
        args.graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=shape,
    )[model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE, model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE]
    zone = np.memmap(
        args.graph / "zone_id.raw",
        dtype="<i4",
        mode="r",
        shape=shape,
    )[model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE, model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE]
    source = np.memmap(
        args.graph / "source_flag.raw",
        dtype="u1",
        mode="r",
        shape=shape,
    )[model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE, model.RENDER_STRIDE // 2 :: model.RENDER_STRIDE] != 0
    valid = elevation10 != np.iinfo(np.int16).min
    zone_lookup = np.where(zone >= 0, zone, 0)
    wet_zone = valid & (zone >= 0) & (storage[zone_lookup] > 0.01)
    local_surface = surface[zone_lookup].astype(np.float32)
    if args.smoothing_sigma < 0 or not np.isfinite(args.smoothing_sigma):
        raise ValueError("Smoothing sigma must be finite and nonnegative")
    if args.smoothing_sigma > 0:
        if model.gaussian_filter is None:
            raise RuntimeError("SciPy is required for smoothing; use --smoothing-sigma 0 for unsmoothed state QA")
        wet_weight = model.gaussian_filter(wet_zone.astype(np.float32), sigma=args.smoothing_sigma, mode="nearest")
        filtered_surface = model.gaussian_filter(
            np.where(wet_zone, local_surface, 0.0), sigma=args.smoothing_sigma, mode="nearest",
        )
        local_surface = np.where(
            wet_zone,
            np.divide(filtered_surface, np.maximum(wet_weight, 1e-6),
                      out=np.full_like(filtered_surface, -9999.0), where=wet_weight > 1e-6),
            -9999.0,
        )
    ground = elevation10.astype(np.float32) / 10.0
    depth = local_surface - ground
    flooded = wet_zone & (depth >= args.minimum_depth_ft)
    codes = np.zeros(zone.shape, dtype=np.uint8)
    codes[flooded] = (
        np.digitize(depth[flooded], model.DEPTH_BREAKS_FT, right=False) + 1
    ).astype(np.uint8)
    colors, alpha = model.palette(model.DEPTH_COLORS, len(model.DEPTH_COLORS) + 1)
    image = Image.fromarray(codes, mode="P")
    image.putpalette(colors)
    image.info["transparency"] = alpha
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG", optimize=False, compress_level=7)
    print(json.dumps({
        "output": str(args.output.resolve()),
        "minimumDepthFt": args.minimum_depth_ft,
        "floodedPixels": int(flooded.sum()),
        "sourceFloodedPixels": int((flooded & source).sum()),
        "terrainFloodedPixels": int((flooded & ~source).sum()),
        "terrainToSourcePixelRatio": round(
            float((flooded & ~source).sum()) / max(1, int((flooded & source).sum())),
            6,
        ),
        "bytes": args.output.stat().st_size,
    }, indent=2))


if __name__ == "__main__":
    main()
