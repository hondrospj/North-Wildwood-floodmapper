#!/usr/bin/env python3
"""Validate local hydraulic manifests and every rendered query/color pair."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        delete=False,
    ) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def decode_query(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with Image.open(path) as image:
        encoded = np.asarray(image.convert("RGB"), dtype=np.uint16)
    wet = encoded[..., 2] == 1
    depth_mm = (encoded[..., 0] << 8) + encoded[..., 1]
    if np.any((encoded[..., 2] != 0) & (encoded[..., 2] != 1)):
        raise RuntimeError(f"Invalid wet flag in {path}")
    if np.any((~wet) & (depth_mm != 0)):
        raise RuntimeError(f"Dry pixels contain depth in {path}")
    return depth_mm, wet


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_file_record(
    public_directory: Path,
    record: dict[str, Any],
) -> Path:
    path = public_directory / record["path"]
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size != int(record["bytes"]):
        raise RuntimeError(f"Byte-count mismatch for {path}")
    if sha256(path) != record["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch for {path}")
    return path


def impact_code(boundary_stage_navd88_ft: float, thresholds: dict[str, Any]) -> int:
    if boundary_stage_navd88_ft < float(thresholds["moderate"]):
        return 1
    if boundary_stage_navd88_ft < float(thresholds["major"]):
        return 2
    return 3


def frame_local_date(time_utc: str, time_zone: ZoneInfo) -> str:
    value = datetime.fromisoformat(time_utc.replace("Z", "+00:00"))
    return value.astimezone(time_zone).date().isoformat()


def validate_scenario(
    config: dict[str, Any],
    cycle_id: str,
    scenario: str,
) -> dict[str, Any]:
    run_directory = ROOT / "model/runs" / cycle_id / scenario
    run_manifest = read_json(run_directory / "run_manifest.json")
    public_directory = run_directory / "public"
    manifest = read_json(public_directory / "manifest.json")
    if run_manifest.get("status") != "complete" or manifest.get("status") != "complete":
        raise RuntimeError(f"{scenario} is not marked complete")
    if run_manifest.get("cycleId") != cycle_id or manifest.get("cycleId") != cycle_id:
        raise RuntimeError(f"{scenario} cycle mismatch")
    if run_manifest.get("scenario") != scenario or manifest.get("scenario") != scenario:
        raise RuntimeError(f"{scenario} scenario mismatch")
    if run_manifest["output"]["frameCount"] != manifest["frameCount"]:
        raise RuntimeError(f"{scenario} frame count mismatch")
    maximum_speed = float(run_manifest["qualitySummary"]["maximumSpeedMps"])
    if not np.isfinite(maximum_speed) or maximum_speed > 5.0:
        raise RuntimeError(
            f"{scenario} has an implausible maximum speed of {maximum_speed:.3f} m/s"
        )

    frames = manifest["frames"]
    expected_interval = int(manifest["frameIntervalSeconds"])
    timestamps = [
        datetime.fromisoformat(frame["timeUtc"].replace("Z", "+00:00"))
        for frame in frames
    ]
    for before, after in zip(timestamps, timestamps[1:]):
        if int((after - before).total_seconds()) != expected_interval:
            raise RuntimeError(f"{scenario} contains a non-15-minute frame interval")

    time_zone = ZoneInfo(config["render"]["dailyMaximumTimeZone"])
    daily_maximums: dict[str, np.ndarray] = {}
    daily_impacts: dict[str, np.ndarray] = {}
    impact_thresholds = config["render"]["impactThresholdsNavd88Ft"]
    impact_arrival_codes: np.ndarray | None = None
    cycle_guidance_path = ROOT / "model/state" / f"petss_{cycle_id}.json"
    guidance = read_json(
        cycle_guidance_path
        if cycle_guidance_path.is_file()
        else ROOT / "model/state/latest_petss.json"
    )
    if guidance.get("cycleId") != cycle_id:
        raise RuntimeError(f"{scenario} validation guidance cycle mismatch")
    guidance_frames = guidance["scenarios"][scenario]
    if len(guidance_frames) != len(frames):
        raise RuntimeError(f"{scenario} guidance/render frame count mismatch")
    total_bytes = 0
    for index, frame in enumerate(frames):
        guidance_frame = guidance_frames[index]
        if (
            frame["timeUtc"] != guidance_frame["timeUtc"]
            or int(frame["modelTimeSeconds"])
            != int(guidance_frame["secondsFromModelStart"])
            or abs(
                float(frame["boundaryStageNavd88M"])
                - float(guidance_frame["navd88M"])
            )
            > 1e-6
            or abs(
                float(frame["boundaryStageNavd88Ft"])
                - float(guidance_frame["navd88Ft"])
            )
            > 1e-6
        ):
            raise RuntimeError(f"{scenario} frame {index} does not match PETSS")
        visible_path = verify_file_record(public_directory, frame["visible"])
        impact_path = verify_file_record(public_directory, frame["impact"])
        query_path = verify_file_record(public_directory, frame["query"])
        total_bytes += (
            visible_path.stat().st_size
            + impact_path.stat().st_size
            + query_path.stat().st_size
        )
        depth_mm, wet = decode_query(query_path)
        with Image.open(visible_path) as visible_image:
            visible_codes = np.asarray(visible_image, dtype=np.uint8)
        with Image.open(impact_path) as impact_image:
            impact_codes = np.asarray(impact_image, dtype=np.uint8)
        if visible_codes.shape != depth_mm.shape:
            raise RuntimeError(f"Visible/query shape mismatch at {scenario} frame {index}")
        if not np.array_equal(visible_codes > 0, wet):
            raise RuntimeError(f"Visible/query wet mask mismatch at {scenario} frame {index}")
        if impact_codes.shape != depth_mm.shape:
            raise RuntimeError(f"Impact/query shape mismatch at {scenario} frame {index}")
        if impact_arrival_codes is None:
            impact_arrival_codes = np.zeros(impact_codes.shape, dtype=np.uint8)
        newly_wet = wet & (impact_arrival_codes == 0)
        impact_arrival_codes[newly_wet] = impact_code(
            float(frame["boundaryStageNavd88Ft"]),
            impact_thresholds,
        )
        expected_impact = np.where(wet, impact_arrival_codes, 0)
        if not np.array_equal(impact_codes, expected_impact):
            raise RuntimeError(f"Impact classification mismatch at {scenario} frame {index}")
        if int(np.count_nonzero(wet)) != int(frame["wetPixelCount"]):
            raise RuntimeError(f"Wet pixel count mismatch at {scenario} frame {index}")
        decoded_maximum_m = float(np.max(depth_mm)) / 1000.0
        if abs(decoded_maximum_m - float(frame["maximumDepthM"])) > 0.002:
            raise RuntimeError(f"Maximum depth mismatch at {scenario} frame {index}")
        date_local = frame_local_date(frame["timeUtc"], time_zone)
        if date_local not in daily_maximums:
            daily_maximums[date_local] = depth_mm.copy()
            daily_impacts[date_local] = impact_codes.copy()
        else:
            np.maximum(daily_maximums[date_local], depth_mm, out=daily_maximums[date_local])
            np.maximum(daily_impacts[date_local], impact_codes, out=daily_impacts[date_local])
        if index % 100 == 0 or index == len(frames) - 1:
            print(f"  {scenario}: validated {index + 1}/{len(frames)} frames")

    daily_records = {record["dateLocal"]: record for record in manifest["dailyMaximums"]}
    if set(daily_records) != set(daily_maximums):
        raise RuntimeError(f"{scenario} daily-maximum date set mismatch")
    for date_local, expected_depth_mm in daily_maximums.items():
        record = daily_records[date_local]
        query_path = verify_file_record(public_directory, record["query"])
        visible_path = verify_file_record(public_directory, record["visible"])
        impact_path = verify_file_record(public_directory, record["impact"])
        actual_depth_mm, actual_wet = decode_query(query_path)
        with Image.open(visible_path) as visible_image:
            visible_codes = np.asarray(visible_image, dtype=np.uint8)
        with Image.open(impact_path) as impact_image:
            impact_codes = np.asarray(impact_image, dtype=np.uint8)
        if not np.array_equal(actual_depth_mm, expected_depth_mm):
            raise RuntimeError(
                f"{scenario} {date_local} is not the cellwise 15-minute maximum"
            )
        if not np.array_equal(visible_codes > 0, actual_wet):
            raise RuntimeError(f"{scenario} {date_local} daily visible/query mismatch")
        if not np.array_equal(impact_codes, daily_impacts[date_local]):
            raise RuntimeError(f"{scenario} {date_local} daily impact is not exact")
        total_bytes += (
            query_path.stat().st_size
            + visible_path.stat().st_size
            + impact_path.stat().st_size
        )

    return {
        "scenario": scenario,
        "frameCount": len(frames),
        "dailyMaximumCount": len(daily_records),
        "maximumSpeedMps": maximum_speed,
        "triangleCount": run_manifest["domain"]["triangleCount"],
        "openBoundaryEdgeCount": run_manifest["domain"]["openBoundaryEdgeCount"],
        "renderWidth": manifest["image"]["width"],
        "renderHeight": manifest["image"]["height"],
        "publicBytes": total_bytes,
        "boundsWgs84": manifest["boundsWgs84"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--cycle-id")
    args = parser.parse_args()

    config = read_json(args.config.resolve())
    guidance = read_json(ROOT / "model/state/latest_petss.json")
    cycle_id = args.cycle_id or guidance["cycleId"]
    results = [
        validate_scenario(config, cycle_id, scenario)
        for scenario in config["petss"]["scenarios"]
    ]
    if len({json.dumps(result["boundsWgs84"]) for result in results}) != 1:
        raise RuntimeError("Scenario render bounds do not match")
    if len({result["frameCount"] for result in results}) != 1:
        raise RuntimeError("Scenario frame counts do not match")

    report = {
        "schema": "north-wildwood-product-validation-v1",
        "status": "passed",
        "validatedUtc": utc_now(),
        "cycleId": cycle_id,
        "scenarios": results,
        "totalPublicBytes": sum(result["publicBytes"] for result in results),
    }
    path = ROOT / "model/state" / f"validation_{cycle_id}.json"
    atomic_json(path, report)
    print(
        f"Validated {cycle_id}: {report['totalPublicBytes'] / 1048576:.1f} MiB "
        "across all scenarios."
    )
    print(path)


if __name__ == "__main__":
    main()
