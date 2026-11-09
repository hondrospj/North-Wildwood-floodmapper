"""The lowest road crest must break ties by the full route length."""
import numpy as np

from conditional_connectivity_routes import connect_penalty_basins_by_lowest_road_route


def check_route(roads, ground, adjusted, source):
    flooded, feeder, diagnostics = connect_penalty_basins_by_lowest_road_route(
        adjusted,
        adjusted | roads,
        source,
        roads,
        ground,
        penalized_uncertainty=roads,
        feeder_half_width_cells=0,
    )
    assert np.array_equal(flooded, adjusted | feeder)
    assert diagnostics["maximumFeederRouteCrestFt"] == 4
    assert diagnostics["maximumFeederLengthPixels"] == 10, diagnostics
    return feeder, diagnostics


if __name__ == "__main__":
    roads = np.zeros((15, 15), dtype=bool)
    roads[7, 1:12] = True
    roads[3:8, 1] = True
    roads[3, 1:8] = True
    roads[3:8, 7] = True
    ground = np.ones(roads.shape, dtype=np.float32)
    # The direct route crosses a 3-ft bump. Both routes later encounter the
    # 4-ft crest, so the earlier 1-ft detour cannot justify extra length.
    ground[7, 3] = 3
    ground[7, 9] = 4

    source = np.zeros_like(roads)
    source[7, 0] = True
    adjusted = source.copy()
    adjusted[7, 12] = True
    feeder, diagnostics = check_route(roads, ground, adjusted, source)
    assert diagnostics["detachedComponentsJoined"] == 1
    assert np.array_equal(feeder[7], roads[7]) and not feeder[3].any()

    # The mirror puts the common crest last in the bridge endpoint ordering.
    # The existing off-road wet area touches both ends and requires no feeder
    # from the qualified source, so this independently exercises local routing.
    source = np.zeros_like(roads)
    source[8, 0] = True
    adjusted = np.zeros_like(roads)
    adjusted[8] = True
    feeder, diagnostics = check_route(roads[:, ::-1], ground[:, ::-1], adjusted, source)
    assert diagnostics["sourceConnectedRoadGapsBridged"] == 1
    assert diagnostics["roadWaterComponentsRouted"] == 0
    assert np.array_equal(feeder[7], roads[7, ::-1]) and not feeder[3].any()
    print("Shortest equal-crest road and local bridge routes passed")
