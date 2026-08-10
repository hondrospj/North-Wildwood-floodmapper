#!/usr/bin/env python3
"""Fetch the newest usable PETSS station guidance and build 15-minute curves."""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
from scipy.interpolate import PchipInterpolator


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
USER_AGENT = "North-Wildwood-Floodmapper-ANUGA/1.0"
FEET_TO_METRES = 0.3048
HEADER_ALIASES = {
    "time": [
        "time",
        "valid",
        "validtime",
        "valid_time",
        "datetime",
        "date_time",
        "forecast_time",
        "src_time",
        "srctime",
    ],
    "twl": [
        "twl",
        "twl_ft",
        "twl_mllw",
        "twl_mllw_ft",
        "stormtide",
        "storm_tide",
        "total_water_level",
        "water_level",
    ],
    "twl10": [
        "twl10p",
        "twl_10p",
        "twl10",
        "twl_p10",
        "p10_twl",
        "twl_e10",
        "e10_twl",
    ],
    "twl90": [
        "twl90p",
        "twl_90p",
        "twl90",
        "twl_p90",
        "p90_twl",
        "twl_e90",
        "e90_twl",
    ],
}
SCENARIO_COLUMNS = {
    "mean": "twl",
    "lowEnd": "twl90",
    "highEnd": "twl10",
}


def utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_header(value: str) -> str:
    return re.sub(
        r"[^a-z0-9_]",
        "",
        str(value or "").strip().lower().replace(" ", ""),
    )


def find_column(headers: list[str], logical_name: str) -> int:
    normalized = [normalize_header(header) for header in headers]
    for alias in HEADER_ALIASES[logical_name]:
        if alias in normalized:
            return normalized.index(alias)
    raise RuntimeError(f"Missing PETSS {logical_name} column in headers: {headers}")


def parse_time(value: str) -> datetime | None:
    raw = str(value or "").strip()
    try:
        if re.fullmatch(r"\d{10}", raw):
            return datetime.strptime(raw, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        if re.fullmatch(r"\d{12}", raw):
            return datetime.strptime(raw, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        text = raw if raw.endswith("Z") or "+" in raw[-6:] else raw + "Z"
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except (ValueError, TypeError):
        return None


def clean_level(value: str) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or abs(number) >= 9000 or not -50.0 < number < 50.0:
        return None
    return number


def recent_cycles(
    now: datetime,
    hours: list[int],
    days_back: int,
) -> list[datetime]:
    result: list[datetime] = []
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    for day_offset in range(days_back + 1):
        day = today - timedelta(days=day_offset)
        for hour in sorted(hours, reverse=True):
            cycle = day.replace(hour=hour)
            if cycle <= now + timedelta(minutes=30):
                result.append(cycle)
    return result


def source_url(cycle: datetime) -> str:
    return (
        "https://nomads.ncep.noaa.gov/pub/data/nccf/com/petss/prod/"
        f"petss.{cycle:%Y%m%d}/petss.t{cycle:%H}z.csv.tar.gz"
    )


def fetch_station_csv(url: str, station_id: str) -> tuple[str, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=240) as response:
        payload = response.read()
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        pattern = re.compile(rf"(^|/){re.escape(station_id)}\.csv$", re.I)
        member = next(
            (
                candidate
                for candidate in archive.getmembers()
                if candidate.isfile() and pattern.search(candidate.name)
            ),
            None,
        )
        if member is None:
            raise RuntimeError(f"{station_id}.csv is absent from {url}")
        stream = archive.extractfile(member)
        if stream is None:
            raise RuntimeError(f"Could not extract {member.name}")
        return stream.read().decode("utf-8", errors="replace"), member.name


def parse_hourly(
    text: str,
    requested_scenarios: list[str],
) -> dict[str, list[tuple[datetime, float]]]:
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        raise RuntimeError("PETSS station CSV is empty")
    headers = rows[0]
    time_index = find_column(headers, "time")
    scenario_indices = {
        scenario: find_column(headers, SCENARIO_COLUMNS[scenario])
        for scenario in requested_scenarios
    }
    parsed = {scenario: [] for scenario in requested_scenarios}
    for row in rows[1:]:
        if len(row) <= max([time_index, *scenario_indices.values()]):
            continue
        valid_time = parse_time(row[time_index])
        if valid_time is None:
            continue
        for scenario, index in scenario_indices.items():
            level = clean_level(row[index])
            if level is not None:
                parsed[scenario].append((valid_time, level))
    for scenario, values in parsed.items():
        values.sort(key=lambda item: item[0])
        if len(values) < 12:
            raise RuntimeError(
                f"Only {len(values)} usable PETSS values for {scenario}"
            )
    return parsed


def common_hourly_window(
    parsed: dict[str, list[tuple[datetime, float]]],
    start: datetime,
    hours: int,
) -> dict[str, list[tuple[datetime, float]]]:
    by_scenario = {
        scenario: {timestamp: level for timestamp, level in values}
        for scenario, values in parsed.items()
    }
    common_times = sorted(
        set.intersection(*(set(values) for values in by_scenario.values()))
    )
    if not common_times:
        raise RuntimeError("PETSS scenarios have no common valid timestamps")
    eligible = [timestamp for timestamp in common_times if timestamp >= start]
    if not eligible:
        raise RuntimeError(f"PETSS guidance has no values at or after {utc_iso(start)}")
    first_time = eligible[0]
    window_end = first_time + timedelta(hours=hours)
    times = [timestamp for timestamp in eligible if timestamp <= window_end]
    if len(times) < hours + 1:
        raise RuntimeError(
            f"PETSS guidance contains {len(times)} common hourly points; "
            f"{hours + 1} are required"
        )
    times = times[: hours + 1]
    return {
        scenario: [(timestamp, by_scenario[scenario][timestamp]) for timestamp in times]
        for scenario in by_scenario
    }


def interpolate_15_minutes(
    hourly: list[tuple[datetime, float]],
    navd88_offset_ft: float,
) -> list[dict[str, Any]]:
    origin = hourly[0][0]
    source_seconds = np.array(
        [(timestamp - origin).total_seconds() for timestamp, _ in hourly],
        dtype=np.float64,
    )
    source_levels = np.array([level for _, level in hourly], dtype=np.float64)
    end_seconds = int(source_seconds[-1])
    target_seconds = np.arange(0, end_seconds + 1, 900, dtype=np.int64)
    interpolator = PchipInterpolator(source_seconds, source_levels, extrapolate=False)
    target_mllw_ft = interpolator(target_seconds)
    result: list[dict[str, Any]] = []
    for index, (seconds, mllw_ft) in enumerate(zip(target_seconds, target_mllw_ft)):
        timestamp = origin + timedelta(seconds=int(seconds))
        navd88_ft = float(mllw_ft) + navd88_offset_ft
        result.append(
            {
                "frameIndex": index,
                "secondsFromModelStart": int(seconds),
                "timeUtc": utc_iso(timestamp),
                "mllwFt": round(float(mllw_ft), 4),
                "navd88Ft": round(navd88_ft, 4),
                "navd88M": round(navd88_ft * FEET_TO_METRES, 6),
                "isHourlySourcePoint": int(seconds) % 3600 == 0,
            }
        )
    return result


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--now", help="UTC ISO timestamp used for reproducible tests")
    args = parser.parse_args()

    config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
    petss = config["petss"]
    if args.now:
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    else:
        now = datetime.now(timezone.utc)
    scenarios = list(petss["scenarios"])
    station_id = str(petss["stationId"])
    latest_path = ROOT / "model/state/latest_petss.json"
    previous: dict[str, Any] | None = None
    previous_cycle: datetime | None = None
    if latest_path.is_file():
        try:
            previous = json.loads(latest_path.read_text(encoding="utf-8"))
            previous_cycle = datetime.fromisoformat(
                previous["petssCycleUtc"].replace("Z", "+00:00")
            ).astimezone(timezone.utc)
        except Exception:
            previous = None
            previous_cycle = None

    error_messages: list[str] = []
    selected: tuple[datetime, str, str, str, dict[str, list[tuple[datetime, float]]]] | None = None
    candidate_cycles = recent_cycles(
        now,
        list(petss["cyclesUtc"]),
        int(petss["daysBackToTry"]),
    )
    if previous_cycle is not None:
        candidate_cycles = [
            cycle for cycle in candidate_cycles if cycle > previous_cycle
        ]
        if not candidate_cycles:
            print(
                f"PETSS cycle {previous['cycleId']} remains current; "
                "no newer scheduled cycle is eligible yet."
            )
            return
    for cycle in candidate_cycles:
        url = source_url(cycle)
        try:
            print(f"Trying PETSS cycle {utc_iso(cycle)}")
            text, member = fetch_station_csv(url, station_id)
            parsed = parse_hourly(text, scenarios)
            hourly = common_hourly_window(
                parsed,
                cycle,
                int(petss["forecastHours"]),
            )
            selected = (cycle, url, member, text, hourly)
            break
        except Exception as error:
            message = f"{utc_iso(cycle)}: {error}"
            error_messages.append(message)
            print(f"Rejected {message}")
    if selected is None:
        if previous is not None:
            print(
                f"No newer complete PETSS release is usable; retaining "
                f"{previous['cycleId']}."
            )
            for message in error_messages:
                print(f"  {message}")
            return
        raise RuntimeError(
            "No usable recent PETSS cycle was found:\n" + "\n".join(error_messages)
        )

    cycle, url, member, raw_text, hourly = selected
    curves = {
        scenario: interpolate_15_minutes(
            values,
            float(petss["navd88OffsetFromMllwFt"]),
        )
        for scenario, values in hourly.items()
    }
    cycle_id = cycle.strftime("%Y%m%dT%H00Z")
    first_scenario = scenarios[0]
    result = {
        "schema": "north-wildwood-petss-15min-v1",
        "modelId": config["modelId"],
        "stationId": station_id,
        "stationName": petss["stationName"],
        "petssCycleUtc": utc_iso(cycle),
        "cycleId": cycle_id,
        "fetchedUtc": utc_iso(now),
        "sourceUrl": url,
        "sourceMember": member,
        "sourceDatum": petss["sourceDatum"],
        "mapDatum": config["verticalDatum"],
        "navd88OffsetFromMllwFt": petss["navd88OffsetFromMllwFt"],
        "interpolation": {
            "method": "PCHIP monotonic cubic interpolation",
            "sourceIntervalSeconds": 3600,
            "outputIntervalSeconds": petss["outputIntervalSeconds"],
            "hourlySourcePointsPreservedExactly": True,
        },
        "forecastStartUtc": curves[first_scenario][0]["timeUtc"],
        "forecastEndUtc": curves[first_scenario][-1]["timeUtc"],
        "frameCount": len(curves[first_scenario]),
        "scenarios": curves,
    }
    state_directory = ROOT / "model/state"
    cycle_path = state_directory / f"petss_{cycle_id}.json"
    atomic_write_json(cycle_path, result)
    atomic_write_json(state_directory / "latest_petss.json", result)
    raw_path = state_directory / f"petss_{cycle_id}_{station_id}.csv"
    raw_path.write_text(raw_text, encoding="utf-8")
    print(f"Selected PETSS cycle {cycle_id}")
    print(
        f"Built {result['frameCount']} 15-minute frames from "
        f"{result['forecastStartUtc']} through {result['forecastEndUtc']}"
    )
    print(f"Wrote {cycle_path}")


if __name__ == "__main__":
    main()
