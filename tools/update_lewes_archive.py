#!/usr/bin/env python3
"""Build the pre-Stone-Harbor observed archive from NOAA Lewes water levels.

Stone Harbor's continuous USGS record begins on 2007-10-01.  This archive uses
NOAA station 8557380 (Lewes, Delaware) only before that cutoff.  Verified hourly
heights are the primary source.  Where an hourly anchor is missing and verified
six-minute data exist, the closest six-minute observation within 30 minutes is
used.  NOAA periods with neither product remain unavailable.

Values are requested directly in feet relative to NAVD88 and compacted by
America/New_York civil day.  Each day stores the first UTC epoch hour and a
23/24/25-element array of hundredths of a foot, so daylight-saving transitions
remain unambiguous without repeating timestamps.
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


STATION_ID = "8557380"
STATION_NAME = "Lewes, Delaware"
LOCAL_TIME_ZONE = "America/New_York"
LOCAL_ZONE = ZoneInfo(LOCAL_TIME_ZONE)
ARCHIVE_START_DATE = date(1919, 2, 1)
STONE_HARBOR_CUTOFF_DATE = date(2007, 10, 1)
SIX_MINUTE_START_DATE = date(1996, 1, 1)
THRESHOLDS_NAVD88 = {"minorLow": 3.25, "moderateLow": 4.25, "majorLow": 5.25}
THRESHOLDS_MLLW = {"minorLow": 6.00, "moderateLow": 7.00, "majorLow": 8.00}
API_ENDPOINT = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
APPLICATION = "North_Wildwood_Floodmapper_2"
HOUR_SECONDS = 60 * 60
MAX_SIX_MINUTE_DISTANCE_SECONDS = 30 * 60


def fetch_json(url: str, attempts: int = 5) -> dict:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "North-Wildwood-floodmapper-2.0/1.0"},
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read()
            if not body:
                raise RuntimeError(f"Empty NOAA response for {url}")
            payload = json.loads(body.decode("utf-8"))
            error = payload.get("error", {}).get("message")
            if error and "No data was found" not in str(error):
                raise RuntimeError(str(error))
            return payload
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(min(12, 2**attempt))
    raise RuntimeError(f"NOAA request failed after {attempts} attempts: {last_error}")


def api_url(product: str, begin_date: date, end_date: date) -> str:
    params = {
        "begin_date": begin_date.strftime("%Y%m%d"),
        "end_date": end_date.strftime("%Y%m%d"),
        "station": STATION_ID,
        "product": product,
        "datum": "NAVD",
        "time_zone": "gmt",
        "units": "english",
        "application": APPLICATION,
        "format": "json",
    }
    return API_ENDPOINT + "?" + urllib.parse.urlencode(params)


def cache_path(cache_dir: Path, product: str, begin_date: date, end_date: date) -> Path:
    return cache_dir / f"{product}-{begin_date:%Y%m%d}-{end_date:%Y%m%d}.json"


def fetch_product(
    product: str,
    begin_date: date,
    end_date: date,
    cache_dir: Path,
    pause_seconds: float,
) -> dict:
    path = cache_path(cache_dir, product, begin_date, end_date)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            path.unlink(missing_ok=True)
    payload = fetch_json(api_url(product, begin_date, end_date))
    cache_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    if pause_seconds > 0:
        time.sleep(pause_seconds)
    return payload


def parse_utc_stamp(value: object) -> int | None:
    raw = str(value or "").strip()
    try:
        return int(datetime.strptime(raw, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def parse_level(value: object) -> float | None:
    try:
        level = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(level) or level < -30 or level > 30:
        return None
    return level


def iter_year_chunks(start_date: date, end_date: date):
    year = start_date.year
    while year <= end_date.year:
        chunk_start = max(start_date, date(year, 1, 1))
        chunk_end = min(end_date, date(year, 12, 31))
        yield chunk_start, chunk_end
        year += 1


def month_start(value: date) -> date:
    return value.replace(day=1)


def next_month(value: date) -> date:
    return date(value.year + (value.month == 12), 1 if value.month == 12 else value.month + 1, 1)


def iter_month_chunks(start_date: date, end_date: date):
    cursor = month_start(start_date)
    while cursor <= end_date:
        chunk_start = max(start_date, cursor)
        chunk_end = min(end_date, next_month(cursor) - timedelta(days=1))
        yield chunk_start, chunk_end
        cursor = next_month(cursor)


def day_utc_bounds(day: date) -> tuple[int, int]:
    start_local = datetime.combine(day, datetime_time.min, tzinfo=LOCAL_ZONE)
    end_local = datetime.combine(day + timedelta(days=1), datetime_time.min, tzinfo=LOCAL_ZONE)
    return int(start_local.astimezone(timezone.utc).timestamp()), int(end_local.astimezone(timezone.utc).timestamp())


def classify_peak(peak: float | None) -> str:
    if peak is None or not math.isfinite(peak):
        return "none"
    if peak >= THRESHOLDS_NAVD88["majorLow"]:
        return "major"
    if peak >= THRESHOLDS_NAVD88["moderateLow"]:
        return "moderate"
    if peak >= THRESHOLDS_NAVD88["minorLow"]:
        return "minor"
    return "none"


def expected_hour_range(start_date: date, end_date: date) -> range:
    start_second, _ = day_utc_bounds(start_date)
    _, end_second = day_utc_bounds(end_date)
    return range(start_second, end_second, HOUR_SECONDS)


def load_hourly_archive(
    start_date: date,
    end_date: date,
    cache_dir: Path,
    pause_seconds: float,
) -> dict[int, float]:
    hourly: dict[int, float] = {}
    for chunk_start, chunk_end in iter_year_chunks(start_date, end_date):
        print(f"Fetching Lewes verified hourly heights: {chunk_start} through {chunk_end}")
        payload = fetch_product("hourly_height", chunk_start, chunk_end, cache_dir, pause_seconds)
        valid = 0
        for row in payload.get("data", []):
            stamp = parse_utc_stamp(row.get("t"))
            level = parse_level(row.get("v"))
            if stamp is None or level is None:
                continue
            hourly[stamp] = level
            valid += 1
        print(f"  {valid:,} verified hourly levels")
    return hourly


def months_needing_six_minute_fill(
    hourly: dict[int, float],
    start_date: date,
    end_date: date,
) -> list[tuple[date, date]]:
    missing_months: set[str] = set()
    expected_start = max(start_date, SIX_MINUTE_START_DATE)
    for stamp in expected_hour_range(expected_start, end_date):
        if stamp in hourly:
            continue
        utc_day = datetime.fromtimestamp(stamp, timezone.utc).date()
        missing_months.add(utc_day.strftime("%Y-%m"))
    out = []
    for key in sorted(missing_months):
        year, month = map(int, key.split("-"))
        first = max(expected_start, date(year, month, 1))
        last = min(end_date, next_month(date(year, month, 1)) - timedelta(days=1))
        if first <= last:
            out.append((first, last))
    return out


def fill_from_six_minute(
    hourly: dict[int, float],
    start_date: date,
    end_date: date,
    cache_dir: Path,
    pause_seconds: float,
) -> set[int]:
    filled: set[int] = set()
    month_chunks = months_needing_six_minute_fill(hourly, start_date, end_date)
    print(f"Lewes months requiring verified six-minute fallback: {len(month_chunks)}")
    for chunk_start, chunk_end in month_chunks:
        print(f"Fetching Lewes verified six-minute fallback: {chunk_start} through {chunk_end}")
        payload = fetch_product("water_level", chunk_start, chunk_end, cache_dir, pause_seconds)
        candidates: dict[int, tuple[int, float]] = {}
        for row in payload.get("data", []):
            stamp = parse_utc_stamp(row.get("t"))
            level = parse_level(row.get("v"))
            if stamp is None or level is None:
                continue
            anchor = int(round(stamp / HOUR_SECONDS) * HOUR_SECONDS)
            distance = abs(stamp - anchor)
            if distance > MAX_SIX_MINUTE_DISTANCE_SECONDS or anchor in hourly:
                continue
            existing = candidates.get(anchor)
            if existing is None or distance < existing[0]:
                candidates[anchor] = (distance, level)
        for anchor, (_distance, level) in candidates.items():
            hourly[anchor] = level
            filled.add(anchor)
        print(f"  {len(candidates):,} missing hourly anchors filled")
    return filled


def build_days(
    hourly: dict[int, float],
    six_minute_fills: set[int],
    start_date: date,
    end_date: date,
) -> list[dict]:
    days: list[dict] = []
    cursor = start_date
    while cursor <= end_date:
        start_second, end_second = day_utc_bounds(cursor)
        values: list[int | None] = []
        fallback_indexes: list[int] = []
        valid: list[float] = []
        for index, stamp in enumerate(range(start_second, end_second, HOUR_SECONDS)):
            level = hourly.get(stamp)
            if level is None:
                values.append(None)
                continue
            hundredths = int(round(level * 100))
            values.append(hundredths)
            valid.append(hundredths / 100)
            if stamp in six_minute_fills:
                fallback_indexes.append(index)
        if valid:
            peak = max(valid)
            row = {
                "d": cursor.isoformat(),
                "u": start_second,
                "v": values,
                "p": int(round(peak * 100)),
                "c": classify_peak(peak),
            }
            if fallback_indexes:
                row["x"] = fallback_indexes
            days.append(row)
        cursor += timedelta(days=1)
    return days


def build(args: argparse.Namespace) -> dict:
    start_date = args.start_date or ARCHIVE_START_DATE
    end_date = args.end_date or (STONE_HARBOR_CUTOFF_DATE - timedelta(days=1))
    if start_date >= STONE_HARBOR_CUTOFF_DATE:
        raise ValueError("Lewes data are not permitted on or after the Stone Harbor cutoff")
    end_date = min(end_date, STONE_HARBOR_CUTOFF_DATE - timedelta(days=1))
    if start_date > end_date:
        raise ValueError(f"Start date {start_date} is after end date {end_date}")

    cache_dir = args.cache_dir or (Path(tempfile.gettempdir()) / "north-wildwood-lewes-noaa-cache")
    hourly = load_hourly_archive(start_date, end_date, cache_dir, args.pause_seconds)
    six_minute_fills = set()
    if args.six_minute_fallback:
        six_minute_fills = fill_from_six_minute(
            hourly,
            start_date,
            end_date,
            cache_dir,
            args.pause_seconds,
        )

    days = build_days(hourly, six_minute_fills, start_date, end_date)
    valid_hours = sum(sum(value is not None for value in day["v"]) for day in days)
    total_hours_in_stored_days = sum(len(day["v"]) for day in days)
    payload = {
        "schema": "north-wildwood-lewes-hourly-surrogate-v1",
        "stationId": STATION_ID,
        "stationName": STATION_NAME,
        "datum": "NAVD88",
        "units": "feet",
        "timeZone": LOCAL_TIME_ZONE,
        "intervalMinutes": 60,
        "archiveStartDate": days[0]["d"] if days else start_date.isoformat(),
        "archiveEndDate": days[-1]["d"] if days else end_date.isoformat(),
        "stoneHarborCutoffDate": STONE_HARBOR_CUTOFF_DATE.isoformat(),
        "method": "NOAA verified hourly heights; missing hourly anchors use the nearest verified six-minute Lewes observation within 30 minutes when available",
        "usePolicy": "Lewes is a pre-2007 Stone Harbor surrogate only; it is never used on or after 2007-10-01",
        "encoding": {
            "d": "America/New_York civil date",
            "u": "UTC epoch second of the local day's first hourly anchor",
            "v": "NAVD88 feet multiplied by 100; null means NOAA hourly and six-minute data were both unavailable; entries are one UTC hour apart",
            "p": "daily maximum available NAVD88 feet multiplied by 100",
            "c": "daily flood classification using North Wildwood thresholds",
            "x": "indexes in v filled from verified six-minute observations",
        },
        "thresholdsNAVD88": THRESHOLDS_NAVD88,
        "thresholdsMLLW": THRESHOLDS_MLLW,
        "navd88OffsetFromMllwFt": -2.75,
        "sourceLastRequestedDate": end_date.isoformat(),
        "quality": {
            "storedDayCount": len(days),
            "validHourlyLevels": valid_hours,
            "sixMinuteFilledHourlyLevels": len(six_minute_fills),
            "totalHoursInStoredDays": total_hours_in_stored_days,
        },
        "days": days,
    }
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return payload


def parse_date(value: str) -> date:
    return date.fromisoformat(value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("lewes_hourly.json"))
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--start-date", type=parse_date)
    parser.add_argument("--end-date", type=parse_date)
    parser.add_argument("--pause-seconds", type=float, default=0.12)
    parser.add_argument(
        "--six-minute-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    return parser.parse_args()


if __name__ == "__main__":
    result = build(parse_args())
    print(
        json.dumps(
            {
                "output": "lewes_hourly.json",
                "archiveStartDate": result["archiveStartDate"],
                "archiveEndDate": result["archiveEndDate"],
                "quality": result["quality"],
            },
            indent=2,
        )
    )
