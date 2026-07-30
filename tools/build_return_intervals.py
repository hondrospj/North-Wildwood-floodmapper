#!/usr/bin/env python3
"""Build synthetic North Wildwood return-interval storm hydrographs.

For the 1, 2, 5, 10, 20, 50, and 100-year intervals, the target still-water
level is a 2:1 USGS-to-NACCS weighted blend of:

1. the 2015 NACCS mean water level at save point 11283; and
2. a Stone Harbor USGS frequency estimate fitted to annual maxima assembled
   from the historic crest-stage and continuous records at site 01411360.

The 200, 500, 1,000, 2,000, 5,000, and 10,000-year targets use the published
2015 NACCS station 11283 levels directly; no USGS extrapolation or averaging is
applied to those intervals.

The USGS fit is a GEV distribution estimated with L-moments. Return levels use
the Poisson annual-maximum convention F=exp(-1/T), which keeps the one-year
level finite and represents a level exceeded once per T years on average.

Each target is converted to an 84-hour, 15-minute hydrograph by adding a
digitized version of the supplied Cape May surge-ratio curve to NOAA harmonic
tide predictions for Stone Harbor station 8535581. The curve is compressed
from its pictured 100-hour axis to 84 hours, and its maximum is aligned with a
Stone Harbor harmonic high tide at the exact midpoint.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import io
import json
import math
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


NACCS_STATION_ID = 11283
USGS_SITE_ID = "01411360"
USGS_PARAMETER_CD = "72279"
NOAA_STATION_ID = "8535581"
METERS_TO_FEET = 3.280839895013123
WEIGHTED_RETURN_INTERVALS = (1, 2, 5, 10, 20, 50, 100)
NACCS_WEIGHT = 1.0
USGS_WEIGHT = 2.0
RETURN_INTERVALS = (
    *WEIGHTED_RETURN_INTERVALS,
    200,
    500,
    1000,
    2000,
    5000,
    10000,
)
ANALYSIS_END_WATER_YEAR = 2025

NACCS_QUERY_URL = (
    "https://services.northeastoceandata.org/arcgis1/rest/services/"
    "NACCS/NACCS/MapServer/1/query?"
    + urllib.parse.urlencode(
        {
            "where": f"StationId={NACCS_STATION_ID}",
            "outFields": "*",
            "returnGeometry": "true",
            "f": "json",
        }
    )
)
USGS_PEAK_URL = (
    "https://nwis.waterdata.usgs.gov/nwis/peak?"
    + urllib.parse.urlencode(
        {"site_no": USGS_SITE_ID, "agency_cd": "USGS", "format": "rdb"}
    )
)
USGS_JONAS_URL = (
    "https://waterservices.usgs.gov/nwis/iv/?"
    + urllib.parse.urlencode(
        {
            "format": "json",
            "sites": USGS_SITE_ID,
            "parameterCd": USGS_PARAMETER_CD,
            "startDT": "2016-01-22T00:00:00Z",
            "endDT": "2016-01-25T00:00:00Z",
            "siteStatus": "all",
        }
    )
)
NOAA_PREDICTIONS_URL = (
    "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?"
    + urllib.parse.urlencode(
        {
            "product": "predictions",
            "application": "NorthWildwoodFloodmapper",
            "begin_date": "20260613",
            "end_date": "20260618",
            "datum": "NAVD",
            "station": NOAA_STATION_ID,
            "time_zone": "gmt",
            "units": "english",
            "interval": "6",
            "format": "json",
        }
    )
)

STORM_CENTER_UTC = datetime(2026, 6, 16, 1, 45, tzinfo=timezone.utc)
WINDOW_HOURS = 84
INTERVAL_MINUTES = 15

# Digitized from the supplied "Cape May Storm Surge Shape" image. The original
# horizontal axis is 0-100 hours. The builder normalizes the pictured peak and
# maps that full curve onto the requested 84-hour window.
SURGE_PROFILE_CONTROL_POINTS = (
    (0, 0.0033),
    (2, 0.0038),
    (4, 0.0132),
    (6, 0.0199),
    (8, 0.0274),
    (10, 0.0350),
    (12, 0.0428),
    (14, 0.0526),
    (16, 0.0636),
    (18, 0.0768),
    (20, 0.0927),
    (22, 0.1122),
    (24, 0.1354),
    (26, 0.1624),
    (28, 0.1939),
    (30, 0.2288),
    (32, 0.2675),
    (34, 0.3111),
    (36, 0.3575),
    (38, 0.4074),
    (40, 0.4632),
    (42, 0.5312),
    (44, 0.6216),
    (46, 0.7448),
    (48, 0.9041),
    (50, 0.9959),
    (52, 0.8909),
    (54, 0.6936),
    (56, 0.5437),
    (58, 0.4879),
    (60, 0.4850),
    (62, 0.4575),
    (64, 0.4107),
    (66, 0.3621),
    (68, 0.3136),
    (70, 0.2678),
    (72, 0.2275),
    (74, 0.1953),
    (76, 0.1712),
    (78, 0.1579),
    (80, 0.1546),
    (82, 0.1535),
    (84, 0.1513),
    (86, 0.1535),
    (88, 0.1522),
    (90, 0.1468),
    (92, 0.1333),
    (94, 0.1104),
    (96, 0.0757),
    (98, 0.0261),
    (100, 0.0022),
)


def fetch_text(url: str, attempts: int = 4) -> str:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "North-Wildwood-floodmapper-return-intervals/1.0"},
            )
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read().decode("utf-8", errors="replace")
            if not body.strip():
                raise RuntimeError(f"Empty response for {url}")
            return body
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"Request failed after {attempts} attempts: {url}: {last_error}")


def fetch_json(url: str) -> dict:
    return json.loads(fetch_text(url))


def water_year(day: date) -> int:
    return day.year + (1 if day.month >= 10 else 0)


def parse_naccs(payload: dict) -> tuple[dict[int, float], dict]:
    features = payload.get("features") or []
    if len(features) != 1:
        raise RuntimeError(
            f"Expected one NACCS feature for station {NACCS_STATION_ID}, got {len(features)}"
        )
    feature = features[0]
    attributes = feature.get("attributes") or {}
    if int(attributes.get("StationId", -1)) != NACCS_STATION_ID:
        raise RuntimeError("NACCS station response did not match station 11283")
    values = {}
    for interval in RETURN_INTERVALS:
        value_m = float(attributes[f"WL_ARI_{interval}"])
        values[interval] = value_m * METERS_TO_FEET
    return values, {
        "stationId": NACCS_STATION_ID,
        "geometryWebMercator": feature.get("geometry"),
        "depthM": attributes.get("Depth"),
        "datumConversionM": attributes.get("Datum_Conv"),
        "units": "meters",
        "datum": "NAVD88",
    }


def parse_usgs_peak_rows(text: str) -> dict[int, dict]:
    lines = [line for line in text.splitlines() if line and not line.startswith("#")]
    if len(lines) < 3:
        raise RuntimeError("USGS annual peak response did not contain data rows")
    reader = csv.DictReader(io.StringIO("\n".join([lines[0], *lines[2:]])), delimiter="\t")
    maxima: dict[int, dict] = {}
    for row in reader:
        date_value = str(row.get("ag_dt") or row.get("peak_dt") or "").strip()
        height_value = row.get("ag_gage_ht") or row.get("gage_ht")
        try:
            event_date = date.fromisoformat(date_value)
            height = float(height_value)
        except (TypeError, ValueError):
            continue
        year = water_year(event_date)
        record = {
            "waterYear": year,
            "heightNavd88Ft": height,
            "date": event_date.isoformat(),
            "source": "usgs-annual-crest",
        }
        if year not in maxima or height > maxima[year]["heightNavd88Ft"]:
            maxima[year] = record
    return maxima


def continuous_annual_maxima(path: Path) -> dict[int, dict]:
    archive = json.loads(path.read_text(encoding="utf-8"))
    maxima: dict[int, dict] = {}
    for day in archive.get("days", []):
        date_value = day.get("d")
        values = [value for value in day.get("v", []) if value is not None]
        if not date_value or not values:
            continue
        event_date = date.fromisoformat(date_value)
        year = water_year(event_date)
        if year > ANALYSIS_END_WATER_YEAR:
            continue
        height = max(values) / 100.0
        record = {
            "waterYear": year,
            "heightNavd88Ft": height,
            "date": event_date.isoformat(),
            "source": "usgs-continuous-15min",
        }
        if year not in maxima or height > maxima[year]["heightNavd88Ft"]:
            maxima[year] = record
    return maxima


def raw_jonas_maximum(payload: dict) -> dict:
    rows = []
    for series in payload.get("value", {}).get("timeSeries", []):
        for group in series.get("values", []):
            for item in group.get("value", []):
                try:
                    height = float(item.get("value"))
                    stamp = datetime.fromisoformat(
                        str(item.get("dateTime")).replace("Z", "+00:00")
                    )
                except (TypeError, ValueError):
                    continue
                if math.isfinite(height) and abs(height) < 100:
                    rows.append((height, stamp))
    if not rows:
        raise RuntimeError("Raw USGS Jonas query did not contain valid water levels")
    height, stamp = max(rows, key=lambda row: row[0])
    return {
        "waterYear": water_year(stamp.date()),
        "heightNavd88Ft": height,
        "date": stamp.date().isoformat(),
        "time": stamp.isoformat(),
        "source": "usgs-continuous-raw",
    }


def combine_usgs_maxima(
    crest_maxima: dict[int, dict],
    continuous_maxima: dict[int, dict],
    jonas_maximum: dict,
) -> list[dict]:
    # observed15min.json deliberately rescales Jonas to the documented North
    # Wildwood crest for replay. Restore the unmodified Stone Harbor gauge
    # maximum before fitting the Stone Harbor frequency curve.
    continuous_maxima[jonas_maximum["waterYear"]] = jonas_maximum

    combined: dict[int, dict] = {}
    for records in (crest_maxima, continuous_maxima):
        for year, record in records.items():
            if year > ANALYSIS_END_WATER_YEAR:
                continue
            if year not in combined or record["heightNavd88Ft"] > combined[year]["heightNavd88Ft"]:
                combined[year] = dict(record)
    return [combined[year] for year in sorted(combined)]


def fit_gev_lmoments(values: list[float]) -> dict:
    ordered = sorted(float(value) for value in values)
    n = len(ordered)
    if n < 3:
        raise RuntimeError("At least three annual maxima are required for a GEV fit")
    b0 = sum(ordered) / n
    b1 = sum((index / (n - 1)) * value for index, value in enumerate(ordered)) / n
    b2 = (
        sum(
            (index * (index - 1) / ((n - 1) * (n - 2))) * value
            for index, value in enumerate(ordered)
        )
        / n
    )
    l1 = b0
    l2 = 2 * b1 - b0
    l3 = 6 * b2 - 6 * b1 + b0
    if l2 <= 0:
        raise RuntimeError("Invalid second L-moment for the USGS annual maxima")
    tau3 = l3 / l2
    c = 2 / (3 + tau3) - math.log(2) / math.log(3)
    shape = 7.8590 * c + 2.9554 * c * c
    if abs(shape) < 1e-8:
        scale = l2 / math.log(2)
        location = l1 - 0.5772156649015329 * scale
        shape = 0.0
    else:
        gamma = math.gamma(1 + shape)
        scale = l2 * shape / ((1 - 2 ** (-shape)) * gamma)
        location = l1 - scale * (1 - gamma) / shape
    if not (math.isfinite(location) and math.isfinite(scale) and scale > 0):
        raise RuntimeError("GEV L-moment fit did not produce valid parameters")
    return {
        "location": location,
        "scale": scale,
        "shape": shape,
        "l1": l1,
        "l2": l2,
        "l3": l3,
        "lSkewness": tau3,
    }


def gev_return_level(fit: dict, interval_years: int) -> float:
    # The Poisson convention gives -ln(F)=1/T. It is nearly identical to
    # F=1-1/T for long return periods and remains meaningful at T=1.
    reduced = 1 / float(interval_years)
    shape = fit["shape"]
    if abs(shape) < 1e-8:
        return fit["location"] - fit["scale"] * math.log(reduced)
    return fit["location"] + fit["scale"] / shape * (1 - reduced**shape)


def pchip_slopes(xs: list[float], ys: list[float]) -> list[float]:
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    delta = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    slopes = [0.0] * n
    for i in range(1, n - 1):
        if delta[i - 1] == 0 or delta[i] == 0 or delta[i - 1] * delta[i] < 0:
            slopes[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            slopes[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])

    def endpoint(h0: float, h1: float, d0: float, d1: float) -> float:
        slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if slope * d0 <= 0:
            return 0.0
        if d0 * d1 < 0 and abs(slope) > abs(3 * d0):
            return 3 * d0
        return slope

    slopes[0] = endpoint(h[0], h[1], delta[0], delta[1])
    slopes[-1] = endpoint(h[-1], h[-2], delta[-1], delta[-2])
    return slopes


def pchip_value(xs: list[float], ys: list[float], slopes: list[float], x: float) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    index = bisect.bisect_right(xs, x) - 1
    h = xs[index + 1] - xs[index]
    t = (x - xs[index]) / h
    h00 = 2 * t**3 - 3 * t**2 + 1
    h10 = t**3 - 2 * t**2 + t
    h01 = -2 * t**3 + 3 * t**2
    h11 = t**3 - t**2
    return (
        h00 * ys[index]
        + h10 * h * slopes[index]
        + h01 * ys[index + 1]
        + h11 * h * slopes[index + 1]
    )


def build_surge_profile() -> list[dict]:
    xs = [float(point[0]) for point in SURGE_PROFILE_CONTROL_POINTS]
    raw = [float(point[1]) for point in SURGE_PROFILE_CONTROL_POINTS]
    peak = max(raw)
    ys = [max(0.0, min(1.0, value / peak)) for value in raw]
    ys[0] = 0.0
    ys[-1] = 0.0
    slopes = pchip_slopes(xs, ys)
    rows = []
    frame_count = WINDOW_HOURS * 60 // INTERVAL_MINUTES
    for frame in range(frame_count + 1):
        offset_minutes = -WINDOW_HOURS * 30 + frame * INTERVAL_MINUTES
        normalized_time = frame / frame_count * 100
        ratio = max(0.0, min(1.0, pchip_value(xs, ys, slopes, normalized_time)))
        if frame == frame_count // 2:
            ratio = 1.0
        rows.append(
            {
                "offsetMinutes": offset_minutes,
                "normalizedImageTime": normalized_time,
                "ratio": ratio,
            }
        )
    return rows


def parse_noaa_predictions(payload: dict) -> list[tuple[datetime, float]]:
    rows = []
    for item in payload.get("predictions", []):
        try:
            stamp = datetime.strptime(item["t"], "%Y-%m-%d %H:%M").replace(
                tzinfo=timezone.utc
            )
            value = float(item["v"])
        except (KeyError, TypeError, ValueError):
            continue
        rows.append((stamp, value))
    rows.sort()
    if len(rows) < 2:
        raise RuntimeError("NOAA prediction response did not contain a usable series")
    return rows


def interpolate_tide(rows: list[tuple[datetime, float]], stamp: datetime) -> float:
    times = [row[0].timestamp() for row in rows]
    target = stamp.timestamp()
    index = bisect.bisect_left(times, target)
    if index < len(rows) and times[index] == target:
        return rows[index][1]
    if index == 0 or index >= len(rows):
        raise RuntimeError(f"NOAA tide prediction does not bracket {stamp.isoformat()}")
    before_t, before_v = times[index - 1], rows[index - 1][1]
    after_t, after_v = times[index], rows[index][1]
    ratio = (target - before_t) / (after_t - before_t)
    return before_v + (after_v - before_v) * ratio


def build_interval_series(
    target: float,
    interval_years: int,
    tide_rows: list[tuple[datetime, float]],
    surge_profile: list[dict],
) -> tuple[list[dict], float]:
    center_tide = interpolate_tide(tide_rows, STORM_CENTER_UTC)
    surge_peak = target - center_tide
    if surge_peak <= 0:
        raise RuntimeError(
            f"{interval_years}-year target is not above the midpoint harmonic tide"
        )
    series = []
    for profile in surge_profile:
        stamp = STORM_CENTER_UTC + timedelta(minutes=profile["offsetMinutes"])
        tide = interpolate_tide(tide_rows, stamp)
        surge = surge_peak * profile["ratio"]
        total = tide + surge
        series.append(
            {
                "timeUtc": stamp.isoformat().replace("+00:00", "Z"),
                "offsetHours": round(profile["offsetMinutes"] / 60, 2),
                "timelineIntervalMinutes": INTERVAL_MINUTES,
                "observationInterval": "15min",
                "returnIntervalYears": interval_years,
                "astronomicalTideNavd88Ft": round(tide, 4),
                "surgeRatio": round(profile["ratio"], 6),
                "stormSurgeFt": round(surge, 4),
                "navd88StageFt": round(total, 4),
            }
        )
    center_index = len(series) // 2
    series[center_index]["navd88StageFt"] = round(target, 4)
    return series, surge_peak


def build(args: argparse.Namespace) -> dict:
    naccs_values, naccs_station = parse_naccs(fetch_json(NACCS_QUERY_URL))
    crest_maxima = parse_usgs_peak_rows(fetch_text(USGS_PEAK_URL))
    continuous_maxima = continuous_annual_maxima(args.observed)
    jonas_maximum = raw_jonas_maximum(fetch_json(USGS_JONAS_URL))
    annual_maxima = combine_usgs_maxima(
        crest_maxima, continuous_maxima, jonas_maximum
    )
    fit = fit_gev_lmoments([row["heightNavd88Ft"] for row in annual_maxima])
    usgs_values = {
        interval: gev_return_level(fit, interval)
        for interval in WEIGHTED_RETURN_INTERVALS
    }
    tide_rows = parse_noaa_predictions(fetch_json(NOAA_PREDICTIONS_URL))
    surge_profile = build_surge_profile()

    intervals = []
    for interval in RETURN_INTERVALS:
        is_weighted = interval in WEIGHTED_RETURN_INTERVALS
        usgs_value = usgs_values.get(interval)
        target = (
            (
                naccs_values[interval] * NACCS_WEIGHT
                + usgs_value * USGS_WEIGHT
            )
            / (NACCS_WEIGHT + USGS_WEIGHT)
            if is_weighted and usgs_value is not None
            else naccs_values[interval]
        )
        series, surge_peak = build_interval_series(
            target, interval, tide_rows, surge_profile
        )
        intervals.append(
            {
                "years": interval,
                "label": f"{interval:,}-Year",
                "naccsNavd88Ft": round(naccs_values[interval], 4),
                "usgsNavd88Ft": round(usgs_value, 4) if usgs_value is not None else None,
                "weightedNavd88Ft": round(target, 4) if is_weighted else None,
                "weightedMllwFt": round(target + 2.75, 4) if is_weighted else None,
                "targetMethod": (
                    "naccs-usgs-weighted" if is_weighted else "naccs-only"
                ),
                "targetNavd88Ft": round(target, 4),
                "targetMllwFt": round(target + 2.75, 4),
                "midpointHarmonicTideNavd88Ft": round(
                    interpolate_tide(tide_rows, STORM_CENTER_UTC), 4
                ),
                "peakStormSurgeFt": round(surge_peak, 4),
                "peakIndex15min": len(series) // 2,
                "series15min": series,
            }
        )

    return {
        "schema": "north-wildwood-return-intervals-v3",
        "generatedAtUtc": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "datum": "NAVD88",
        "displayMllwOffsetFt": 2.75,
        "returnIntervalsYears": list(RETURN_INTERVALS),
        "weightedReturnIntervalsYears": list(WEIGHTED_RETURN_INTERVALS),
        "naccsOnlyReturnIntervalsYears": [
            interval
            for interval in RETURN_INTERVALS
            if interval not in WEIGHTED_RETURN_INTERVALS
        ],
        "windowHours": WINDOW_HOURS,
        "intervalMinutes": INTERVAL_MINUTES,
        "stormCenterUtc": STORM_CENTER_UTC.isoformat().replace("+00:00", "Z"),
        "method": {
            "naccs": (
                "2015 NACCS station 11283 mean water-level annual recurrence "
                "intervals, converted from meters to feet NAVD88"
            ),
            "usgs": (
                "GEV distribution fitted by L-moments to one maximum per available "
                "water year from the USGS Stone Harbor crest-stage and continuous "
                "records; return-level CDF F=exp(-1/T)"
            ),
            "targetSelection": (
                "Two parts Stone Harbor USGS to one part NACCS for matching "
                "1-100-year return levels; published NACCS station 11283 "
                "level used directly for 200-10,000 years"
            ),
            "targetWeights": {
                "naccs": NACCS_WEIGHT,
                "usgs": USGS_WEIGHT,
            },
            "hydrograph": (
                "NOAA Stone Harbor harmonic prediction plus the supplied, digitized "
                "Cape May surge-ratio shape compressed from 100 to 84 hours; peak "
                "aligned to the midpoint harmonic high tide"
            ),
            "stationarity": (
                "screening-level stationary frequency estimate; no sea-level-trend "
                "detrending or future sea-level-rise increment"
            ),
        },
        "sources": {
            "naccs": {
                "url": NACCS_QUERY_URL,
                **naccs_station,
            },
            "usgsAnnualCrests": {
                "url": USGS_PEAK_URL,
                "site": USGS_SITE_ID,
                "datum": "NAVD88",
            },
            "usgsContinuous": {
                "site": USGS_SITE_ID,
                "parameterCd": USGS_PARAMETER_CD,
                "archive": str(args.observed),
                "rawJonasUrl": USGS_JONAS_URL,
            },
            "noaaHarmonicTide": {
                "url": NOAA_PREDICTIONS_URL,
                "station": NOAA_STATION_ID,
                "datum": "NAVD",
                "units": "feet",
                "timeZone": "GMT",
                "sourceIntervalMinutes": 6,
            },
            "surgeProfile": {
                "description": "Digitized from user-supplied Cape May Storm Surge Shape image",
                "picturedWindowHours": 100,
                "appliedWindowHours": WINDOW_HOURS,
                "controlPoints": [
                    {"time": time_value, "ratio": ratio}
                    for time_value, ratio in SURGE_PROFILE_CONTROL_POINTS
                ],
            },
        },
        "usgsFrequencyFit": {
            "distribution": "GEV",
            "estimator": "L-moments",
            "returnLevelConvention": "F=exp(-1/T)",
            "analysisEndWaterYear": ANALYSIS_END_WATER_YEAR,
            "sampleCount": len(annual_maxima),
            "firstWaterYear": annual_maxima[0]["waterYear"],
            "lastWaterYear": annual_maxima[-1]["waterYear"],
            "parameters": {
                key: round(value, 10)
                for key, value in fit.items()
            },
            "annualMaxima": [
                {
                    **row,
                    "heightNavd88Ft": round(row["heightNavd88Ft"], 4),
                }
                for row in annual_maxima
            ],
        },
        "intervals": intervals,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--observed",
        type=Path,
        default=Path("observed15min.json"),
        help="Existing compact USGS Stone Harbor continuous archive",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("return_intervals.json"),
    )
    return parser.parse_args()


if __name__ == "__main__":
    cli_args = parse_args()
    payload = build(cli_args)
    cli_args.output.write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(cli_args.output),
                "returnIntervals": payload["returnIntervalsYears"],
                "usgsAnnualMaxima": payload["usgsFrequencyFit"]["sampleCount"],
                "framesPerInterval": len(payload["intervals"][0]["series15min"]),
            },
            indent=2,
        )
    )
