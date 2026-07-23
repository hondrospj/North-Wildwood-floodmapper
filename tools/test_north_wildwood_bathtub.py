#!/usr/bin/env python3
"""Focused regression checks for the vertically penalized bathtub."""

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

    effective = np.asarray(
        [model.effective_bathtub_stage_ft(float(stage)) for stage in model.STAGES_FT]
    )
    if np.any(np.diff(effective) <= 0):
        raise AssertionError("Effective bathtub stage is not strictly increasing")

    phases, diagnostics = model.simulate(FakeSolver())
    if not np.array_equal(phases["filling"], phases["slack"]):
        raise AssertionError("Filling and slack states differ")
    if not np.array_equal(phases["filling"], phases["draining"]):
        raise AssertionError("Filling and draining states differ")
    if diagnostics.get("phaseInvariant") is not True:
        raise AssertionError("Simulation diagnostics omit phase invariance")

    stage_30_surface = float(phases["slack"][30, 1]) / 100.0
    if not np.isclose(stage_30_surface, 2.25, atol=0.005):
        raise AssertionError(
            f"3.0-ft gauge stage produced {stage_30_surface:.2f}-ft water surface"
        )
    print("North Wildwood vertically penalized bathtub regression checks passed")


if __name__ == "__main__":
    main()
