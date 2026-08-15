#!/usr/bin/env python3
"""Reusable lowest-road feeder routing for conditional flood connectivity.

The caller supplies aligned arrays, so the algorithm is independent of town,
CRS, raster dimensions, source threshold, and penalty formula. The source mask
is expected to have already applied the town's source qualification rule (for
North Wildwood: terrain <= 2.00 ft NAVD88 and at least 101 connected cells).
"""

from __future__ import annotations

import heapq

import numpy as np
from scipy.ndimage import binary_dilation, label as ndimage_label


FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    (
        (0, 1, 0),
        (1, 1, 1),
        (0, 1, 0),
    ),
    dtype=np.uint8,
)


def _require_aligned(*arrays: np.ndarray) -> tuple[int, int]:
    if not arrays or arrays[0].ndim != 2:
        raise ValueError("Conditional-connectivity arrays must be two-dimensional")
    shape = arrays[0].shape
    if any(array.shape != shape for array in arrays[1:]):
        raise ValueError(
            "Conditional-connectivity arrays are not aligned: "
            + ", ".join(str(array.shape) for array in arrays)
        )
    return shape


def _retain_source_connected(
    flooded: np.ndarray,
    source: np.ndarray,
) -> np.ndarray:
    labels, component_count = ndimage_label(
        flooded,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return flooded
    source_labels = np.unique(labels[flooded & source])
    source_labels = source_labels[source_labels > 0]
    keep = np.zeros(component_count + 1, dtype=bool)
    keep[source_labels] = True
    return flooded & keep[labels]


def connect_penalty_basins_by_lowest_road_route(
    adjusted_flooded: np.ndarray,
    baseline_flooded: np.ndarray,
    qualified_source: np.ndarray,
    public_road_corridor: np.ndarray,
    ground_elevation: np.ndarray,
    feeder_half_width_cells: int = 1,
) -> tuple[np.ndarray, np.ndarray, dict[str, int | float | str]]:
    """Connect penalty-separated basins by their lowest eligible road route.

    The route starts only where an adjusted-wet qualified source cell overlaps
    or shares a side with an eligible road. A priority flood minimizes the
    maximum ground elevation encountered (the controlling route crest), then
    minimizes path length among equal-crest alternatives. This is a physical
    lowest-route criterion, not an unconstrained geometric shortcut.

    Only road pixels inside ``baseline_flooded`` may be painted. A detached
    basin without such a source-to-road-to-basin route is removed from visible
    blue and remains penalty-held uncertainty. The default half-width of one
    display cell produces a feeder up to three display cells wide.
    """
    _require_aligned(
        adjusted_flooded,
        baseline_flooded,
        qualified_source,
        public_road_corridor,
        ground_elevation,
    )
    if feeder_half_width_cells < 0:
        raise ValueError("feeder_half_width_cells cannot be negative")

    adjusted = np.asarray(adjusted_flooded, dtype=bool)
    baseline = np.asarray(baseline_flooded, dtype=bool)
    source = np.asarray(qualified_source, dtype=bool)
    roads = np.asarray(public_road_corridor, dtype=bool)
    ground = np.asarray(ground_elevation, dtype=np.float32)
    empty = np.zeros(adjusted.shape, dtype=bool)

    labels, component_count = ndimage_label(
        adjusted,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return adjusted, empty, {
            "detachedComponentsJoined": 0,
            "detachedComponentsRoadUnreachable": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
            "maximumFeederRouteCrestFt": 0.0,
            "routeCriterion": "minimum crest, then minimum length",
        }

    source_labels = np.unique(labels[adjusted & source])
    source_labels = source_labels[source_labels > 0]
    detached_labels = np.setdiff1d(
        np.arange(1, component_count + 1, dtype=np.int32),
        source_labels,
        assume_unique=True,
    )
    if detached_labels.size == 0:
        return adjusted, empty, {
            "detachedComponentsJoined": 0,
            "detachedComponentsRoadUnreachable": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
            "maximumFeederRouteCrestFt": 0.0,
            "routeCriterion": "minimum crest, then minimum length",
        }

    route_domain = baseline & roads & np.isfinite(ground)
    adjusted_source_water = adjusted & source
    route_origin = route_domain & (
        adjusted_source_water
        | binary_dilation(
            adjusted_source_water,
            structure=FOUR_NEIGHBOUR_STRUCTURE,
        )
    )
    height, width = adjusted.shape
    pixel_count = height * width
    flat_route = route_domain.ravel()
    flat_ground = ground.ravel()
    route_crest = np.full(pixel_count, np.inf, dtype=np.float32)
    route_length = np.full(
        pixel_count,
        np.iinfo(np.int32).max,
        dtype=np.int32,
    )
    predecessor = np.full(pixel_count, -1, dtype=np.int32)
    queue: list[tuple[float, int, int]] = []
    for position in np.flatnonzero(route_origin):
        position = int(position)
        crest = float(flat_ground[position])
        route_crest[position] = crest
        route_length[position] = 0
        heapq.heappush(queue, (crest, 0, position))

    while queue:
        crest, length, position = heapq.heappop(queue)
        if (
            crest != float(route_crest[position])
            or length != int(route_length[position])
        ):
            continue
        y, x = divmod(position, width)
        for neighbor in (
            position - width if y > 0 else -1,
            position - 1 if x > 0 else -1,
            position + 1 if x + 1 < width else -1,
            position + width if y + 1 < height else -1,
        ):
            if neighbor < 0 or not flat_route[neighbor]:
                continue
            next_crest = max(crest, float(flat_ground[neighbor]))
            next_length = length + 1
            if (
                next_crest < float(route_crest[neighbor])
                or (
                    next_crest == float(route_crest[neighbor])
                    and next_length < int(route_length[neighbor])
                )
            ):
                route_crest[neighbor] = next_crest
                route_length[neighbor] = next_length
                predecessor[neighbor] = position
                heapq.heappush(
                    queue,
                    (next_crest, next_length, neighbor),
                )

    detached_lookup = np.zeros(component_count + 1, dtype=bool)
    detached_lookup[detached_labels] = True
    target_positions: list[np.ndarray] = []
    target_labels: list[np.ndarray] = []
    position_grid = np.arange(pixel_count, dtype=np.int32).reshape(adjusted.shape)
    for route_view, label_view, position_view in (
        (route_domain, labels, position_grid),
        (route_domain[:-1, :], labels[1:, :], position_grid[:-1, :]),
        (route_domain[1:, :], labels[:-1, :], position_grid[1:, :]),
        (route_domain[:, :-1], labels[:, 1:], position_grid[:, :-1]),
        (route_domain[:, 1:], labels[:, :-1], position_grid[:, 1:]),
    ):
        touches_detached = route_view & detached_lookup[label_view]
        if np.any(touches_detached):
            target_positions.append(position_view[touches_detached])
            target_labels.append(label_view[touches_detached])

    paths = np.zeros(adjusted.shape, dtype=bool)
    maximum_length = 0
    maximum_crest = 0.0
    if target_positions:
        candidates = np.concatenate(target_positions)
        candidate_labels = np.concatenate(target_labels)
        reachable = np.isfinite(route_crest[candidates])
        candidates = candidates[reachable]
        candidate_labels = candidate_labels[reachable]
        if candidates.size:
            ordering = np.lexsort(
                (
                    route_length[candidates],
                    route_crest[candidates],
                    candidate_labels,
                )
            )
            ordered_labels = candidate_labels[ordering]
            first_for_label = np.concatenate(
                (
                    np.asarray([True]),
                    ordered_labels[1:] != ordered_labels[:-1],
                )
            )
            endpoints = candidates[ordering][first_for_label]
            maximum_length = int(
                np.max(route_length[endpoints], initial=0)
            )
            maximum_crest = float(
                np.max(route_crest[endpoints], initial=0.0)
            )
            flat_paths = paths.ravel()
            for endpoint in endpoints:
                position = int(endpoint)
                while position >= 0 and not flat_paths[position]:
                    flat_paths[position] = True
                    position = int(predecessor[position])

    widened_paths = paths
    for _ in range(feeder_half_width_cells):
        widened_paths = binary_dilation(
            widened_paths,
            structure=FOUR_NEIGHBOUR_STRUCTURE,
        )
    feeder = widened_paths & roads & baseline & ~adjusted
    if np.any(feeder & ~roads):
        raise RuntimeError("A lowest-route feeder escaped the public-road corridor")

    flooded = _retain_source_connected(adjusted | feeder, source)
    feeder &= flooded
    joined_labels = np.unique(labels[flooded & adjusted])
    joined_labels = joined_labels[joined_labels > 0]
    joined_detached = np.intersect1d(
        joined_labels,
        detached_labels,
        assume_unique=False,
    )
    return flooded, feeder, {
        "detachedComponentsJoined": int(joined_detached.size),
        "detachedComponentsRoadUnreachable": int(
            detached_labels.size - joined_detached.size
        ),
        "feederPixels": int(np.count_nonzero(feeder)),
        "maximumFeederLengthPixels": maximum_length,
        "maximumFeederRouteCrestFt": maximum_crest,
        "routeCriterion": "minimum crest, then minimum length",
    }
