#!/usr/bin/env python3
"""Upload and verify the North Wildwood reduced-drainage feeder v34 tree."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import mimetypes
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parents[1] / "assets" / "hydraulic-v29"
ZONE = "floodmapperv1"
STORAGE_ROOT = f"https://storage.bunnycdn.com/{ZONE}"
CDN_ROOT = "https://floodmapperv1.b-cdn.net"
CACHE_VERSION = "20260815-reduced-drainage-v34"
ATLAS_VERSION = "v34"
FAMILIES = ("filling", "", "draining")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--workers", type=int, default=12)
    return parser.parse_args()


def upload_records() -> list[tuple[Path, str]]:
    records: list[tuple[Path, str]] = []
    for overlay in ("DepthPNGs", "StagePNGs"):
        directory = ROOT / overlay / "North Wildwood"
        for path in sorted(directory.rglob("*.png")):
            relative = path.relative_to(directory).as_posix()
            records.append(
                (path, f"{overlay}/North Wildwood/{ATLAS_VERSION}/{relative}")
            )

    cog_directory = ROOT / "COGs" / "North Wildwood"
    for name in (
        "NorthWildwoodHydraulicQuery5ft.png",
        "NorthWildwoodDevelopedMask5ft.png",
        "NorthWildwoodHydraulicStates.json.png",
    ):
        path = cog_directory / name
        records.append((path, f"COGs/North Wildwood/{ATLAS_VERSION}/{name}"))
    records.append(
        (
            ROOT / "NorthWildwoodHydraulicAssetManifest.json",
            f"COGs/North Wildwood/{ATLAS_VERSION}/NorthWildwoodHydraulicAssetManifest.json.png",
        )
    )

    missing = [str(path) for path, _ in records if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing Bunny assets:\n" + "\n".join(missing))
    if len(records) != 1_210:
        raise RuntimeError(f"Expected 1,210 Bunny assets, found {len(records):,}")
    return records


def content_type(path: Path) -> str:
    if path.name.endswith(".json.png"):
        return "application/octet-stream"
    if path.suffix == ".json":
        return "application/json"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def access_key() -> str:
    key = (
        os.environ.get("BUNNY_STORAGE_PASSWORD", "").strip()
        or os.environ.get("BUNNY_STORAGE_KEY", "").strip()
    )
    if not key:
        key = getpass.getpass("Bunny storage key (input hidden): ").strip()
    if not key:
        raise RuntimeError("No Bunny Storage key was supplied")
    response = requests.get(
        STORAGE_ROOT + "/",
        headers={"AccessKey": key, "Accept": "application/json"},
        timeout=60,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"Bunny credential preflight failed with HTTP {response.status_code}"
        )
    return key


def upload_one(key: str, source: Path, destination: str) -> dict[str, object]:
    url = STORAGE_ROOT + "/" + quote(destination, safe="/")
    headers = {
        "AccessKey": key,
        "Content-Type": content_type(source),
        "Content-Length": str(source.stat().st_size),
    }
    last_error: Exception | None = None
    for attempt in range(1, 5):
        try:
            with source.open("rb") as stream:
                response = requests.put(
                    url,
                    data=stream,
                    headers=headers,
                    timeout=(30, 900),
                )
            if response.status_code in (200, 201):
                return {
                    "destination": destination,
                    "bytes": source.stat().st_size,
                    "status": response.status_code,
                }
            last_error = RuntimeError(
                f"HTTP {response.status_code}: {response.text[:200]}"
            )
        except Exception as error:  # pragma: no cover - network failure detail
            last_error = error
        if attempt < 4:
            time.sleep(2**attempt)
    raise RuntimeError(f"{destination}: {last_error}")


def verification_records(
    records: list[tuple[Path, str]],
) -> list[tuple[Path, str]]:
    wanted: set[str] = {
        f"COGs/North Wildwood/{ATLAS_VERSION}/NorthWildwoodHydraulicQuery5ft.png",
        f"COGs/North Wildwood/{ATLAS_VERSION}/NorthWildwoodDevelopedMask5ft.png",
        f"COGs/North Wildwood/{ATLAS_VERSION}/NorthWildwoodHydraulicStates.json.png",
        f"COGs/North Wildwood/{ATLAS_VERSION}/NorthWildwoodHydraulicAssetManifest.json.png",
    }
    for family in FAMILIES:
        for overlay, prefix in (
            ("DepthPNGs", "NorthWildwoodDepth"),
            ("StagePNGs", "NorthWildwoodStage"),
        ):
            codes = ("p0000", "p0320", "p0420", "p0520", "p2000")
            for code in codes:
                relative = f"{family}/" if family else ""
                wanted.add(
                    f"{overlay}/North Wildwood/{ATLAS_VERSION}/{relative}{prefix}{code}.png"
                )
    if len(records) == 4 and all(f"/{ATLAS_VERSION}/" in destination for _, destination in records):
        return records
    selected = [record for record in records if record[1] in wanted]
    if len(selected) != len(wanted):
        missing = sorted(wanted - {destination for _, destination in selected})
        raise RuntimeError("Missing verification records: " + ", ".join(missing))
    return selected


def verify_public(records: list[tuple[Path, str]]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for source, destination in verification_records(records):
        url = CDN_ROOT + "/" + quote(destination, safe="/")
        response = requests.get(
            url,
            params={"v": CACHE_VERSION},
            headers={"Origin": "https://hondrospj.github.io"},
            timeout=180,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"CDN verification failed for {destination}: "
                f"HTTP {response.status_code}"
            )
        digest = hashlib.sha256(response.content).hexdigest()
        local_digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != local_digest:
            raise RuntimeError(f"CDN checksum mismatch for {destination}")
        allow_origin = response.headers.get("Access-Control-Allow-Origin")
        if allow_origin not in ("*", "https://hondrospj.github.io"):
            raise RuntimeError(f"CDN CORS missing for {destination}")
        results.append(
            {
                "destination": destination,
                "bytes": len(response.content),
                "sha256": digest,
            }
        )
    return results


def main() -> None:
    args = parse_args()
    records = upload_records()
    if args.metadata_only:
        records = [
            record
            for record in records
            if record[1].startswith(f"COGs/North Wildwood/{ATLAS_VERSION}/")
        ]
    total_bytes = sum(path.stat().st_size for path, _ in records)
    print(f"Prepared {len(records):,} files ({total_bytes:,} bytes).")

    completed: list[dict[str, object]] = []
    if not args.verify_only:
        key = access_key()
        failures: list[str] = []
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {
                executor.submit(upload_one, key, source, destination): destination
                for source, destination in records
            }
            for index, future in enumerate(as_completed(futures), start=1):
                destination = futures[future]
                try:
                    completed.append(future.result())
                except Exception as error:  # pragma: no cover - network detail
                    failures.append(f"{destination}: {error}")
                if index % 100 == 0 or index == len(records):
                    print(
                        f"Uploaded {index:,}/{len(records):,}; "
                        f"failures={len(failures)}",
                        flush=True,
                    )
        key = ""
        if failures:
            raise RuntimeError("Upload failures:\n" + "\n".join(failures))

    verification = verify_public(records)
    report = {
        "status": "passed",
        "uploadedCount": len(completed),
        "uploadedBytes": sum(int(row["bytes"]) for row in completed),
        "publicVerificationCount": len(verification),
        "cacheVersion": CACHE_VERSION,
        "verification": verification,
    }
    report_path = Path("/tmp/north-wildwood-bunny-v34-upload.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "verification"}, indent=2))


if __name__ == "__main__":
    main()
