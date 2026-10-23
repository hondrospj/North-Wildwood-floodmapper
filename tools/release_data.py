#!/usr/bin/env python3
"""Validate generated JSON without treating a data update as an application release."""
from datetime import datetime, timezone
import json
import math
from pathlib import Path

from release_schemas import validate_generated


# PETSS is normally issued every six hours. A release may retain up to three
# days of a source outage only while real future guidance remains. Rebuilding a
# JSON file does not reset this age: it is measured from petssCycleUtc.
MAX_SOURCE_AGE_HOURS = 72
MAX_FUTURE_CLOCK_SKEW_HOURS = 1


# Keep these entries aligned with paths-ignore in all four regression workflows.
GENERATED_FILES = frozenset({
    "forecast.json", "data/experimental_petss_guidance.json", "observed.json",
    "observed15min.json", "stone_harbor_observed15min.json", "toptides.json",
    "observed_archive_index.json", "lewes_archive_index.json", "lewes_hourly.json",
})
GENERATED_DIRECTORIES = (
    "observed_archive/", "city-gauge/data/", "city-gauge/comparison/",
)


def is_generated_data(path):
    """Only known generated JSON can inherit the application ancestor's checks."""
    return path in GENERATED_FILES or (
        path.endswith(".json") and any(path.startswith(prefix) for prefix in GENERATED_DIRECTORIES)
    )


def read_json(path):
    def reject_constant(value):
        raise ValueError(f"{path}: nonfinite JSON number {value}")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{path}: duplicate JSON key {key}")
            result[key] = value
        return result

    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError(f"{path}: nonfinite JSON number")
        return result

    payload = json.loads(path.read_text(), parse_constant=reject_constant, parse_float=finite_float,
                         object_pairs_hook=unique_object)
    if not isinstance(payload, (dict, list)) or not payload:
        raise ValueError(f"{path}: generated data must be a nonempty JSON object or array")
    return payload


def utc_time(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label}: UTC timestamp is required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError(f"{label}: timestamp must identify UTC")
    return parsed.astimezone(timezone.utc)


def finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label}: finite numeric water level is required")
    return value


def validate_forecast(payload, now=None):
    """Protect time, scenario, and datum invariants consumed by the browser."""
    if not isinstance(payload, dict):
        raise ValueError("Forecast must be a JSON object")
    if payload.get("sourceDatum") != "MLLW" or payload.get("mapDatum") != "NAVD88":
        raise ValueError("Forecast must explicitly identify MLLW input and NAVD88 map datums")
    offset = finite_number(payload.get("navd88OffsetFromMllwFt"), "forecast datum offset")
    if offset != -2.75:
        raise ValueError("Forecast datum conversion differs from the North Wildwood reference")
    issued = utc_time(payload.get("issuedUtc"), "forecast issuedUtc")
    cycle = utc_time(payload.get("petssCycleUtc"), "forecast petssCycleUtc")
    now = datetime.now(timezone.utc) if now is None else now
    if now.tzinfo is None or now.utcoffset().total_seconds() != 0:
        raise ValueError("Forecast validation clock must identify UTC")
    if cycle > issued:
        raise ValueError("Forecast source cycle cannot follow its generation timestamp")
    start = utc_time(payload.get("forecastStartUtc"), "forecast start")
    end = utc_time(payload.get("forecastEndUtc"), "forecast end")
    if end <= start or end <= issued:
        raise ValueError("Forecast must cover a positive interval after generation")
    if end <= now:
        raise ValueError("Forecast guidance has expired; no future coverage remains")
    source_age = (now - cycle).total_seconds() / 3600
    if source_age > MAX_SOURCE_AGE_HOURS:
        raise ValueError("Forecast source cycle is older than the 72-hour release policy")
    if (issued - now).total_seconds() > MAX_FUTURE_CLOCK_SKEW_HOURS * 3600:
        raise ValueError("Forecast generation timestamp is implausibly in the future")
    scenarios = payload.get("scenarioForecasts", {})
    timelines = {}
    for scenario in ("mean", "lowEnd", "highEnd"):
        hours = scenarios.get(scenario, {}).get("hours")
        if not isinstance(hours, list) or not hours:
            raise ValueError(f"Forecast {scenario} scenario has no hours")
        times = []
        for hour in hours:
            timestamp = utc_time(hour.get("timeUtc"), f"{scenario} timeUtc")
            if times and timestamp <= times[-1]:
                raise ValueError(f"Forecast {scenario} hours must be unique and increasing")
            navd = finite_number(hour.get("navd88StageFt"), f"{scenario} NAVD88")
            mllw = finite_number(hour.get("mllwStageFt"), f"{scenario} MLLW")
            if abs(navd - (mllw + offset)) > 0.021:
                raise ValueError(f"Forecast {scenario} has inconsistent MLLW/NAVD88 conversion")
            times.append(timestamp)
        if times[0] != start or times[-1] != end:
            raise ValueError(f"Forecast {scenario} hours do not match the declared interval")
        timelines[scenario] = times
    if not (timelines["mean"] == timelines["lowEnd"] == timelines["highEnd"]):
        raise ValueError("Forecast scenarios must use identical valid times")
    for mean, low, high in zip(*(scenarios[key]["hours"] for key in ("mean", "lowEnd", "highEnd"))):
        if not low["navd88StageFt"] - 0.021 <= mean["navd88StageFt"] <= high["navd88StageFt"] + 0.021:
            raise ValueError("Forecast low/mean/high scenario levels are out of order")
    if payload.get("hours") != scenarios["mean"]["hours"]:
        raise ValueError("Operational forecast hours must equal the published mean scenario")
    return {"hours": len(timelines["mean"]), "cycle": cycle.isoformat(), "sourceAgeHours": round(source_age, 3),
            "remainingCoverageHours": round((end - now).total_seconds() / 3600, 3)}


def validate_data(source, changed_paths, now=None):
    """Validate every changed generated file, plus the shared operational forecast."""
    source = Path(source)
    paths = sorted(set(changed_paths))
    for path in paths:
        if not is_generated_data(path):
            raise ValueError(f"Application file cannot use the generated-data release path: {path}")
        payload = read_json(source / path)  # Missing/deleted or invalid outputs fail closed.
        if path != "forecast.json":
            validate_generated(path, payload)
    forecast = validate_forecast(read_json(source / "forecast.json"), now=now)
    if any(path in {"observed.json", "observed15min.json", "stone_harbor_observed15min.json", "observed_archive_index.json"}
           or path.startswith(("city-gauge/", "observed_archive/stone-harbor/")) for path in paths):
        from validate_observed_contract import validate
        validate(source / "observed15min.json")
    return {"validatedGeneratedFiles": len(paths), "forecast": forecast}
