#!/usr/bin/env python3
"""Focused regression checks for the Stone Harbor observed-data updater."""

from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

from update_historic_crests import build as build_crests

from update_observed_15min import (
    build,
    interpolate_at,
    parse_usgs_values,
    remove_isolated_spikes,
)


def epoch(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


class ObservedUpdaterTests(unittest.TestCase):
    def test_rejects_august_23_provisional_record_spike(self) -> None:
        source_rows = [
            {"dateTime": "2026-08-23T14:24:00-04:00", "value": "0.74"},
            {"dateTime": "2026-08-23T14:30:00-04:00", "value": "8.82"},
            {"dateTime": "2026-08-23T14:36:00-04:00", "value": "0.85"},
            {"dateTime": "2026-08-23T18:24:00", "value": "0.20"},  # No unambiguous instant.
        ]
        payload = {"value": {"timeSeries": [{"values": [{"value": source_rows}]}]}}

        cleaned = parse_usgs_values(payload)

        self.assertEqual(
            cleaned,
            [
                (epoch("2026-08-23T18:24:00"), 0.74),
                (epoch("2026-08-23T18:36:00"), 0.85),
            ],
        )
        interpolated = interpolate_at(
            epoch("2026-08-23T18:30:00"),
            [row[0] for row in cleaned],
            [row[1] for row in cleaned],
        )
        self.assertIsNotNone(interpolated)
        assert interpolated is not None
        self.assertAlmostEqual(interpolated, 0.795)

    def test_keeps_gradual_or_sustained_high_water(self) -> None:
        gradual = [(0, 0.5), (360, 2.0), (720, 3.1)]
        sustained = [(0, 0.5), (360, 4.0), (720, 4.1), (1080, 0.7)]

        self.assertEqual(remove_isolated_spikes(gradual), gradual)
        self.assertEqual(remove_isolated_spikes(sustained), sustained)

    def test_empty_response_keeps_previous_archive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "stone.json"
            original = json.dumps({"days": [{"d": "2026-08-23", "v": [60]}]})
            archive.write_text(original)
            args = argparse.Namespace(output=archive, start_date=None, end_date=date(2026, 8, 23),
                                      full=False, update_hourly=False)
            with patch("update_observed_15min.fetch_json", return_value={"value": {"timeSeries": []}}):
                with self.assertRaisesRegex(RuntimeError, "erase existing readings for 2026-08-23"):
                    build(args)
            self.assertEqual(archive.read_text(), original)

    def test_empty_crest_response_stops_before_writing(self) -> None:
        with patch("update_historic_crests.fetch_text", return_value="agency_cd\tsite_no\n5s\t15s\n"):
            with self.assertRaisesRegex(RuntimeError, "returned no usable flood crests"):
                build_crests()

    def test_crest_height_and_time_come_from_the_same_record(self) -> None:
        raw = ("peak_dt\tpeak_tm\tgage_ht\tag_dt\tag_tm\tag_gage_ht\n"
               "10d\t6s\t8s\t10d\t6s\t8s\n"
               "2025-03-04\t1015\t4.20\t2025-04-05\t\t\n"
               "2026-03-04\t1015\t4.20\t2026-04-05\t\t4.80\n")
        with patch("update_historic_crests.fetch_text", return_value=raw):
            events = {row["date"]: row for row in build_crests()["toptides"]}
        self.assertNotIn("2025-04-05", events)
        self.assertEqual(events["2025-03-04"]["time_est"], "10:15")
        self.assertEqual(events["2025-03-04"]["display_date"], "March 4, 2025")
        self.assertEqual(events["2026-04-05"]["height_ft"], 4.80)
        self.assertNotIn("time_est", events["2026-04-05"])

    def test_truncated_response_keeps_previous_day(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "stone.json"
            day = date(2026, 8, 23)
            original = json.dumps({"days": [{"d": day.isoformat(), "v": [60] * 96}]})
            archive.write_text(original)
            args = argparse.Namespace(output=archive, start_date=day, end_date=day, full=False, update_hourly=False)
            rows = [{"dateTime": f"2026-08-23T00:{minute:02}:00-04:00", "value": "0.60"}
                    for minute in (0, 15, 30)]
            payload = {"value": {"timeSeries": [{"values": [{"value": rows}]}]}}
            with patch("update_observed_15min.fetch_json", return_value=payload):
                with self.assertRaisesRegex(RuntimeError, "erase existing readings for 2026-08-23"):
                    build(args)
            self.assertEqual(archive.read_text(), original)

    def test_does_not_bridge_distant_neighbors(self) -> None:
        distant = [(0, 0.5), (3600, 8.0), (7200, 0.6)]

        self.assertEqual(remove_isolated_spikes(distant), distant)


if __name__ == "__main__":
    unittest.main()
