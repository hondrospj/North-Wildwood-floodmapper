#!/usr/bin/env python3
"""Install the local North Wildwood physics pipeline as a macOS LaunchAgent."""

from __future__ import annotations

import argparse
import os
import plistlib
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LABEL = "com.shorelysafe.north-wildwood-physics"
AWAKE_LABEL = "com.shorelysafe.north-wildwood-awake-on-ac"


def install_agent(
    destination: Path,
    definition: dict,
    domain: str,
) -> None:
    temporary = destination.with_suffix(".plist.incomplete")
    with temporary.open("wb") as stream:
        plistlib.dump(definition, stream, sort_keys=True)
    os.replace(temporary, destination)
    subprocess.run(
        ["/bin/launchctl", "bootout", domain, str(destination)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["/bin/launchctl", "bootstrap", domain, str(destination)],
        check=True,
    )
    subprocess.run(
        ["/bin/launchctl", "enable", f"{domain}/{definition['Label']}"],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval-seconds", type=int, default=1800)
    parser.add_argument(
        "--python",
        type=Path,
        default=ROOT / ".anuga-env/bin/python",
        help="ANUGA environment interpreter (defaults to .anuga-env/bin/python)",
    )
    parser.add_argument(
        "--allow-idle-sleep",
        action="store_true",
        help="Do not install the AC-only awake assertion (scheduled runs may wait for wake)",
    )
    args = parser.parse_args()

    python = args.python.expanduser().resolve()
    pipeline = ROOT / "model/src/run_pipeline.py"
    if not python.is_file():
        raise FileNotFoundError(f"Missing ANUGA environment Python: {python}")
    if not pipeline.is_file():
        raise FileNotFoundError(pipeline)

    logs = ROOT / "model/logs"
    logs.mkdir(parents=True, exist_ok=True)
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    destination = agents / f"{LABEL}.plist"
    definition = {
        "Label": LABEL,
        "ProgramArguments": [
            "/usr/bin/caffeinate",
            "-is",
            str(python),
            "-u",
            str(pipeline),
        ],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "StartInterval": max(900, int(args.interval_seconds)),
        "ProcessType": "Background",
        "LowPriorityIO": True,
        "ThrottleInterval": 120,
        "StandardOutPath": str(logs / "launchd.stdout.log"),
        "StandardErrorPath": str(logs / "launchd.stderr.log"),
        "EnvironmentVariables": {
            "PYTHONUNBUFFERED": "1",
            "OMP_NUM_THREADS": "8",
        },
    }
    domain = f"gui/{os.getuid()}"
    install_agent(destination, definition, domain)
    print(f"Installed and started {LABEL}")
    print(destination)

    if not args.allow_idle_sleep:
        awake_destination = agents / f"{AWAKE_LABEL}.plist"
        awake_definition = {
            "Label": AWAKE_LABEL,
            "ProgramArguments": ["/usr/bin/caffeinate", "-s"],
            "RunAtLoad": True,
            "KeepAlive": True,
            "ProcessType": "Background",
            "ThrottleInterval": 120,
        }
        install_agent(awake_destination, awake_definition, domain)
        print(f"Installed {AWAKE_LABEL} (prevents idle sleep only on AC power)")
        print(awake_destination)


if __name__ == "__main__":
    main()
