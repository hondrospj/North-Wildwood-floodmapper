#!/usr/bin/env python3
"""Regression checks for North Wildwood return-interval scenarios."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = json.loads((ROOT / "return_intervals.json").read_text(encoding="utf-8"))
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")
WEIGHTED_INTERVALS = [1, 2, 5, 10, 20, 50, 100]
NACCS_ONLY_INTERVALS = [200, 500, 1000, 2000, 5000, 10000]
EXPECTED_INTERVALS = [*WEIGHTED_INTERVALS, *NACCS_ONLY_INTERVALS]
EXPECTED_NACCS_FT = {
    1: 4.2165,
    2: 5.4460,
    5: 6.6425,
    10: 7.3436,
    20: 8.0468,
    50: 9.5326,
    100: 10.7608,
    200: 11.9254,
    500: 13.4856,
    1000: 14.7033,
    2000: 15.9218,
    5000: 17.5026,
    10000: 18.6306,
}


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> None:
    if PAYLOAD["schema"] != "north-wildwood-return-intervals-v3":
        raise AssertionError("Unexpected return-interval schema")
    if PAYLOAD["returnIntervalsYears"] != EXPECTED_INTERVALS:
        raise AssertionError("Return intervals do not match NACCS through 10,000 years")
    if PAYLOAD["weightedReturnIntervalsYears"] != WEIGHTED_INTERVALS:
        raise AssertionError("Only the 1-100-year intervals may use the NACCS-USGS blend")
    if PAYLOAD["naccsOnlyReturnIntervalsYears"] != NACCS_ONLY_INTERVALS:
        raise AssertionError("The 200-10,000-year intervals must be NACCS-only")
    if PAYLOAD["method"]["targetWeights"] != {"naccs": 1.0, "usgs": 2.0}:
        raise AssertionError("The selected blend must weight USGS two-to-one over NACCS")
    if PAYLOAD["windowHours"] != 24 or PAYLOAD["intervalMinutes"] != 15:
        raise AssertionError("Synthetic storms must use a 24-hour, 15-minute window")

    fit = PAYLOAD["usgsFrequencyFit"]
    maxima = fit["annualMaxima"]
    if fit["sampleCount"] != 60 or len(maxima) != 60:
        raise AssertionError("USGS fit must contain the 60 available complete water years")
    years = [row["waterYear"] for row in maxima]
    if years != sorted(set(years)) or years[0] != 1965 or years[-1] != 2025:
        raise AssertionError("USGS water-year record is not unique and ordered from 1965-2025")
    jonas = next(row for row in maxima if row["waterYear"] == 2016)
    if not math.isclose(jonas["heightNavd88Ft"], 6.22, abs_tol=1e-9):
        raise AssertionError("Frequency fit used the replay-calibrated Jonas value instead of raw USGS")
    if jonas["source"] != "usgs-continuous-raw":
        raise AssertionError("Raw USGS Jonas provenance is missing")

    records = PAYLOAD["intervals"]
    if [record["years"] for record in records] != EXPECTED_INTERVALS:
        raise AssertionError("Return-interval records are incomplete or out of order")

    previous_naccs = previous_usgs = previous_target = -math.inf
    reference_tide = None
    for record in records:
        years = record["years"]
        if not math.isclose(record["naccsNavd88Ft"], EXPECTED_NACCS_FT[years], abs_tol=5e-5):
            raise AssertionError(f"{years}-year NACCS conversion is incorrect")
        if years in WEIGHTED_INTERVALS:
            if record["targetMethod"] != "naccs-usgs-weighted":
                raise AssertionError(f"{years}-year target must use the NACCS-USGS blend")
            if not math.isclose(
                record["weightedNavd88Ft"],
                (
                    record["naccsNavd88Ft"]
                    + 2 * record["usgsNavd88Ft"]
                )
                / 3,
                abs_tol=1e-4,
            ):
                raise AssertionError(f"{years}-year weighted blend is incorrect")
            if not math.isclose(
                record["targetNavd88Ft"], record["weightedNavd88Ft"], abs_tol=1e-9
            ):
                raise AssertionError(f"{years}-year target does not match its blend")
            if record["usgsNavd88Ft"] <= previous_usgs:
                raise AssertionError("Averaged USGS return levels must increase monotonically")
            previous_usgs = record["usgsNavd88Ft"]
        else:
            if record["targetMethod"] != "naccs-only":
                raise AssertionError(f"{years}-year target must use NACCS directly")
            if any(
                record[field] is not None
                for field in ("usgsNavd88Ft", "weightedNavd88Ft", "weightedMllwFt")
            ):
                raise AssertionError(f"{years}-year record must not contain a USGS blend")
            if not math.isclose(
                record["targetNavd88Ft"], record["naccsNavd88Ft"], abs_tol=1e-9
            ):
                raise AssertionError(f"{years}-year NACCS target is incorrect")
        if not math.isclose(
            record["targetMllwFt"],
            record["targetNavd88Ft"] + 2.75,
            abs_tol=1e-9,
        ):
            raise AssertionError(f"{years}-year MLLW display conversion is incorrect")
        if not (
            record["naccsNavd88Ft"] > previous_naccs
            and record["targetNavd88Ft"] > previous_target
        ):
            raise AssertionError("NACCS and selected target levels must increase monotonically")
        previous_naccs = record["naccsNavd88Ft"]
        previous_target = record["targetNavd88Ft"]

        series = record["series15min"]
        if len(series) != 97 or record["peakIndex15min"] != 48:
            raise AssertionError(f"{years}-year series does not contain 97 centered frames")
        start = parse_utc(series[0]["timeUtc"])
        end = parse_utc(series[-1]["timeUtc"])
        center = parse_utc(series[48]["timeUtc"])
        if (end - start).total_seconds() != 24 * 3600:
            raise AssertionError(f"{years}-year series is not exactly 24 hours")
        if center != start + (end - start) / 2:
            raise AssertionError(f"{years}-year storm maximum is not at the midpoint")
        for before, after in zip(series, series[1:]):
            if (parse_utc(after["timeUtc"]) - parse_utc(before["timeUtc"])).total_seconds() != 900:
                raise AssertionError(f"{years}-year series is not on a 15-minute grid")

        peak = max(row["navd88StageFt"] for row in series)
        peak_indices = [
            index for index, row in enumerate(series)
            if math.isclose(row["navd88StageFt"], peak, abs_tol=1e-9)
        ]
        if peak_indices != [48] or not math.isclose(
            peak, record["targetNavd88Ft"], abs_tol=1e-9
        ):
            raise AssertionError(f"{years}-year target is not the unique midpoint maximum")
        if series[0]["surgeRatio"] != 0 or series[-1]["surgeRatio"] != 0:
            raise AssertionError(f"{years}-year surge must begin and end at zero")
        if series[48]["surgeRatio"] != 1:
            raise AssertionError(f"{years}-year midpoint surge ratio must be one")

        tide = [row["astronomicalTideNavd88Ft"] for row in series]
        if reference_tide is None:
            reference_tide = tide
        elif tide != reference_tide:
            raise AssertionError("Every return interval must use the identical harmonic tide")
        local_high_tides = [
            index
            for index in range(1, len(tide) - 1)
            if tide[index] >= tide[index - 1]
            and tide[index] >= tide[index + 1]
            and (tide[index] > tide[index - 1] or tide[index] > tide[index + 1])
        ]
        if not local_high_tides or local_high_tides[0] != 48:
            raise AssertionError(f"{years}-year surge peak is not aligned to the first high tide")
        if any(row["navd88StageFt"] < -4 for row in series):
            raise AssertionError(f"{years}-year series falls below the mapper stage catalog")
        if any(row["navd88StageFt"] > 20 for row in series):
            raise AssertionError(f"{years}-year series exceeds the 20-ft catalog")

    # The digitized curve must retain the image's sharp peak, post-peak shoulder,
    # and long tail rather than becoming a symmetric bell curve.
    controls = {
        int(row["time"]): float(row["ratio"])
        for row in PAYLOAD["sources"]["surgeProfile"]["controlPoints"]
    }
    if not (controls[48] > 0.90 and controls[50] > controls[48] and controls[52] < controls[50]):
        raise AssertionError("Digitized surge profile lost its sharp central peak")
    if not (0.47 < controls[58] < 0.51 and 0.47 < controls[60] < 0.51):
        raise AssertionError("Digitized surge profile lost its post-peak shoulder")
    if not (0.14 < controls[80] < 0.17 and 0.14 < controls[88] < 0.17):
        raise AssertionError("Digitized surge profile lost its long recession tail")

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
    for forbidden in (
        'id="returnIntervalMethodNote"',
        "no USGS averaging",
        "depth map capped at",
    ):
        if forbidden in INDEX:
            raise AssertionError(f"Return-interval UI still contains {forbidden}")

    print("North Wildwood return-interval data and UI contract checks passed")


if __name__ == "__main__":
    main()
