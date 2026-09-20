#!/usr/bin/env python3
"""Regression checks for the statewide V2 return-interval pipeline."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = json.loads((ROOT / "return_intervals.json").read_text(encoding="utf-8"))
LEVELS = json.loads((ROOT / "return_interval_levels_v2.json").read_text(encoding="utf-8"))
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")
EXPECTED_INTERVALS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
EXPECTED_PRECEDENCE = [
    "primary-usgs-continuous",
    "bias-corrected-noaa-historical-fill",
    "official-usgs-storm-tide-crest-override",
]


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> None:
    if PAYLOAD["schema"] != "nj-floodmapper-return-intervals-v2":
        raise AssertionError("Unexpected return-interval schema")
    if LEVELS["schema"] != "nj-floodmapper-return-levels-v2":
        raise AssertionError("Unexpected return-level schema")
    if PAYLOAD["returnIntervalsYears"] != EXPECTED_INTERVALS:
        raise AssertionError("Return intervals do not extend through 10,000 years")
    if PAYLOAD["windowHours"] != 24 or PAYLOAD["intervalMinutes"] != 15:
        raise AssertionError("Synthetic storms must use a 24-hour, 15-minute window")
    if PAYLOAD["datum"] != "NAVD88" or LEVELS["datum"] != "NAVD88":
        raise AssertionError("Return products must use NAVD88")
    if PAYLOAD["method"] != LEVELS["method"]:
        raise AssertionError("Hydrographs and return levels use different methods")
    for token in ("USGS-first", "bias-corrected NOAA", "USGS-crest-override"):
        if token not in PAYLOAD["method"]:
            raise AssertionError(f"Return-level method is missing {token}")

    provenance = PAYLOAD["provenance"]
    if provenance != LEVELS["provenance"]:
        raise AssertionError("Hydrographs and return levels use different provenance")
    if provenance["policyVersion"] != "20260920-nj-universal-v2":
        raise AssertionError("Return levels do not use the universal V2 policy")
    if provenance["sourcePrecedence"] != EXPECTED_PRECEDENCE:
        raise AssertionError("Return levels do not enforce the required source precedence")
    if provenance["primaryUsgsGaugeId"] != "01411360":
        raise AssertionError("North Wildwood must prefer USGS 01411360")
    if provenance["noaaStationId"] != "8557380" or provenance["noaaRegion"] != "lewes":
        raise AssertionError("North Wildwood must use bias-corrected NOAA Lewes history")
    if provenance["crestUsgsStationId"] != "01411360":
        raise AssertionError("North Wildwood must use the nearest official USGS crest station")
    if provenance["calibrationPairKey"] != "01411360:lewes":
        raise AssertionError("North Wildwood calibration pair is incorrect")
    if not math.isclose(provenance["noaaBiasCorrectionFt"], 0.066, abs_tol=1e-9):
        raise AssertionError("North Wildwood NOAA bias correction changed unexpectedly")
    overlap = provenance["calibrationOverlap"]
    if overlap["acceptedDays"] < 1800 or overlap["acceptedDays"] > overlap["rawDays"]:
        raise AssertionError("NOAA/USGS calibration lacks sufficient accepted overlap")
    validation = provenance["calibrationValidation"]
    if validation["maeFt"] > 0.5 or validation["rmseFt"] > 0.6 or not validation["folds"]:
        raise AssertionError("NOAA/USGS calibration validation is outside the release limits")

    level_records = LEVELS["levels"]
    records = PAYLOAD["intervals"]
    if [record["years"] for record in level_records] != EXPECTED_INTERVALS:
        raise AssertionError("Return-level records are incomplete or out of order")
    if [record["years"] for record in records] != EXPECTED_INTERVALS:
        raise AssertionError("Return-interval records are incomplete or out of order")
    level_by_year = {record["years"]: record["navd88Ft"] for record in level_records}

    previous_target = -math.inf
    reference_tide = None
    for record in records:
        years = record["years"]
        target = record["targetNavd88Ft"]
        if record["targetMethod"] != (
            "Gumbel fit to canonical USGS-first, bias-corrected NOAA, "
            "official USGS-crest-override composite"
        ):
            raise AssertionError(f"{years}-year target method is incorrect")
        if not math.isclose(target, level_by_year[years], abs_tol=1e-9):
            raise AssertionError(f"{years}-year hydrograph does not match its return level")
        if target <= previous_target:
            raise AssertionError("Selected return levels must increase monotonically")
        previous_target = target
        if not math.isclose(
            record["targetMllwFt"],
            target + PAYLOAD["displayMllwOffsetFt"],
            abs_tol=1e-9,
        ):
            raise AssertionError(f"{years}-year MLLW display conversion is incorrect")

        series = record["series15min"]
        peak_index = record["peakIndex15min"]
        if len(series) != 97 or peak_index != 48:
            raise AssertionError(f"{years}-year series does not contain 97 centered frames")
        start = parse_utc(series[0]["timeUtc"])
        end = parse_utc(series[-1]["timeUtc"])
        center = parse_utc(series[peak_index]["timeUtc"])
        if (end - start).total_seconds() != 24 * 3600:
            raise AssertionError(f"{years}-year series is not exactly 24 hours")
        if center != start + (end - start) / 2:
            raise AssertionError(f"{years}-year storm maximum is not at the midpoint")
        for before, after in zip(series, series[1:]):
            if (parse_utc(after["timeUtc"]) - parse_utc(before["timeUtc"])).total_seconds() != 900:
                raise AssertionError(f"{years}-year series is not on a 15-minute grid")

        peak = max(row["navd88StageFt"] for row in series)
        peak_indices = [
            index
            for index, row in enumerate(series)
            if math.isclose(row["navd88StageFt"], peak, abs_tol=1e-9)
        ]
        if peak_indices != [peak_index] or not math.isclose(peak, target, abs_tol=1e-9):
            raise AssertionError(f"{years}-year target is not the unique midpoint maximum")
        if series[0]["surgeRatio"] != 0 or series[-1]["surgeRatio"] != 0:
            raise AssertionError(f"{years}-year surge must begin and end at zero")
        if series[peak_index]["surgeRatio"] != 1:
            raise AssertionError(f"{years}-year midpoint surge ratio must be one")

        tide = [row["astronomicalTideNavd88Ft"] for row in series]
        if reference_tide is None:
            reference_tide = tide
        elif tide != reference_tide:
            raise AssertionError("Every return interval must use the identical harmonic tide")
        if any(row["navd88StageFt"] < -4 for row in series):
            raise AssertionError(f"{years}-year series falls below the mapper stage catalog")
        if any(row["navd88StageFt"] > 20 for row in series):
            raise AssertionError(f"{years}-year series exceeds the mapper stage catalog")

    required_ui_tokens = (
        'id="returnIntervalDataBtn"',
        'id="returnIntervalCard"',
        ">Modeled Floods</button>",
        "<h2>How Often?</h2>",
        "Every 10 Years",
        'data-return-years="10000"',
        "function loadReturnInterval(",
        "returnIntervalsPath",
        'currentViewType === "return-interval"',
        "Every 100 Years",
    )
    for token in required_ui_tokens:
        if token not in INDEX:
            raise AssertionError(f"Return-interval UI contract is missing {token}")

    print("North Wildwood universal V2 return-interval contracts passed")


if __name__ == "__main__":
    main()
