#!/usr/bin/env python3
"""Run the complete local North Wildwood forecast-to-Bunny production pipeline."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
CYCLE_PATTERN = re.compile(r"^\d{8}T\d{4}Z$")


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


def run_step(label: str, command: list[str]) -> float:
    print(f"\n[{utc_now()}] {label}")
    started = time.monotonic()
    subprocess.run(command, cwd=ROOT, check=True)
    elapsed = time.monotonic() - started
    print(f"[{utc_now()}] Completed {label} in {elapsed:.1f}s")
    return elapsed


def remote_pointer_cycle(config: dict[str, Any]) -> str | None:
    bunny = config["bunny"]
    remote_path = "/".join(
        (
            bunny["remoteRoot"].strip("/"),
            bunny["currentPointerName"].strip("/"),
        )
    )
    encoded = urllib.parse.quote(remote_path, safe="/")
    url = f"{bunny['cdnBaseUrl'].rstrip('/')}/{encoded}"
    separator = "&" if "?" in url else "?"
    request = urllib.request.Request(
        f"{url}{separator}_pipeline_check={int(time.time())}",
        headers={"User-Agent": "North-Wildwood-Physics-Pipeline/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            value = json.loads(response.read().decode("utf-8"))
        return value.get("cycleId") if value.get("status") == "complete" else None
    except Exception:
        return None


def terrain_is_ready(config: dict[str, Any]) -> bool:
    required = [
        ROOT / config["terrain"]["computationalDem"],
        ROOT / config["terrain"]["displayDem"],
        ROOT / config["terrain"]["bulkheadMask"],
        ROOT / "model/cache/terrain_manifest.json",
    ]
    return all(path.is_file() and path.stat().st_size > 0 for path in required)


def discard_old_local_cycles(current_cycle: str) -> list[str]:
    runs = ROOT / "model/runs"
    deleted: list[str] = []
    if not runs.is_dir():
        return deleted
    for path in runs.iterdir():
        if (
            path.is_dir()
            and path.name != current_cycle
            and CYCLE_PATTERN.fullmatch(path.name)
        ):
            shutil.rmtree(path)
            deleted.append(path.name)
    return sorted(deleted)


def discard_published_hydraulic_states(
    current_cycle: str,
    scenarios: list[str],
) -> list[str]:
    """Keep finished products but remove large transient centroid-state arrays."""
    deleted: list[str] = []
    for scenario in scenarios:
        hydraulic = ROOT / "model/runs" / current_cycle / scenario / "hydraulic"
        if hydraulic.is_dir():
            shutil.rmtree(hydraulic)
            deleted.append(hydraulic.relative_to(ROOT).as_posix())
    return deleted


def hydraulic_is_complete(cycle_id: str, scenario: str) -> bool:
    run_directory = ROOT / "model/runs" / cycle_id / scenario
    run_manifest = run_directory / "run_manifest.json"
    if not run_manifest.is_file():
        return False
    try:
        hydraulic = read_json(run_manifest)
        return (
            hydraulic.get("status") == "complete"
            and hydraulic.get("cycleId") == cycle_id
            and hydraulic.get("scenario") == scenario
        )
    except Exception:
        return False


def hydraulic_state_is_renderable(cycle_id: str, scenario: str) -> bool:
    hydraulic = ROOT / "model/runs" / cycle_id / scenario / "hydraulic"
    return all(
        path.is_file() and path.stat().st_size > 0
        for path in (
            hydraulic / "stage_centroid_m.npy",
            hydraulic / "mesh.npz",
        )
    )


def public_products_are_complete(cycle_id: str, scenario: str) -> bool:
    public_manifest = (
        ROOT / "model/runs" / cycle_id / scenario / "public/manifest.json"
    )
    if not public_manifest.is_file():
        return False
    try:
        public = read_json(public_manifest)
        frames = public.get("frames") or []
        daily = public.get("dailyMaximums") or []
        return (
            public.get("status") == "complete"
            and public.get("cycleId") == cycle_id
            and public.get("scenario") == scenario
            and bool(frames)
            and bool(daily)
            and all(
                all(name in frame for name in ("visible", "impact", "query"))
                for frame in frames
            )
            and all(
                all(name in day for name in ("visible", "impact", "query"))
                for day in daily
            )
        )
    except Exception:
        return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--setup-key", action="store_true")
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Use the existing latest_petss.json (for reproducible local tests)",
    )
    args = parser.parse_args()

    config_path = args.config.resolve()
    config = read_json(config_path)
    state_directory = ROOT / "model/state"
    state_directory.mkdir(parents=True, exist_ok=True)
    cache_directory = ROOT / "model/cache"
    for name, relative in (
        ("MPLCONFIGDIR", "matplotlib"),
        ("PYTHONPYCACHEPREFIX", "pycache"),
        ("XDG_CACHE_HOME", "xdg"),
    ):
        destination = cache_directory / relative
        destination.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault(name, str(destination))
    lock_path = state_directory / "pipeline.lock"
    lock_stream = lock_path.open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("Another North Wildwood physics pipeline is already running; exiting.")
        return

    pipeline_started = time.monotonic()
    status: dict[str, Any] = {
        "schema": "north-wildwood-local-pipeline-v1",
        "status": "running",
        "startedUtc": utc_now(),
        "host": os.uname().nodename,
        "python": sys.executable,
        "steps": [],
    }
    status_path = state_directory / "last_pipeline.json"
    atomic_json(status_path, status)

    def record_step(label: str, command: list[str]) -> None:
        elapsed = run_step(label, command)
        status["steps"].append(
            {"label": label, "elapsedSeconds": round(elapsed, 3)}
        )
        atomic_json(status_path, status)

    try:
        if not terrain_is_ready(config):
            record_step(
                "Download authoritative NOAA terrain inputs",
                [sys.executable, "model/src/download_topobathy.py", "--config", str(config_path)],
            )
            record_step(
                "Prepare the continuous 5 m NAVD88 computational terrain",
                [sys.executable, "model/src/prepare_terrain.py", "--config", str(config_path)],
            )

        if not args.skip_fetch:
            record_step(
                "Fetch and interpolate the newest PETSS guidance",
                [sys.executable, "model/src/fetch_petss.py", "--config", str(config_path)],
            )

        guidance = read_json(state_directory / "latest_petss.json")
        cycle_id = guidance["cycleId"]
        status["cycleId"] = cycle_id
        atomic_json(status_path, status)

        published_local = state_directory / f"published_{cycle_id}_pointer.json"
        if (
            not args.force
            and not args.no_publish
            and published_local.is_file()
            and remote_pointer_cycle(config) == cycle_id
        ):
            status.update(
                {
                    "status": "skipped-current",
                    "completedUtc": utc_now(),
                    "elapsedSeconds": round(time.monotonic() - pipeline_started, 3),
                    "reason": "This PETSS cycle is already fully published.",
                }
            )
            atomic_json(status_path, status)
            print(f"PETSS cycle {cycle_id} is already live; no work is needed.")
            return

        for scenario in config["petss"]["scenarios"]:
            hydraulic_complete = hydraulic_is_complete(cycle_id, scenario)
            public_complete = public_products_are_complete(cycle_id, scenario)
            if (
                hydraulic_complete
                and not public_complete
                and not hydraulic_state_is_renderable(cycle_id, scenario)
            ):
                hydraulic_complete = False
            if not args.force and hydraulic_complete and public_complete:
                print(f"Reusing complete local {scenario} run for {cycle_id}.")
                continue
            run_command = [
                sys.executable,
                "-u",
                "model/src/run_anuga.py",
                "--config",
                str(config_path),
                "--scenario",
                scenario,
            ]
            render_command = [
                sys.executable,
                "-u",
                "model/src/render_physics.py",
                "--config",
                str(config_path),
                "--scenario",
                scenario,
            ]
            if args.force:
                run_command.append("--force")
                render_command.append("--force")
            elif not hydraulic_complete and (
                ROOT / "model/runs" / cycle_id / scenario
            ).exists():
                run_command.append("--force")
            elif hydraulic_complete and not public_complete:
                render_command.append("--force")
            if args.force or not hydraulic_complete:
                record_step(
                    f"Run the {scenario} nonlinear shallow-water simulation",
                    run_command,
                )
            record_step(
                f"Render the {scenario} 15-minute PNG products",
                render_command,
            )

        record_step(
            "Validate every color/query pair and cellwise daily maximum",
            [
                sys.executable,
                "-u",
                "model/src/validate_products.py",
                "--config",
                str(config_path),
                "--cycle-id",
                cycle_id,
            ],
        )

        if not args.no_publish:
            publish_command = [
                sys.executable,
                "-u",
                "model/src/publish_bunny.py",
                "--config",
                str(config_path),
                "--cycle-id",
                cycle_id,
            ]
            if args.setup_key:
                publish_command.append("--setup-key")
            record_step(
                "Upload, verify, and atomically promote the Bunny cycle",
                publish_command,
            )
            status["discardedPublishedHydraulicStates"] = (
                discard_published_hydraulic_states(
                    cycle_id,
                    list(config["petss"]["scenarios"]),
                )
            )
            deleted = discard_old_local_cycles(cycle_id)
            status["discardedLocalCycles"] = deleted

        status.update(
            {
                "status": "complete-local" if args.no_publish else "complete",
                "completedUtc": utc_now(),
                "elapsedSeconds": round(time.monotonic() - pipeline_started, 3),
            }
        )
        atomic_json(status_path, status)
        print(f"\nCompleted North Wildwood cycle {cycle_id}.")
    except Exception as error:
        status.update(
            {
                "status": "failed",
                "failedUtc": utc_now(),
                "elapsedSeconds": round(time.monotonic() - pipeline_started, 3),
                "error": f"{type(error).__name__}: {error}",
            }
        )
        atomic_json(status_path, status)
        raise


if __name__ == "__main__":
    main()
