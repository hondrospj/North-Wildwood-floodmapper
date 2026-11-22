#!/usr/bin/env python3
"""Build stage thresholds for parcel-area coverage from a published depth atlas."""
import argparse
from hashlib import sha256
import json
from math import ceil, log, pi, tan
from pathlib import Path

import numpy as np
from PIL import Image

PARCEL_PATH = Path("assets/parcel-history-v2/NorthWildwoodParcels.geojson")
OUTPUT_PATH = Path("assets/parcel-history-v2/NorthWildwoodParcelAreaStages.json")
SHARES = (25, 50, 75)
ENDPOINT_SHARES = (0, 100)


def pixels_for_geometry(geometry, corners, width, height):
    """Rasterize cell centers using the same affine plane as the live map."""
    def mercator(lon, lat):
        return lon * pi / 180, log(tan(pi / 4 + lat * pi / 360))

    origin, east, south = [np.asarray(mercator(*corners[key][::-1]))
                           for key in ("northWest", "northEast", "southWest")]
    transform = np.linalg.inv(np.column_stack((east - origin, south - origin)))

    def project(lon, lat):
        return transform @ (np.asarray(mercator(lon, lat)) - origin)

    kind = geometry["type"]
    if kind not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"Unsupported parcel geometry {kind}")
    polygons = [geometry["coordinates"]] if kind == "Polygon" else geometry["coordinates"]
    indices = []
    total = 0
    for polygon in polygons:
        rings = [[project(*point) for point in ring] for ring in polygon]
        elevations = [p[1] for ring in rings for p in ring]
        for row in range(ceil(min(elevations) * height - .5), ceil(max(elevations) * height - .5)):
            center = (row + .5) / height
            crossings = sorted(
                (a[0] + (center - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) * width
                for ring in rings for a, b in zip(ring[-1:] + ring[:-1], ring)
                if (a[1] > center) != (b[1] > center)
            )
            for left, right in zip(crossings[::2], crossings[1::2]):
                start, end = ceil(left - .5), ceil(right - .5)
                total += end - start
                if 0 <= row < height:
                    indices.extend(row * width + column for column in range(max(0, start), min(width, end)))
    return np.asarray(indices, dtype=np.intp), total


def read_atlas(atlas, grid):
    with Image.open(grid) as query:
        width, height = query.size
        packed = np.array(query.convert("RGBA"))
    covered = (packed[:, :, 0] != 0) | (packed[:, :, 1] != 0)
    unreachable = np.iinfo(np.uint16).max
    first_wet = np.full((height, width), unreachable, dtype=np.uint16)
    digest = sha256()
    for index in range(201):
        path = atlas / f"NorthWildwoodDepthp{index * 10:04d}.png"
        digest.update(sha256(path.read_bytes()).digest())
        with Image.open(path) as image:
            colors = np.asarray(image.convert("RGBA"))
        if colors.shape != (height, width, 4):
            raise ValueError(f"Unexpected atlas dimensions for {path.name}")
        red, green, blue, alpha = np.moveaxis(colors, -1, 0)
        wet = (alpha > 0) & ~(
            (red >= 95) & (red <= 103) & (green >= 208) & (green <= 216) & (blue >= 109) & (blue <= 117)
        )
        if np.any((first_wet != unreachable) & ~wet):
            raise ValueError(f"Wet pixels disappear at stage {index / 10:g}.")
        first_wet[wet & (first_wet == unreachable)] = index
    return first_wet, covered, digest.hexdigest()


def build(atlas, grid, output):
    config = json.loads(Path("floodmapper_v2.json").read_text())
    parcels = json.loads(PARCEL_PATH.read_text())
    corners = config["overlays"]["worldFileCornersWgs84"]
    first_wet, coverage, atlas_hash = read_atlas(atlas, grid)
    height, width = first_wet.shape
    flattened_wet = first_wet.ravel()
    flattened_coverage = coverage.ravel()
    rows = {}
    endpoints = {}
    for feature in parcels["features"]:
        indices, total = pixels_for_geometry(feature["geometry"], corners, width, height)
        valid = indices[flattened_coverage[indices]]
        # With gaps, the actual whole-parcel fraction cannot be inferred.
        if len(valid) != total or not total:
            continue
        sorted_stages = np.sort(flattened_wet[valid])
        thresholds = [int(sorted_stages[ceil(total * share / 100) - 1]) for share in SHARES]
        parcel_id = str(feature["id"])
        rows[parcel_id] = [stage if stage <= 200 else None for stage in thresholds]
        # The 0% choice is any flooding, so it starts when the first cell is wet.
        endpoints[parcel_id] = [int(stage) if stage <= 200 else None for stage in (sorted_stages[0], sorted_stages[-1])]
    output.write_text(json.dumps({
        "schema": "north-wildwood-parcel-area-stages-v1",
        "catalogVersion": config["overlays"]["cacheVersions"]["hydraulic"],
        "atlasPngsSha256": atlas_hash,
        "sharesPercent": SHARES,
        "stagesInTenthsFtNavd88": rows,
        "endpointSharesPercent": ENDPOINT_SHARES,
        "endpointStagesInTenthsFtNavd88": endpoints
    }, separators=(",", ":")) + "\n")
    print(f"Area stages built for {len(rows):,} parcels with complete coverage.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", type=Path, required=True, help="Directory of published slack depth PNGs")
    parser.add_argument("--grid", type=Path, required=True, help="Published packed terrain query PNG")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    build(args.atlas, args.grid, args.output)
