#!/usr/bin/env python3
"""Focused regression checks for the connectivity-first depth penalty."""

from __future__ import annotations

import numpy as np

import simulate_north_wildwood_hydraulics as model


class FakeSolver:
    zone_count = 2

    def equilibrium(self, stage: float) -> tuple[np.ndarray, np.ndarray]:
        storage = np.asarray([1.0, 0.0], dtype=np.float64)
        surface = np.asarray([stage, stage], dtype=np.float64)
        return storage, surface

    def encode_surface(
        self,
        storage: np.ndarray,
        surface: np.ndarray,
    ) -> np.ndarray:
        encoded = np.full(3, model.DRY_SENTINEL, dtype="<i2")
        encoded[1] = round(float(surface[0]) * 100.0)
        return encoded


def main() -> None:
    expected = {
        3.00: 0.75,
        3.25: 0.75,
        4.25: 0.35,
        5.25: 0.00,
        6.00: 0.00,
    }
    for stage, penalty in expected.items():
        actual = model.vertical_penalty_ft(stage)
        if not np.isclose(actual, penalty, atol=1e-12):
            raise AssertionError(
                f"Penalty at {stage:.2f} ft is {actual:.6f}, expected {penalty:.6f}"
            )

    stage = 4.20
    ground = np.asarray([4.10, 3.90, 3.50, 3.00], dtype=np.float64)
    raw_depth = stage - ground
    depth = model.penalized_connected_depth_ft(stage, ground)
    if np.any(depth <= 0):
        raise AssertionError("The depth penalty erased connected shallow water")
    if np.any(depth > raw_depth + 1e-12):
        raise AssertionError("The depth penalty increased raw bathtub depth")
    retained_fraction = np.divide(
        depth,
        raw_depth,
        out=np.ones_like(depth),
        where=raw_depth > 0,
    )
    if np.any(
        retained_fraction
        < model.MIN_CONNECTED_DEPTH_RETAINED_FRACTION - 1e-12
    ):
        raise AssertionError("The bounded penalty retained too little connected depth")
    if not np.isclose(depth[0], 0.025, atol=1e-12):
        raise AssertionError(
            f"A 0.10-ft connected fringe retained {depth[0]:.4f} ft, expected 0.025 ft"
        )

    phases, diagnostics = model.simulate(FakeSolver())
    if not np.array_equal(phases["filling"], phases["slack"]):
        raise AssertionError("Filling and slack states differ")
    if not np.array_equal(phases["filling"], phases["draining"]):
        raise AssertionError("Filling and draining states differ")
    if diagnostics.get("phaseInvariant") is not True:
        raise AssertionError("Simulation diagnostics omit phase invariance")

    stage_30_surface = float(phases["slack"][30, 1]) / 100.0
    if not np.isclose(stage_30_surface, 3.00, atol=0.005):
        raise AssertionError(
            f"3.0-ft gauge stage produced {stage_30_surface:.2f}-ft water surface"
        )
    if diagnostics.get("modelKind") != "connectivity-first depth-penalized bathtub":
        raise AssertionError("Simulation diagnostics declare the wrong model")
    print("North Wildwood connectivity-first depth-penalty checks passed")


if __name__ == "__main__":
    main()
