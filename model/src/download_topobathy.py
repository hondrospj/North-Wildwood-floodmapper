#!/usr/bin/env python3
"""Download only NOAA topobathymetry tiles intersecting the model domain."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
USER_AGENT = "North-Wildwood-Floodmapper-ANUGA/1.0"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def asset_bounds(asset: dict[str, Any]) -> tuple[float, float, float, float]:
    transform = asset["proj:transform"]
    rows, cols = asset["proj:shape"]
    a, b, c, d, e, f = map(float, transform)
    corners = (
        (c, f),
        (c + a * cols, f + d * cols),
        (c + b * rows, f + e * rows),
        (c + a * cols + b * rows, f + d * cols + e * rows),
    )
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    return min(xs), min(ys), max(xs), max(ys)


def intersects(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> bool:
    return not (
        first[2] <= second[0]
        or first[0] >= second[2]
        or first[3] <= second[1]
        or first[1] >= second[3]
    )


def selected_assets(
    collection: dict[str, Any],
    domain: tuple[float, float, float, float],
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for feature in collection["features"]:
        asset = next(iter(feature["assets"].values()))
        bounds = asset_bounds(asset)
        if intersects(bounds, domain):
            selected.append(
                {
                    "id": feature["id"],
                    "url": asset["href"],
                    "bounds": bounds,
                    "shape": asset["proj:shape"],
                    "statistics": asset.get("raster:bands", [{}])[0].get("stats"),
                }
            )
    return sorted(selected, key=lambda item: item["id"])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_one(record: dict[str, Any], directory: Path) -> dict[str, Any]:
    destination = directory / f"{record['id']}.tif"
    if destination.is_file() and destination.stat().st_size > 1024:
        return {
            **record,
            "path": destination.relative_to(ROOT).as_posix(),
            "bytes": destination.stat().st_size,
            "sha256": sha256(destination),
            "downloaded": False,
        }

    request = urllib.request.Request(
        record["url"],
        headers={"User-Agent": USER_AGENT},
    )
    last_error: Exception | None = None
    for attempt in range(1, 6):
        temporary: Path | None = None
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                with tempfile.NamedTemporaryFile(
                    prefix=f".{record['id']}.",
                    suffix=".download",
                    dir=directory,
                    delete=False,
                ) as stream:
                    temporary = Path(stream.name)
                    while block := response.read(1024 * 1024):
                        stream.write(block)
            if temporary.stat().st_size <= 1024:
                raise RuntimeError(f"download was unexpectedly small: {temporary.stat().st_size}")
            os.replace(temporary, destination)
            return {
                **record,
                "path": destination.relative_to(ROOT).as_posix(),
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "downloaded": True,
            }
        except Exception as error:
            last_error = error
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if attempt < 5:
                time.sleep(min(20, 2**attempt))
    raise RuntimeError(f"Failed to download {record['id']}: {last_error}")


def prepare_seamless_fallback(config: dict[str, Any]) -> dict[str, Any]:
    """Stream only the configured model window from NOAA's multi-gigabyte COG."""
    terrain = config["terrain"]
    destination = ROOT / terrain["seamlessLandFallback"]
    if destination.is_file() and destination.stat().st_size > 1024:
        return {
            "path": destination.relative_to(ROOT).as_posix(),
            "bytes": destination.stat().st_size,
            "sha256": sha256(destination),
            "downloaded": False,
        }

    executable = shutil.which("gdalwarp")
    if executable is None:
        raise RuntimeError("gdalwarp is required to acquire the NOAA fallback DEM")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".incomplete")
    temporary.unlink(missing_ok=True)
    domain = config["domain"]
    resolution = str(float(domain["terrainGridM"]))
    source = "/vsicurl/" + str(terrain["seamlessFallbackUrl"])
    command = [
        executable,
        "-overwrite",
        "-of",
        "GTiff",
        "-t_srs",
        str(config["modelCrs"]),
        "-te",
        str(float(domain["xmin"])),
        str(float(domain["ymin"])),
        str(float(domain["xmax"])),
        str(float(domain["ymax"])),
        "-tr",
        resolution,
        resolution,
        "-tap",
        "-r",
        "bilinear",
        "-srcnodata",
        "-9999",
        "-dstnodata",
        "-9999",
        "-co",
        "TILED=YES",
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "PREDICTOR=3",
        source,
        str(temporary),
    ]
    try:
        subprocess.run(command, cwd=ROOT, check=True)
        if not temporary.is_file() or temporary.stat().st_size <= 1024:
            raise RuntimeError("NOAA fallback window was unexpectedly small")
        os.replace(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "path": destination.relative_to(ROOT).as_posix(),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "downloaded": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    config = read_json(args.config.resolve())
    domain_config = config["domain"]
    domain = tuple(
        float(domain_config[key])
        for key in ("xmin", "ymin", "xmax", "ymax")
    )
    stac_path = ROOT / config["terrain"]["topobathyStac"]
    tile_directory = ROOT / config["terrain"]["topobathyDirectory"]
    tile_directory.mkdir(parents=True, exist_ok=True)
    fallback = prepare_seamless_fallback(config)
    print(
        f"{'downloaded' if fallback['downloaded'] else 'verified'}: "
        f"NOAA seamless fallback ({fallback['bytes']:,} bytes)"
    )

    records = selected_assets(read_json(stac_path), domain)
    if not records:
        raise RuntimeError("No NOAA topobathymetry tiles intersect the configured domain")
    print(f"Selected {len(records)} NOAA topobathymetry tiles.")

    completed: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(download_one, record, tile_directory): record
            for record in records
        }
        for future in as_completed(futures):
            result = future.result()
            completed.append(result)
            verb = "downloaded" if result["downloaded"] else "verified"
            print(f"{verb}: {result['id']} ({result['bytes']:,} bytes)")

    manifest = {
        "schema": "north-wildwood-topobathy-acquisition-v1",
        "source": config["terrain"]["topobathyDataset"],
        "sourceIndex": config["terrain"]["topobathyStac"],
        "modelCrs": config["modelCrs"],
        "domain": {
            "xmin": domain[0],
            "ymin": domain[1],
            "xmax": domain[2],
            "ymax": domain[3],
        },
        "tileCount": len(completed),
        "totalBytes": sum(record["bytes"] for record in completed),
        "seamlessFallback": fallback,
        "tiles": sorted(completed, key=lambda item: item["id"]),
    }
    manifest_path = tile_directory / "acquisition_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
