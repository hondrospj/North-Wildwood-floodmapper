#!/usr/bin/env python3
"""Focused regression checks for the phase-aware developed-land penalty."""

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
        4.25: 0.25,
        5.25: 0.00,
        6.00: 0.00,
    }
    for stage, penalty in expected.items():
        actual = model.vertical_penalty_ft(stage)
        if not np.isclose(actual, penalty, atol=1e-12):
            raise AssertionError(
                f"Penalty at {stage:.2f} ft is {actual:.6f}, expected {penalty:.6f}"
            )

    sampled = np.asarray(
        [
            model.vertical_penalty_ft(stage)
            for stage in np.arange(
                model.MINOR_NAVD88_FT,
                model.MAJOR_NAVD88_FT + 0.05,
                0.1,
            )
        ]
    )
    if np.any(np.diff(sampled) > 1e-12):
        raise AssertionError("Polynomial penalty is not monotonically decreasing")
    if model.stage_code(3.90) != "p0390" or model.stage_code(4.00) != "p0400":
        raise AssertionError("Tenth-foot stage filenames are encoded incorrectly")
    if (
        len(model.STAGES_FT) != 201
        or not np.isclose(model.STAGES_FT[1], 0.1)
        or not np.isclose(model.STAGES_FT[-1], 20.0)
    ):
        raise AssertionError("The stage catalog is not a complete 0.1-ft grid")

    stage = 4.25
    ground = np.asarray([4.00, 4.00], dtype=np.float64)
    developed = np.asarray([True, False])
    rising = model.penalized_connected_depth_ft(
        stage, ground, developed, "filling"
    )
    draining = model.penalized_connected_depth_ft(
        stage, ground, developed, "draining"
    )
    slack = model.penalized_connected_depth_ft(
        stage, ground, developed, "slack"
    )
    if not np.allclose(rising, [0.0, 0.25]):
        raise AssertionError(f"Unexpected rising depths: {rising}")
    if not np.allclose(draining, [0.50, 0.25]):
        raise AssertionError(f"Unexpected recession-retention depths: {draining}")
    if not np.allclose(slack, [0.25, 0.25]):
        raise AssertionError(f"Unexpected high-tide release depths: {slack}")
    if not np.isclose(
        model.phase_adjusted_stage_ft(stage, "slack", True), 4.25
    ):
        raise AssertionError("The developed-land penalty did not wear off at slack tide")
    if not np.isclose(
        model.phase_adjusted_stage_ft(stage, "draining", True), 4.50
    ):
        raise AssertionError("The developed-land drainage lag has the wrong sign")

    phases, diagnostics = model.simulate(FakeSolver())
    if not np.array_equal(phases["filling"], phases["slack"]):
        raise AssertionError("Filling and slack states differ")
    if not np.array_equal(phases["filling"], phases["draining"]):
        raise AssertionError("Filling and draining states differ")
    if diagnostics.get("phaseInvariant") is not False:
        raise AssertionError("Simulation diagnostics incorrectly claim phase invariance")

    stage_30_surface = float(phases["slack"][30, 1]) / 100.0
    if not np.isclose(stage_30_surface, 3.00, atol=0.005):
        raise AssertionError(
            f"3.0-ft gauge stage produced {stage_30_surface:.2f}-ft water surface"
        )
    if diagnostics.get("modelKind") != "phase-aware developed-land conditional connectivity":
        raise AssertionError("Simulation diagnostics declare the wrong model")
    print("North Wildwood phase-aware conditional-connectivity checks passed")


if __name__ == "__main__":
    main()
