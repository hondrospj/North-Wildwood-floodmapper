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
    if not np.allclose(draining, [0.3125, 0.25]):
        raise AssertionError(f"Unexpected recession-retention depths: {draining}")
    if not np.allclose(slack, [0.25, 0.25]):
        raise AssertionError(f"Unexpected high-tide release depths: {slack}")
    if not np.isclose(
        model.phase_adjusted_stage_ft(stage, "slack", True), 4.25
    ):
        raise AssertionError("The developed-land penalty did not wear off at slack tide")
    if not np.isclose(
        model.phase_adjusted_stage_ft(stage, "draining", True), 4.3125
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

    # Distance must originate only at the immutable qualified source block.
    # A downstream wet/feeder cell is deliberately present in the traversable
    # path but cannot reset the cumulative source distance.
    source_block = np.zeros((7, 9), dtype=bool)
    source_block[3, 1:3] = True
    traversable = np.zeros_like(source_block)
    traversable[3, 1:8] = True
    traversable[1:4, 6] = True
    source_distance, distance_diagnostics = (
        model.source_block_geodesic_distance(
            source_block,
            traversable,
            cell_size_ft=5,
        )
    )
    if not np.all(source_distance[source_block] == 0):
        raise AssertionError("Qualified source-block distance is not zero")
    if not np.isclose(source_distance[3, 7], 25.0):
        raise AssertionError("Downstream water incorrectly reset source distance")
    if not np.isclose(source_distance[1, 6], 30.0):
        raise AssertionError("Source distance did not follow shared-side travel")
    if distance_diagnostics["method"] != (
        "four-neighbour geodesic distance from immutable qualified source blocks"
    ):
        raise AssertionError("Source-distance field declares the wrong origin")

    near_depth = model.penalized_connected_depth_ft(
        4.25,
        4.0,
        True,
        "filling",
        source_distance_ft=0.0,
    )
    far_depth = model.penalized_connected_depth_ft(
        4.25,
        4.0,
        True,
        "filling",
        source_distance_ft=model.SOURCE_DISTANCE_FULL_PENALTY_FT,
    )
    if not near_depth > far_depth:
        raise AssertionError("Flood depth does not decrease with source travel")
    if model.distance_penalty_stage_scale(4.75) != 0:
        raise AssertionError("Distance penalty persists beyond the requested stage")

    # Visible feeders must follow the supplied public-road corridor exactly.
    adjusted = np.zeros((9, 15), dtype=bool)
    adjusted[3:6, 1:4] = True
    adjusted[3:6, 11:14] = True
    baseline = adjusted.copy()
    baseline[4, 3:12] = True
    source = np.zeros_like(adjusted)
    source[4, 2] = True
    road = np.zeros_like(adjusted)
    road[4, :] = True
    flooded, feeder, feeder_diagnostics = model.add_visible_source_feeders(
        adjusted,
        baseline,
        source,
        road,
    )
    if np.any(feeder & ~road):
        raise AssertionError("Synthetic feeder escaped the public-road corridor")
    if not np.all(flooded[3:6, 11:14]):
        raise AssertionError("Road-reachable detached basin was not joined")
    if feeder_diagnostics["detachedComponentsJoined"] != 1:
        raise AssertionError("Road-reachable component count is incorrect")

    broken_road = road.copy()
    broken_road[4, 7] = False
    flooded, feeder, feeder_diagnostics = model.add_visible_source_feeders(
        adjusted,
        baseline,
        source,
        broken_road,
    )
    if np.any(flooded[3:6, 11:14]):
        raise AssertionError("Road-unreachable basin was kept blue")
    if np.any(feeder & ~broken_road):
        raise AssertionError("Feeder crossed a break in the road mask")
    if feeder_diagnostics["detachedComponentsRoadUnreachable"] != 1:
        raise AssertionError("Road-unreachable component count is incorrect")

    # A longer low road must beat a shorter high road. This makes feeder
    # selection hydraulic (minimum controlling crest), not merely geometric.
    adjusted = np.zeros((9, 15), dtype=bool)
    adjusted[3:6, 1:4] = True
    adjusted[3:6, 11:14] = True
    road = np.zeros_like(adjusted)
    road[4, 3:12] = True  # short, high route
    road[2, 3:12] = True  # longer, low route
    road[2:5, 3] = True
    road[2:5, 11] = True
    baseline = adjusted | road
    source = np.zeros_like(adjusted)
    source[4, 2] = True
    ground = np.full(adjusted.shape, 10.0, dtype=np.float32)
    ground[road] = 2.5
    ground[4, 4:11] = 4.0
    flooded, feeder, feeder_diagnostics = model.add_visible_source_feeders(
        adjusted,
        baseline,
        source,
        road,
        ground,
    )
    if not np.any(feeder[2, 5:10]):
        raise AssertionError("Lowest-road route was not selected")
    if feeder[4, 7]:
        raise AssertionError("Shorter high-road route incorrectly won")
    if not np.isclose(
        feeder_diagnostics["maximumFeederRouteCrestFt"],
        2.5,
    ):
        raise AssertionError("Lowest-route crest diagnostic is incorrect")
    print("North Wildwood phase-aware conditional-connectivity checks passed")


if __name__ == "__main__":
    main()
