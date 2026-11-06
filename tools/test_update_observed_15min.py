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

    def test_does_not_bridge_distant_neighbors(self) -> None:
        distant = [(0, 0.5), (3600, 8.0), (7200, 0.6)]

        self.assertEqual(remove_isolated_spikes(distant), distant)


if __name__ == "__main__":
    unittest.main()
