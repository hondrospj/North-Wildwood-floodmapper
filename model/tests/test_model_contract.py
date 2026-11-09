#!/usr/bin/env python3
"""Executable hydraulic invariants for the North Wildwood forecast model."""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from affine import Affine


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "model/src"))

from run_anuga import (  # noqa: E402
    RasterSampler,
    barrier_mask_for_mesh,
    friction_from_elevation,
)
from fetch_petss import common_hourly_window, enforce_scenario_order, interpolate_15_minutes, parse_time  # noqa: E402


def in_memory_sampler(array: np.ndarray, resolution: float = 5.0) -> RasterSampler:
    sampler = RasterSampler.__new__(RasterSampler)
    sampler.array = np.asarray(array, dtype=np.float64)
    sampler.transform = Affine(resolution, 0.0, 0.0, 0.0, -resolution, 100.0)
    sampler.nodata = None
    sampler.crs = "EPSG:6347"
    sampler.left = 0.0
    sampler.top = 100.0
    sampler.x_resolution = resolution
    sampler.y_resolution = resolution
    return sampler


class PhysicsContractTests(unittest.TestCase):
    def test_initial_water_requires_a_qualified_ocean_edge(self) -> None:
        sampler = in_memory_sampler(
            np.array(
                [
                    [2.0, -0.2, 2.0, 2.0, 2.0, 2.0, 2.0],
                    [2.0, -0.2, 2.0, -2.0, -2.0, 2.0, 2.0],
                    [2.0, 2.0, 2.0, -2.0, -2.0, 2.0, 2.0],
                    [2.0, -2.0, -2.0, 2.0, 2.0, 2.0, 2.0],
                    [2.0, -2.0, -2.0, 2.0, 2.0, 2.0, 2.0],
                ]
            )
        )
        connected = sampler.initial_connected_water(0.5, -1.0)
        self.assertTrue(connected[4, 1])
        self.assertFalse(connected[0, 1], "A shallow land edge is not an ocean source")
        self.assertFalse(connected[1, 3], "An enclosed depression must start dry")

    def test_bulkhead_is_preserved_on_the_20_m_centroid_mesh(self) -> None:
        barrier = np.zeros((21, 21), dtype=np.uint8)
        barrier[:, 10] = 1
        buffered, radius = barrier_mask_for_mesh(in_memory_sampler(barrier), 20.0)
        self.assertEqual(radius, 3)
        self.assertTrue(np.all(buffered[:, 7:14]))
        self.assertFalse(np.any(buffered[:, :7]))

    def test_manning_proxy_is_piecewise_and_finite(self) -> None:
        config = {
            "openWaterManningN": 0.025,
            "intertidalManningN": 0.035,
            "developedManningN": 0.055,
            "highGroundManningN": 0.045,
        }
        values = friction_from_elevation(np.array([-1.0, 0.0, 1.0, 4.0]), config)
        np.testing.assert_allclose(values, [0.025, 0.035, 0.055, 0.045])

    def test_production_configuration_uses_event_exact_nlswe(self) -> None:
        config = json.loads((ROOT / "model/config/north_wildwood.json").read_text())
        self.assertEqual(config["domain"]["meshCellM"], 20.0)
        self.assertEqual(config["domain"]["terrainGridM"], 5.0)
        self.assertIn("nonlinear shallow-water", config["solver"]["equations"])
        self.assertEqual(config["petss"]["outputIntervalSeconds"], 900)
        self.assertEqual(config["petss"]["scenarios"], ["mean", "lowEnd", "highEnd"])

    def test_quarter_hour_interpolation_preserves_hourly_petss_anchors(self) -> None:
        origin = datetime(2026, 8, 9, 18, tzinfo=timezone.utc)
        hourly = [
            (origin + timedelta(hours=index), value)
            for index, value in enumerate((1.0, 1.8, 1.1, 2.2))
        ]
        frames = interpolate_15_minutes(hourly, -2.75)
        for index, (_, mllw_ft) in enumerate(hourly):
            frame = frames[index * 4]
            self.assertTrue(frame["isHourlySourcePoint"])
            self.assertAlmostEqual(frame["mllwFt"], mllw_ft, places=4)

    def test_petss_offset_and_hourly_boundary_coverage(self) -> None:
        origin = datetime(2026, 8, 9, 18, tzinfo=timezone.utc)
        self.assertEqual(parse_time("2026-08-09T14:00:00-04:00"), origin)
        self.assertIsNone(parse_time("2026-08-09Z"))
        irregular = [(origin + timedelta(minutes=minutes), 2) for minutes in (0, 30, 120)]
        with self.assertRaisesRegex(RuntimeError, "consecutive common hourly points"):
            common_hourly_window({"mean": irregular}, origin, 2)
        hourly = [(origin + timedelta(hours=index), index) for index in range(3)]
        self.assertEqual(common_hourly_window({"mean": irregular + hourly}, origin, 2)["mean"], hourly)

    def test_petss_metre_order_when_rounded_feet_tie(self) -> None:
        # Stone Harbor 8535581, Nov 8 2026 18Z PETSS cycle, 05Z–08Z.
        origin = datetime(2026, 11, 9, 5, tzinfo=timezone.utc)
        source = {
            "mean": (1.095, 0.476, 0.456, 1.076),
            "highEnd": (1.195, 0.476, 0.456, 1.076),
        }
        curves = {
            scenario: interpolate_15_minutes([
                (origin + timedelta(hours=index), value)
                for index, value in enumerate(values)
            ], -2.75)
            for scenario, values in source.items()
        }
        mean, high = curves["mean"], curves["highEnd"]
        mean_before = [frame.copy() for frame in mean]
        hourly_before = [frame.copy() for frame in high if frame["isHourlySourcePoint"]]
        hidden_crossings = [
            index for index, (center, bound) in enumerate(zip(mean, high, strict=True))
            if bound["navd88M"] < center["navd88M"]
            and bound["mllwFt"] == center["mllwFt"]
            and bound["navd88Ft"] == center["navd88Ft"]
        ]
        self.assertEqual(hidden_crossings, [5, 7])
        self.assertTrue(enforce_scenario_order(curves))
        self.assertFalse(enforce_scenario_order(curves))
        self.assertEqual(mean, mean_before)
        self.assertEqual([frame for frame in high if frame["isHourlySourcePoint"]], hourly_before)
        for center, bound in zip(mean, high, strict=True):
            self.assertGreaterEqual(bound["navd88M"], center["navd88M"])

    def test_interpolated_scenario_bounds_stay_around_the_mean(self) -> None:
        origin = datetime(2026, 8, 9, 18, tzinfo=timezone.utc)
        source = {
            "mean": (1, 1, 1, 2),
            "lowEnd": (1, 0, 1, 2),
            "highEnd": (1, 2, 1, 2),
        }
        curves = {
            scenario: interpolate_15_minutes([
                (origin + timedelta(hours=index), value)
                for index, value in enumerate(values)
            ], -2.75)
            for scenario, values in source.items()
        }
        self.assertTrue(any(lo["mllwFt"] > mean["mllwFt"]
                            for lo, mean in zip(curves["lowEnd"], curves["mean"])))
        self.assertTrue(enforce_scenario_order(curves))
        self.assertFalse(enforce_scenario_order(curves))
        for low, mean, high in zip(curves["lowEnd"], curves["mean"], curves["highEnd"]):
            for field in ("mllwFt", "navd88Ft", "navd88M"):
                self.assertLessEqual(low[field], mean[field])
                self.assertLessEqual(mean[field], high[field])
        for scenario, values in source.items():
            self.assertEqual([frame["mllwFt"] for frame in curves[scenario] if frame["isHourlySourcePoint"]],
                             list(values))


if __name__ == "__main__":
    unittest.main()
