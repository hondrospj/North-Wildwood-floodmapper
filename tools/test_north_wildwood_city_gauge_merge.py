#!/usr/bin/env python3
"""Focused regression checks for the city-primary observed-gauge merge."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from merge_north_wildwood_city_gauge import (
    hourly_day_from_compact,
    load_city_readings,
    merge_compact_days,
    timestamp_second,
)


def epoch(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


class CityGaugeMergeTests(unittest.TestCase):
    def test_city_wall_time_is_converted_from_eastern_time(self) -> None:
        self.assertEqual(
            timestamp_second("2017-09-01 08:58:00"),
            epoch("2017-09-01T12:58:00"),
        )

    def test_city_values_win_and_stone_fills_real_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            city_dir = Path(directory)
            payload = {
                "readings": [
                    ["2017-09-01 09:00:00", 5.0],
                    ["2017-09-01 09:00:00", 5.2],
                    ["2017-09-01 09:15:00", 5.5],
                    ["2017-09-01 09:30:00", 9.0],
                    ["2017-09-01 09:45:00", 5.7],
                    ["2017-09-01 10:30:00", 6.0],
                ]
            }
            (city_dir / "2017.json").write_text(json.dumps(payload), encoding="utf-8")
            city, quality = load_city_readings(city_dir)

        self.assertEqual(quality["duplicateRows"], 1)
        self.assertEqual(quality["isolatedSpikes"], 1)
        stone = {
            "days": [
                {
                    "d": "2017-09-01",
                    "u": epoch("2017-09-01T13:00:00"),
                    "v": [100, 110, 120, 130, 140, 150, 160],
                    "p": 160,
                    "c": "none",
                }
            ]
        }
        days, counts = merge_compact_days(stone, city)
        day = days[0]
        self.assertEqual(day["v"][:4], [235, 275, 285, 295])
        self.assertEqual(day["v"][4], 140)
        self.assertEqual(day["n"], 5)
        self.assertEqual(day["f"], 2)
        self.assertEqual(counts["cityQuarterHours"], 5)
        self.assertEqual(counts["stoneFallbackQuarterHoursWithinCityCoverage"], 2)

    def test_hourly_peak_comes_from_merged_quarters(self) -> None:
        day = {
            "d": "2017-09-01",
            "u": epoch("2017-09-01T13:00:00"),
            "v": [235, 275, 285, 295, 140],
            "p": 295,
            "c": "none",
        }
        hourly = hourly_day_from_compact(day)
        self.assertIsNotNone(hourly)
        assert hourly is not None
        self.assertEqual(hourly["peakNAVD88"], 2.95)
        self.assertEqual(hourly["hours"][0]["navd88StageFt"], 2.95)
        self.assertEqual(hourly["hours"][1]["navd88StageFt"], 1.4)


if __name__ == "__main__":
    unittest.main()
