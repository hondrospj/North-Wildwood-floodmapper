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
from fetch_petss import interpolate_15_minutes  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
