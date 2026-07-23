#!/usr/bin/env python3
"""Build North Wildwood's Stone Harbor-gauge historic storm-tide archive.

The continuous Stone Harbor archive begins in 2007. USGS annual peak records
preserve older, crest-only coastal floods at the Stone Harbor gauge. Those
records have a water level but generally do not have a complete hydrograph, so
the mapper deliberately presents them as maximum-extent events.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


MINOR_FLOOD_NAVD88_FT = 3.25
PEAK_ENDPOINT = "https://nwis.waterdata.usgs.gov/nwis/peak"
STATIONS = (
    {
        "site_no": "01411360",
        "station_name": "Great Channel at Stone Harbor NJ",
        "station_short": "Stone Harbor",
        "source_area": "north-wildwood",
        "station_priority": 3,
    },
)

# The annual NWIS crest table does not contain the 1962 Ash Wednesday event.
# Preserve the Stone Harbor crest supplied for this mapper and use the Lewes
# hourly archive only for the event's tidal shape in the browser.
MANUAL_EVENTS = (
    {
        "height_ft": 7.50,
        "date": "1962-03-07",
        "display_date": "March 7, 1962",
        "datum": "NAVD88",
        "site_no": "01411360",
        "station_name": "Great Channel at Stone Harbor NJ",
        "station_short": "Stone Harbor",
        "source_area": "north-wildwood",
        "station_priority": 3,
        "event_name": "Ash Wednesday Storm",
        "record_type": "Documented historic Stone Harbor crest; Lewes NOAA hourly shape",
        "source_url": "https://tidesandcurrents.noaa.gov/inundationdb/inundation.html?id=8557380",
    },
    {
        "height_ft": 6.69,
        "height_mllw_ft": 9.44,
        "date": "2016-01-23",
        "display_date": "January 23, 2016",
        "datum": "NAVD88",
        "site_no": "01411360",
        "station_name": "Great Channel at Stone Harbor NJ",
        "station_short": "Stone Harbor",
        "source_area": "north-wildwood-calibrated",
        "station_priority": 4,
        "event_name": "Winter Storm Jonas",
        "record_type": "North Wildwood documented crest; Stone Harbor gauge tide shape",
    },
)


def fetch_text(url: str, attempts: int = 4) -> str:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "North-Wildwood-floodmapper-2.0/1.0"},
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read().decode("utf-8", errors="replace")
            if not body.strip():
                raise RuntimeError(f"Empty response for {url}")
            return body
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"USGS peak request failed after {attempts} attempts: {last_error}")


def peak_url(site_no: str) -> str:
    return PEAK_ENDPOINT + "?" + urllib.parse.urlencode(
        {"site_no": site_no, "agency_cd": "USGS", "format": "rdb"}
    )


def normalize_time(value: str) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) != 4:
        return None
    hour, minute = int(digits[:2]), int(digits[2:])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def parse_station_rows(station: dict) -> list[dict]:
    raw = fetch_text(peak_url(station["site_no"]))
    lines = [line for line in raw.splitlines() if line and not line.startswith("#")]
    if len(lines) < 3:
        return []
    reader = csv.DictReader(io.StringIO("\n".join([lines[0], *lines[2:]])), delimiter="\t")
    events: list[dict] = []
    for row in reader:
        date_value = str(row.get("ag_dt") or row.get("peak_dt") or "").strip()
        height_raw = row.get("ag_gage_ht") or row.get("gage_ht")
        try:
            height = float(height_raw)
            datetime.strptime(date_value, "%Y-%m-%d")
        except (TypeError, ValueError):
            continue
        if not math.isfinite(height) or height < MINOR_FLOOD_NAVD88_FT:
            continue
        time_value = normalize_time(row.get("ag_tm") or row.get("peak_tm") or "")
        event = {
            "height_ft": round(height, 2),
            "date": date_value,
            "display_date": datetime.strptime(date_value, "%Y-%m-%d").strftime("%B %-d, %Y"),
            "datum": "NAVD88",
            "site_no": station["site_no"],
            "station_name": station["station_name"],
            "station_short": station["station_short"],
            "source_area": station["source_area"],
            "station_priority": station["station_priority"],
            "record_type": "USGS annual storm-tide crest",
            "source_url": peak_url(station["site_no"]),
        }
        if time_value:
            event["time_est"] = time_value
        events.append(event)
    return events


def build() -> dict:
    events = [dict(event) for event in MANUAL_EVENTS]
    events.extend(event for station in STATIONS for event in parse_station_rows(station))
    events = [
        event
        for event in events
        if event.get("date") != "2016-01-23"
        or event.get("source_area") == "north-wildwood-calibrated"
    ]
    events.sort(
        key=lambda event: (
            -float(event["height_ft"]),
            event["date"],
            -int(event["station_priority"]),
        )
    )
    return {
        "schema": "usgs-nwis-north-wildwood-crests-v1",
        "datum": "NAVD88",
        "minimumIncludedStageFt": MINOR_FLOOD_NAVD88_FT,
        "thresholdsNAVD88": {"minorLow": 3.25, "moderateLow": 4.25, "majorLow": 5.25},
        "thresholdsMLLW": {"minorLow": 6.00, "moderateLow": 7.00, "majorLow": 8.00},
        "navd88OffsetFromMllwFt": -2.75,
        "stations": list(STATIONS),
        "toptides": events,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("toptides.json"))
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    payload = build()
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "stationCount": len(payload["stations"]),
                "crestCount": len(payload["toptides"]),
            },
            indent=2,
        )
    )
