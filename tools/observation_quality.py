"""Versioned observation contracts shared by archive and analytical builders.

These are conservative eligibility rules, not a station calibration. Raw station
values are never bias-corrected by a cross-station discrepancy check.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

POLICY_VERSION = "north-wildwood-observation-quality-v1"
MAX_INTERPOLATION_GAP_SECONDS = 1800
MIN_DAILY_COVERAGE = 0.90
MIN_MONTHLY_DAY_COVERAGE = 0.90
MIN_ANNUAL_COVERAGE = 0.99
MAX_ANNUAL_GAP_SECONDS = 6 * 3600
ANALYTICAL_QUALITY_CODES = frozenset("MI")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def municipal_epoch(value: str) -> int:
    """Require one unambiguous instant; accept explicit ISO UTC offsets."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        return int(parsed.timestamp())
    zone = ZoneInfo("America/New_York")
    candidates = set()
    for fold in (0, 1):
        aware = parsed.replace(tzinfo=zone, fold=fold)
        utc = aware.astimezone(timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) == parsed:
            candidates.add(int(utc.timestamp()))
    if len(candidates) != 1:
        raise ValueError(f"Ambiguous or nonexistent municipal wall time: {value}")
    return candidates.pop()


def sample_quality(day: dict, index: int) -> str:
    codes = day.get("q", "")
    return codes[index] if index < len(codes) else "C" if day.get("j") else "U"


def analytical_samples(payload: dict, *, require_single_station: bool = False):
    """Reject archives without an auditable sampling policy; omit ineligible samples."""
    if payload.get("qualityPolicyVersion") != POLICY_VERSION:
        raise ValueError("Rebuild the archive from source observations with the current quality policy before fitting analytics")
    rows = []
    stations = set()
    for day in payload.get("days", []):
        for index, encoded in enumerate(day.get("v", [])):
            if encoded is None or sample_quality(day, index) not in ANALYTICAL_QUALITY_CODES:
                continue
            if isinstance(encoded, bool) or not isinstance(encoded, (int, float)) or not math.isfinite(encoded):
                continue
            sources = day.get("s", "")
            spans = day.get("g", [])
            if len(sources) != len(day["v"]) or len(spans) != len(day["v"]):
                raise ValueError("Qualified samples require aligned station and interpolation-span provenance")
            station = sources[index]
            if station not in {"N", "S"}:
                raise ValueError("Qualified sample has an unknown station")
            span = spans[index]
            if sample_quality(day, index) == "I" and (span is None or not 0 < span <= MAX_INTERPOLATION_GAP_SECONDS):
                raise ValueError("Interpolated sample exceeds the analytical gap limit")
            if sample_quality(day, index) == "M" and span != 0:
                raise ValueError("Measured sample has an invalid interpolation span")
            stations.add(station)
            rows.append((int(day["u"]) + index * 900, encoded / 100.0, station))
    if not rows:
        raise ValueError("No quality-qualified observations; backfill source sampling provenance first")
    if require_single_station and (len(stations) != 1 or not stations <= {"N", "S"}):
        raise ValueError("A sea-level trend requires a homogeneous station series; use --trend-observed with a single-station archive")
    return sorted(rows)


def annual_exposure(rows: list[tuple[int, float, str]], year: int) -> dict:
    zone = ZoneInfo("America/New_York")
    start = int(datetime(year - 1, 10, 1, tzinfo=zone).timestamp())
    end = int(datetime(year, 10, 1, tzinfo=zone).timestamp())
    stamps = sorted({t for t, *_ in rows if start <= t < end})
    expected = (end - start) // 900
    boundaries = [start - 900, *stamps, end]
    max_gap = max((b - a - 900 for a, b in zip(boundaries, boundaries[1:])), default=end-start)
    coverage = len(stamps) / expected
    return {"coverageFraction": round(coverage, 6), "validQuarterHours": len(stamps),
            "expectedQuarterHours": expected, "maximumGapSeconds": max_gap,
            "eligible": coverage >= MIN_ANNUAL_COVERAGE and max_gap <= MAX_ANNUAL_GAP_SECONDS}


def complete_water_year_samples(rows):
    """Keep balanced annual exposure for event-frequency/CDF fitting."""
    zone = ZoneInfo("America/New_York")
    grouped = defaultdict(list)
    for row in rows:
        day = datetime.fromtimestamp(row[0], zone)
        year = day.year + (day.month >= 10)
        grouped[year].append(row)
    exposure = {year: annual_exposure(samples, year) for year, samples in grouped.items()}
    kept = [row for year, samples in sorted(grouped.items()) if exposure[year]["eligible"] for row in samples]
    if not kept:
        raise ValueError("No complete, quality-qualified water years; backfill source provenance and review gauge coverage before fitting event frequencies")
    return kept, exposure
