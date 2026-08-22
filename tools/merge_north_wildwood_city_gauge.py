#!/usr/bin/env python3
"""Make the North Wildwood city gauge primary in the public observed archive.

The municipal archive is recorded in MLLW at irregular, usually three-minute
spacing. This tool deduplicates and quality-controls those readings, converts
them to NAVD88, and interpolates only across gaps of 30 minutes or less. City
values replace Stone Harbor on exact UTC quarter-hour anchors wherever they are
available. The untouched Stone Harbor compact archive remains the fallback
before city coverage begins and during genuine municipal-gauge outages.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from update_observed_15min import (
    LOCAL_ZONE,
    NAVD88_OFFSET_FROM_MLLW_FT,
    QUARTER_SECONDS,
    THRESHOLDS_MLLW,
    THRESHOLDS_NAVD88,
    classify_peak,
    ensure_hourly_phases,
)


CITY_SENSOR_ID = "1005"
STONE_SITE_ID = "01411360"
MAX_CITY_GAP_SECONDS = 30 * 60
ISOLATED_SPIKE_THRESHOLD_FT = 3.0


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def timestamp_second(value: str) -> int:
    # The municipal endpoint emits North Wildwood wall time without an offset.
    # fold=0 matches the comparison builder's choice of the DST occurrence when
    # fall-back repeats the 1 a.m. hour.
    parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=LOCAL_ZONE, fold=0)
    return int(parsed.astimezone(timezone.utc).timestamp())


def load_city_readings(city_dir: Path) -> tuple[list[tuple[int, float]], dict[str, int]]:
    """Return clean, deduplicated NAVD88 readings and quality counts."""
    values_by_second: dict[int, list[float]] = defaultdict(list)
    raw_rows = 0
    unusable_rows = 0
    for path in sorted(city_dir.glob("[0-9][0-9][0-9][0-9].json")):
        payload = load_json(path)
        for row in payload.get("readings", []):
            raw_rows += 1
            try:
                second = timestamp_second(str(row[0]))
                value = float(row[1])
            except (IndexError, TypeError, ValueError):
                unusable_rows += 1
                continue
            if not math.isfinite(value) or not -20 < value < 20:
                unusable_rows += 1
                continue
            values_by_second[second].append(value)

    averaged_mllw = sorted(
        (second, sum(values) / len(values))
        for second, values in values_by_second.items()
    )
    clean_mllw: list[tuple[int, float]] = []
    isolated_spikes = 0
    for index, current in enumerate(averaged_mllw):
        if index == 0 or index + 1 == len(averaged_mllw):
            clean_mllw.append(current)
            continue
        previous = averaged_mllw[index - 1]
        following = averaged_mllw[index + 1]
        if (
            current[0] - previous[0] <= MAX_CITY_GAP_SECONDS
            and following[0] - current[0] <= MAX_CITY_GAP_SECONDS
            and (
                (
                    current[1] - previous[1] >= ISOLATED_SPIKE_THRESHOLD_FT
                    and current[1] - following[1] >= ISOLATED_SPIKE_THRESHOLD_FT
                )
                or (
                    current[1] - previous[1] <= -ISOLATED_SPIKE_THRESHOLD_FT
                    and current[1] - following[1] <= -ISOLATED_SPIKE_THRESHOLD_FT
                )
            )
        ):
            isolated_spikes += 1
            continue
        clean_mllw.append(current)

    readings = [
        (second, mllw + NAVD88_OFFSET_FROM_MLLW_FT)
        for second, mllw in clean_mllw
    ]
    return readings, {
        "rawRows": raw_rows,
        "unusableRows": unusable_rows,
        "duplicateRows": sum(max(0, len(values) - 1) for values in values_by_second.values()),
        "isolatedSpikes": isolated_spikes,
        "cleanReadings": len(readings),
    }


def interpolate_city(
    anchor: int,
    seconds: list[int],
    values: list[float],
) -> float | None:
    index = bisect.bisect_left(seconds, anchor)
    if index < len(seconds) and seconds[index] == anchor:
        return values[index]
    if index == 0 or index >= len(seconds):
        return None
    before_second, after_second = seconds[index - 1], seconds[index]
    if after_second - before_second > MAX_CITY_GAP_SECONDS:
        return None
    ratio = (anchor - before_second) / (after_second - before_second)
    return values[index - 1] + (values[index] - values[index - 1]) * ratio


def merge_compact_days(
    stone: dict[str, Any],
    city: list[tuple[int, float]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    seconds = [row[0] for row in city]
    values = [row[1] for row in city]
    first_second, last_second = seconds[0], seconds[-1]
    counts = {
        "cityQuarterHours": 0,
        "stoneFallbackQuarterHoursWithinCityCoverage": 0,
        "stoneQuarterHoursOutsideCityCoverage": 0,
        "unavailableQuarterHours": 0,
        "totalQuarterHours": 0,
    }
    merged_days: list[dict[str, Any]] = []
    for raw_day in stone.get("days", []):
        day = dict(raw_day)
        day.pop("n", None)
        day.pop("f", None)
        merged_values = list(raw_day.get("v", []))
        city_count = 0
        fallback_count = 0
        for index, stone_value in enumerate(merged_values):
            anchor = int(raw_day["u"]) + index * QUARTER_SECONDS
            city_value = None
            if first_second <= anchor <= last_second:
                city_value = interpolate_city(anchor, seconds, values)
            if city_value is not None:
                merged_values[index] = int(round(city_value * 100))
                city_count += 1
                counts["cityQuarterHours"] += 1
            elif stone_value is not None:
                if first_second <= anchor <= last_second:
                    fallback_count += 1
                    counts["stoneFallbackQuarterHoursWithinCityCoverage"] += 1
                else:
                    counts["stoneQuarterHoursOutsideCityCoverage"] += 1
            else:
                counts["unavailableQuarterHours"] += 1
            counts["totalQuarterHours"] += 1

        finite = [value for value in merged_values if value is not None]
        peak = max(finite) if finite else None
        day["v"] = merged_values
        day["p"] = peak
        day["c"] = classify_peak(peak / 100 if peak is not None else None)
        if city_count or fallback_count:
            day["n"] = city_count
            day["f"] = fallback_count
        merged_days.append(day)
    return merged_days, counts


def hourly_day_from_compact(day: dict[str, Any]) -> dict[str, Any] | None:
    buckets: dict[tuple[int, int], tuple[int, int]] = {}
    for index, value in enumerate(day.get("v", [])):
        if value is None:
            continue
        stamp = int(day["u"]) + index * QUARTER_SECONDS
        local = datetime.fromtimestamp(stamp, timezone.utc).astimezone(LOCAL_ZONE)
        key = (local.hour, int(local.utcoffset().total_seconds()))
        previous = buckets.get(key)
        if previous is None or value > previous[1]:
            buckets[key] = (stamp, value)
    if not buckets:
        return None

    hours = []
    for (hour, _offset), (stamp, hundredths) in sorted(buckets.items(), key=lambda item: item[1][0]):
        utc_dt = datetime.fromtimestamp(stamp, timezone.utc).replace(minute=0, second=0, microsecond=0)
        local_dt = utc_dt.astimezone(LOCAL_ZONE)
        navd = hundredths / 100
        hours.append(
            {
                "hourIndex": hour,
                "timeUtc": utc_dt.isoformat().replace("+00:00", "Z"),
                "timeLocal": local_dt.strftime("%Y-%m-%dT%H:00"),
                "timeEST": local_dt.strftime("%Y-%m-%dT%H:00"),
                "displayTimeEST": local_dt.strftime("%Y-%m-%dT%H:00"),
                "navd88StageFt": navd,
                "mllwStageFt": round(navd - NAVD88_OFFSET_FROM_MLLW_FT, 2),
            }
        )
    peak = max(row["navd88StageFt"] for row in hours)
    result = {
        "date": day["d"],
        "classification": classify_peak(peak),
        "peakNAVD88": peak,
        "peakMLLW": round(peak - NAVD88_OFFSET_FROM_MLLW_FT, 2),
        "hours": hours,
    }
    ensure_hourly_phases(result)
    return result


def rebuild_hourly(
    existing: dict[str, Any],
    merged_days: list[dict[str, Any]],
    first_city_second: int,
) -> list[dict[str, Any]]:
    first_city_date = datetime.fromtimestamp(first_city_second, timezone.utc).astimezone(LOCAL_ZONE).date().isoformat()
    day_map = {
        str(day.get("date")): day
        for day in existing.get("days", [])
        if day.get("date") and str(day["date"]) < first_city_date
    }
    for day in merged_days:
        if day["d"] < first_city_date:
            continue
        hourly = hourly_day_from_compact(day)
        if hourly is not None:
            day_map[day["d"]] = hourly
    return [day_map[key] for key in sorted(day_map)]


def iso_timestamp(second: int) -> str:
    return datetime.fromtimestamp(second, timezone.utc).isoformat().replace("+00:00", "Z")


def build(args: argparse.Namespace) -> dict[str, Any]:
    stone = load_json(args.stone_archive)
    existing_hourly = load_json(args.hourly_output) if args.hourly_output.exists() else {}
    city, city_quality = load_city_readings(args.city_dir)
    if not city:
        raise RuntimeError(f"No usable North Wildwood city-gauge readings in {args.city_dir}")

    merged_days, merge_quality = merge_compact_days(stone, city)
    merge_quality["validQuarterHours"] = (
        merge_quality["totalQuarterHours"] - merge_quality["unavailableQuarterHours"]
    )
    first_second, last_second = city[0][0], city[-1][0]
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    coverage = {
        "firstTimestamp": iso_timestamp(first_second),
        "lastTimestamp": iso_timestamp(last_second),
    }
    compact = {
        "schema": "north-wildwood-composite-observed-15min-v2",
        "gaugeName": "North Wildwood City Gauge (Stone Harbor fallback)",
        "site": CITY_SENSOR_ID,
        "fallbackSite": STONE_SITE_ID,
        "parameterCd": stone.get("parameterCd", "72279"),
        "datum": "NAVD88",
        "timeZone": stone.get("timeZone", "America/New_York"),
        "intervalMinutes": 15,
        "sourceResolutionMinutes": 3,
        "sourceResolutionMinutesByGauge": {"northWildwoodCity": 3, "stoneHarbor": 6},
        "sourcePriority": [
            "North Wildwood municipal sensor 1005 where a usable 30-minute interpolation bracket exists",
            "Stone Harbor USGS 01411360 before city coverage and during city-gauge gaps",
        ],
        "cityGaugeCoverage": coverage,
        "method": "North Wildwood municipal MLLW readings converted by -2.75 ft to NAVD88 and interpolated to exact UTC 15-minute anchors across gaps up to 30 minutes; Stone Harbor supplies all remaining anchors",
        "encoding": {
            "d": "America/New_York civil date",
            "u": "UTC epoch second of first quarter-hour anchor",
            "v": "NAVD88 feet multiplied by 100; null means both gauges are unavailable; subsequent entries are 900 seconds apart",
            "p": "daily maximum NAVD88 feet multiplied by 100",
            "c": "daily flood classification",
            "n": "quarter-hour anchors supplied by the North Wildwood city gauge",
            "f": "Stone Harbor fallback anchors inside city-gauge coverage",
        },
        "archiveStartDate": merged_days[0]["d"] if merged_days else stone.get("archiveStartDate"),
        "archiveEndDate": merged_days[-1]["d"] if merged_days else stone.get("archiveEndDate"),
        "lastProcessedISO": now,
        "navd88OffsetFromMllwFt": NAVD88_OFFSET_FROM_MLLW_FT,
        "thresholdsNAVD88": THRESHOLDS_NAVD88,
        "thresholdsMLLW": THRESHOLDS_MLLW,
        "jonasCalibration": stone.get("jonasCalibration"),
        "quality": {**city_quality, **merge_quality},
        "days": merged_days,
    }
    args.output.write_text(json.dumps(compact, separators=(",", ":")) + "\n", encoding="utf-8")

    hourly_days = rebuild_hourly(existing_hourly, merged_days, first_second)
    hourly = dict(existing_hourly)
    hourly.update(
        {
            "schema": "north-wildwood-composite-gauge-hourly-v2",
            "gaugeName": compact["gaugeName"],
            "site": CITY_SENSOR_ID,
            "fallbackSite": STONE_SITE_ID,
            "parameterCd": compact["parameterCd"],
            "datum": "NAVD88",
            "timeZone": compact["timeZone"],
            "method": "Hourly maxima derived from the city-primary composite 15-minute archive; Stone Harbor supplies missing city anchors",
            "sourceType": "North_Wildwood_city_primary_Stone_Harbor_fallback",
            "sourcePriority": compact["sourcePriority"],
            "cityGaugeCoverage": coverage,
            "archiveStartDate": hourly_days[0]["date"] if hourly_days else compact["archiveStartDate"],
            "archiveEndDate": hourly_days[-1]["date"] if hourly_days else compact["archiveEndDate"],
            "lastProcessedISO": now,
            "lastIncrementalUpdateISO": now,
            "navd88OffsetFromMllwFt": NAVD88_OFFSET_FROM_MLLW_FT,
            "thresholdsNAVD88": THRESHOLDS_NAVD88,
            "thresholdsMLLW": THRESHOLDS_MLLW,
            "days": hourly_days,
        }
    )
    args.hourly_output.write_text(json.dumps(hourly, indent=2) + "\n", encoding="utf-8")
    return {
        "archiveStartDate": compact["archiveStartDate"],
        "archiveEndDate": compact["archiveEndDate"],
        "cityGaugeCoverage": coverage,
        "quality": compact["quality"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stone-archive", type=Path, default=Path("stone_harbor_observed15min.json"))
    parser.add_argument("--city-dir", type=Path, default=Path("city-gauge/data"))
    parser.add_argument("--output", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--hourly-output", type=Path, default=Path("observed.json"))
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
