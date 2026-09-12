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
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from observation_quality import POLICY_VERSION, municipal_epoch, file_sha256, sample_quality

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
    return municipal_epoch(value)


def calibration_windows(comparison_dir: Path) -> list[tuple[int, int]]:
    """Only use city intervals that have passed the existing comparison review.

    This is a screening gate, not a claim that the other station is local truth.
    Missing/stale comparison coverage does not authorize new city observations.
    """
    path = comparison_dir / "index.json"
    if not path.is_file():
        return []
    windows = []
    for year in load_json(path).get("years", []):
        if year.get("status") != "aligned":
            continue
        points_path = comparison_dir / f"{year['year']}.json"
        if not points_path.is_file():
            continue
        by_day = defaultdict(list)
        for stamp, north, stone in load_json(points_path).get("points", []):
            if all(isinstance(v, (int, float)) and math.isfinite(v) for v in (stamp, north, stone)):
                by_day[int(stamp) // 86400].append((int(stamp), north / 100.0, stone / 100.0))
        for points in by_day.values():
            if len(points) < 48:
                continue
            differences = [north - stone for _, north, stone in points]
            north = [row[1] for row in points]
            stone = [row[2] for row in points]
            try:
                correlation = statistics.correlation(north, stone)
            except statistics.StatisticsError:
                continue  # A flat sensor cannot establish a valid comparison.
            if abs(statistics.median(differences)) > 0.75 or correlation < 0.9:
                continue
            windows.append((min(row[0] for row in points), max(row[0] for row in points)))
    return windows


def load_city_readings(city_dir: Path, allowed_windows: list[tuple[int, int]] | None = None) -> tuple[list[tuple[int, float]], dict[str, int]]:
    """Return clean, deduplicated NAVD88 readings and quality counts."""
    windows = sorted(allowed_windows or [])
    window_starts = [start for start, _ in windows]
    values_by_second: dict[int, list[float]] = defaultdict(list)
    raw_rows = 0
    unusable_rows = 0
    ambiguous_rows = 0
    calibration_excluded_rows = 0
    for path in sorted(city_dir.glob("[0-9][0-9][0-9][0-9].json")):
        payload = load_json(path)
        for row in payload.get("readings", []):
            raw_rows += 1
            try:
                second = timestamp_second(str(row[0]))
                value = float(row[1])
            except (IndexError, TypeError, ValueError) as error:
                if "municipal wall time" in str(error): ambiguous_rows += 1
                unusable_rows += 1
                continue
            if not math.isfinite(value) or not -20 < value < 20:
                unusable_rows += 1
                continue
            window_index = bisect.bisect_right(window_starts, second) - 1
            if allowed_windows is not None and (window_index < 0 or second > windows[window_index][1]):
                calibration_excluded_rows += 1
                continue
            values_by_second[second].append(value)

    averaged_mllw = sorted(
        (second, sum(values) / len(values))
        for second, values in values_by_second.items()
    )
    excluded = set()
    for left in range(len(averaged_mllw) - 2):
        before = averaged_mllw[left]
        first = averaged_mllw[left + 1]
        if abs(first[1] - before[1]) < ISOLATED_SPIKE_THRESHOLD_FT:
            continue
        for right in range(left + 2, min(len(averaged_mllw), left + 12)):
            after = averaged_mllw[right]
            if after[0] - before[0] > MAX_CITY_GAP_SECONDS:
                break
            if abs(after[1] - before[1]) < 0.5:
                interior = averaged_mllw[left+1:right]
                if all(abs(v - before[1]) >= ISOLATED_SPIKE_THRESHOLD_FT and
                       abs(v - after[1]) >= ISOLATED_SPIKE_THRESHOLD_FT for _, v in interior):
                    excluded.update(range(left+1, right))
                break
    isolated_spikes = len(excluded)
    clean_mllw = [row for index, row in enumerate(averaged_mllw) if index not in excluded]

    readings = [
        (second, mllw + NAVD88_OFFSET_FROM_MLLW_FT)
        for second, mllw in clean_mllw
    ]
    return readings, {
        "rawRows": raw_rows,
        "ambiguousTimeRows": ambiguous_rows,
        "calibrationExcludedRows": calibration_excluded_rows,
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
    first_second, last_second = (seconds[0], seconds[-1]) if seconds else (math.inf, -math.inf)
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
        quality_codes = [sample_quality(raw_day, i) if v is not None else "-" for i, v in enumerate(merged_values)]
        sources = ["S" if v is not None else "-" for v in merged_values]
        spans = list(raw_day.get("g", [None] * len(merged_values)))
        city_count = 0
        fallback_count = 0
        for index, stone_value in enumerate(merged_values):
            anchor = int(raw_day["u"]) + index * QUARTER_SECONDS
            city_value = None
            if first_second <= anchor <= last_second:
                city_value = interpolate_city(anchor, seconds, values)
            if city_value is not None:
                merged_values[index] = int(round(city_value * 100))
                position = bisect.bisect_left(seconds, anchor)
                exact = position < len(seconds) and seconds[position] == anchor
                quality_codes[index] = "M" if exact else "I"
                spans[index] = 0 if exact else seconds[position] - seconds[position-1]
                sources[index] = "N"
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
        day["q"] = "".join(quality_codes)
        day["s"] = "".join(sources)
        day["g"] = spans
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
    # A source backfill must also refresh the pre-city companion archive.
    # Retaining legacy hourly days here would bypass the new sampling policy.
    day_map = {}
    for day in merged_days:
        hourly = hourly_day_from_compact(day)
        if hourly is not None:
            day_map[day["d"]] = hourly
    return [day_map[key] for key in sorted(day_map)]


def iso_timestamp(second: int) -> str:
    return datetime.fromtimestamp(second, timezone.utc).isoformat().replace("+00:00", "Z")


def build(args: argparse.Namespace) -> dict[str, Any]:
    stone = load_json(args.stone_archive)
    existing_hourly = load_json(args.hourly_output) if args.hourly_output.exists() else {}
    comparison_dir = getattr(args, "comparison_dir", Path("city-gauge/comparison"))
    windows = calibration_windows(comparison_dir)
    city, city_quality = load_city_readings(args.city_dir, windows)

    merged_days, merge_quality = merge_compact_days(stone, city)
    merge_quality["validQuarterHours"] = (
        merge_quality["totalQuarterHours"] - merge_quality["unavailableQuarterHours"]
    )
    first_second, last_second = (city[0][0], city[-1][0]) if city else (int(stone["days"][0]["u"]), int(stone["days"][-1]["u"]))
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    coverage = {
        "firstTimestamp": iso_timestamp(first_second) if city else None,
        "lastTimestamp": iso_timestamp(last_second) if city else None,
    }
    compact = {
        "schema": "north-wildwood-composite-observed-15min-v2",
        "qualityPolicyVersion": POLICY_VERSION,
        "sourceHashes": {"stoneArchive": file_sha256(args.stone_archive),
                         "cityYears": {p.name: file_sha256(p) for p in sorted(args.city_dir.glob("[0-9][0-9][0-9][0-9].json"))},
                         "comparisonIndex": file_sha256(comparison_dir / "index.json") if (comparison_dir / "index.json").exists() else None,
                         "comparisonYears": {p.name: file_sha256(p) for p in sorted(comparison_dir.glob("[0-9][0-9][0-9][0-9].json"))},
                         "qualityCode": {name: file_sha256(Path(__file__).with_name(name)) for name in ["observation_quality.py", "merge_north_wildwood_city_gauge.py", "update_observed_15min.py"]}},
        "qualityPolicy": {"cityEligibility": "year and UTC-day comparison gates: >=48 paired quarters/day, absolute median difference <=0.75 ft, correlation >=0.9; ambiguous/unreviewed intervals excluded",
                          "fallback": "Stone Harbor station observations; no unreviewed local bias correction is applied",
                          "rawMunicipalArchive": "city-gauge/data; preserved unchanged"},
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
            "North Wildwood municipal sensor 1005 within comparison-aligned coverage where a usable 30-minute interpolation bracket exists",
            "Stone Harbor USGS 01411360 before city coverage and during city-gauge gaps",
        ],
        "cityGaugeCoverage": coverage,
        "method": "North Wildwood municipal MLLW readings converted by -2.75 ft to NAVD88 and interpolated to exact UTC 15-minute anchors across gaps up to 30 minutes; Stone Harbor supplies remaining anchors; calibration-flagged/unreviewed city intervals and ambiguous wall times are excluded; per-sample quality and station are retained",
        "encoding": {
            "d": "America/New_York civil date",
            "u": "UTC epoch second of first quarter-hour anchor",
            "v": "NAVD88 feet multiplied by 100; null means both gauges are unavailable; subsequent entries are 900 seconds apart",
            "p": "daily maximum NAVD88 feet multiplied by 100",
            "c": "daily flood classification",
            "n": "quarter-hour anchors supplied by the North Wildwood city gauge",
            "f": "Stone Harbor fallback anchors inside usable city-gauge coverage",
            "q": "per sample: M measured, I interpolated <=30 minutes, C calibrated replay, U unknown legacy provenance, - missing",
            "s": "per sample: N North Wildwood city, S Stone Harbor, - unavailable",
            "g": "per-sample interpolation bracket in seconds; 0 measured; null unknown/unavailable",
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
    parser.add_argument("--comparison-dir", type=Path, default=Path("city-gauge/comparison"))
    parser.add_argument("--city-dir", type=Path, default=Path("city-gauge/data"))
    parser.add_argument("--output", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--hourly-output", type=Path, default=Path("observed.json"))
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
