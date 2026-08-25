#!/usr/bin/env python3
"""Focused regression checks for the Stone Harbor observed-data updater."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from update_observed_15min import (
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

    def test_does_not_bridge_distant_neighbors(self) -> None:
        distant = [(0, 0.5), (3600, 8.0), (7200, 0.6)]

        self.assertEqual(remove_isolated_spikes(distant), distant)


if __name__ == "__main__":
    unittest.main()
