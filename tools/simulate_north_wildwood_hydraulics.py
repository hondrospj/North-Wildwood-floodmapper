#!/usr/bin/env python3
"""Build North Wildwood's history-aware finite-volume hydraulic PNG atlas.

The one-foot conditioned DEM is aggregated into ten-foot storage cells while
retaining its elevation hypsometry and all shared one-foot flow widths. The
qualified complete <=2.0-ft tidal fields are fixed-head boundary; supplied
polygons mark components but never paint source geometry, and every higher DEM
cell is finite storage even when enclosed by a low tidal field. Source cells are isolated
from terrain control volumes, so a one-foot opening exchanges water through
its actual shared face instead of pinning a whole tile to the tide.
Water is routed in 60-second substeps with a mass-conserving hybrid
diffusive-wave scheme. Ordinary overland conveyance follows Manning's
equation over the actual one-foot face elevations. A broad-crested-weir
capacity is retained only as an upper bound where a face is free-flowing over
a sill. This prevents the old model from treating every street-scale face as
an unconstrained weir. Strict donor, receiver, wetting-depth, and conservation
limits prevent a numerically insignificant film from advancing across the
city. A cell that becomes wet during a substep cannot donate until the
following substep.

The expensive solve is run once to build three observed-rise-rate families, a
short-crest family, three preceding-crest recession families from 0.0 through
10.0 ft NAVD88 at 0.1-foot increments, and one compact March 1962 maximum-
extent state driven by five successive high tides. Forecast and observed
updates only choose a stored history family and stage PNG; no live tide cycle
runs a hydraulic simulation. Planning levels above ten feet retain the
previous atlas as a browser fallback. Storm drains stay disabled, and the
conditioned 21-cell-wide, 7.5-ft NAVD88 bulkhead is honored.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image
from scipy.ndimage import gaussian_filter


gdal.UseExceptions()

WIDTH = 10_930
HEIGHT = 14_120
RENDER_STRIDE = 5
MODEL_MIN_STAGE_FT = 0.0
MODEL_MAX_STAGE_FT = 10.0
MODEL_STAGE_STEP_FT = 0.1
STAGES_FT = np.round(
    np.arange(
        MODEL_MIN_STAGE_FT,
        MODEL_MAX_STAGE_FT + MODEL_STAGE_STEP_FT / 2.0,
        MODEL_STAGE_STEP_FT,
    ),
    1,
)
DRY_SENTINEL = np.int16(-32768)
HIST_MIN10 = -100
HIST_MAX10 = 220
HIST_COUNT = HIST_MAX10 - HIST_MIN10 + 1
MODEL_STEP_SECONDS = 60
TIDE_STEP_SECONDS = 15 * 60
BROAD_CRESTED_WEIR_CFS = 3.10
MANNING_US_CUSTOMARY = 1.486
URBAN_OVERLAND_MANNING_N = 0.12
MIN_MOBILE_DEPTH_FT = 0.05
MIN_DISPLAY_DEPTH_FT = 0.05
MINOR_NAVD88_FT = 3.25
MODERATE_NAVD88_FT = 4.25
MAJOR_NAVD88_FT = 5.25
SOURCE_BLOCK_MAX_NAVD88_FT = 2.0
# Two feet defines boundary geometry, not a synthetic sill or activation
# stage. The fixed-head field follows the tide continuously and exchanges
# across the real shared-face elevations.
SOURCE_BLOCK_ACTIVATION_NAVD88_FT = None
SHORT_CREST_MINUTES = 15
RISE_RATE_FAMILIES_FT_PER_HOUR = {
    "rising_slow": 0.55,
    "rising_typical": 0.79,
    "rising_fast": 0.90,
}
FALLING_CREST_FAMILIES_FT = {
    "falling_minor": 4.0,
    "falling_moderate": 5.5,
    "falling_extreme": 8.5,
}
OPERATIONAL_ATLAS_FAMILIES = (
    *RISE_RATE_FAMILIES_FT_PER_HOUR,
    "crest",
    *FALLING_CREST_FAMILIES_FT,
)
HISTORIC_1962_FAMILY = "historic_1962_five_tides"
HISTORIC_1962_STAGE_FT = 7.5
HISTORIC_1962_STAGE_INDEX = int(
    round(HISTORIC_1962_STAGE_FT / MODEL_STAGE_STEP_FT)
)
ATLAS_FAMILIES = (*OPERATIONAL_ATLAS_FAMILIES, HISTORIC_1962_FAMILY)

# The City hazard-mitigation plan describes the March 1962 northeaster as
# lasting for five high tides. These rounded extrema retain that duration and
# the dashboard's calibrated 7.5-ft NAVD88 local crest. They are an offline
# design hydrograph, not invented quarter-hour observations.
HISTORIC_1962_EXTREMA = (
    (0.00, 0.0),
    (6.21, 4.2),
    (12.42, 0.8),
    (18.63, 5.2),
    (24.84, 1.5),
    (31.05, 6.1),
    (37.26, 2.2),
    (43.47, 6.9),
    (49.68, 3.0),
    (55.89, HISTORIC_1962_STAGE_FT),
)

DEPTH_BREAKS_FT = np.asarray([0.10, 0.25, 0.50, 1.00, 1.50, 2.00, 2.50, 3.00, 4.00, 5.00])
DEPTH_COLORS = [
    "#7DF9FF",
    "#5DE7FF",
    "#38D3FF",
    "#1BB7F5",
    "#168CEB",
    "#156BE0",
    "#1853C6",
    "#173EA8",
    "#132F84",
    "#0B1E5B",
    "#050E33",
]
STAGE_COLORS = ["#F4A742", "#E74C3C", "#7D3C98"]
COVERAGE_ALPHA_LEVELS = (72, 132, 192, 225)
COVERAGE_BREAKS = np.asarray([0.25, 0.50, 0.75], dtype=np.float32)
RENDER_CELL_DTYPE = np.dtype(
    [
        ("terrain_zone0", "<i4"),
        ("terrain_zone1", "<i4"),
        ("source_zone", "<i4"),
        ("terrain_ground_sum10_0", "<i4"),
        ("terrain_ground_sum10_1", "<i4"),
        ("source_ground_sum10", "<i4"),
        ("terrain_ground_min10_0", "<i2"),
        ("terrain_ground_max10_0", "<i2"),
        ("terrain_ground_min10_1", "<i2"),
        ("terrain_ground_max10_1", "<i2"),
        ("terrain_count0", "u1"),
        ("terrain_count1", "u1"),
        ("source_count", "u1"),
        ("valid_count", "u1"),
        ("omitted_terrain_count", "u1"),
    ],
    align=False,
)
if RENDER_CELL_DTYPE.itemsize != 37:
    raise RuntimeError("Five-foot render summary dtype is not packed to 37 bytes")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-query-cog", action="store_true")
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument(
        "--packed-query-only",
        action="store_true",
        help=(
            "Build only the browser-native five-foot depth-query PNG and update "
            "the existing asset manifest"
        ),
    )
    parser.add_argument(
        "--reuse-complete-state",
        action="store_true",
        help=(
            "Decode the existing complete state package in the output directory "
            "and only rebuild PNG/COG assets; do not rerun any hydraulic solve"
        ),
    )
    return parser.parse_args()


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def palette(colors: list[str]) -> tuple[list[int], bytes]:
    values = [0] * (256 * 3)
    alpha = bytearray([0] * 256)
    index = 1
    for color in colors:
        for coverage_alpha in COVERAGE_ALPHA_LEVELS:
            values[index * 3 : index * 3 + 3] = hex_rgb(color)
            alpha[index] = coverage_alpha
            index += 1
    return values, bytes(alpha)


def stage_code(stage_ft: float) -> str:
    sign = "m" if stage_ft < 0 else "p"
    return f"{sign}{round(abs(stage_ft) * 100):04d}"


def load_zones(path: Path) -> dict[str, np.ndarray]:
    connection: list[int] = []
    cell_count: list[int] = []
    source_cells: list[int] = []
    grate_cells: list[int] = []
    hard_cells: list[int] = []
    histograms: list[np.ndarray] = []
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        for expected_id, row in enumerate(reader):
            if int(row["zone_id"]) != expected_id:
                raise RuntimeError("Zone IDs are not contiguous")
            connection.append(int(row["connection10"]))
            cell_count.append(int(row["cell_count"]))
            source_cells.append(int(row["source_cells"]))
            grate_cells.append(int(row["grate_cells"]))
            hard_cells.append(int(row["hard_cells"]))
            histogram = np.fromstring(row["hist_counts"], sep=":", dtype=np.int64)
            if histogram.size != HIST_COUNT:
                raise RuntimeError(f"Zone {expected_id} has {histogram.size} histogram bins")
            histograms.append(histogram)
    return {
        "connection10": np.asarray(connection, dtype=np.int16),
        "cell_count": np.asarray(cell_count, dtype=np.int64),
        "source_cells": np.asarray(source_cells, dtype=np.int64),
        "grate_cells": np.asarray(grate_cells, dtype=np.int64),
        "hard_cells": np.asarray(hard_cells, dtype=np.int64),
        "histogram": np.stack(histograms),
    }


def load_edges(path: Path) -> dict[str, np.ndarray]:
    data = np.loadtxt(path, delimiter=",", skiprows=1, dtype=np.float64)
    return {
        "a": data[:, 0].astype(np.int32),
        "b": data[:, 1].astype(np.int32),
        "crest_ft": data[:, 2].astype(np.float64) / 10.0,
        "width_ft": data[:, 3].astype(np.float64),
    }


class HydraulicSolver:
    def __init__(
        self,
        zones: dict[str, np.ndarray],
        edges: dict[str, np.ndarray],
        *,
        routing_method: str = "hybrid_diffusive",
        source_activation_navd88_ft: float | None = SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
        manning_n: float = URBAN_OVERLAND_MANNING_N,
        minimum_mobile_depth_ft: float = MIN_MOBILE_DEPTH_FT,
        control_volume_size_ft: float = 10.0,
    ):
        if routing_method not in {"hybrid_diffusive", "diffusive", "legacy_weir"}:
            raise ValueError(f"Unsupported routing method: {routing_method}")
        self.zone_count = len(zones["connection10"])
        self.connection_ft = zones["connection10"].astype(np.float64) / 10.0
        self.source = zones["source_cells"] > 0
        if np.any(zones["grate_cells"]):
            raise RuntimeError(
                "Storm drains must be disabled for the 21-cell bulkhead run"
            )
        self.histogram = zones["histogram"].astype(np.float64)
        elevation_ft = np.arange(HIST_MIN10, HIST_MAX10 + 1, dtype=np.float64) / 10.0
        self.cumulative_count = np.cumsum(self.histogram, axis=1)
        self.cumulative_elevation = np.cumsum(self.histogram * elevation_ft[None, :], axis=1)
        occupied = self.histogram > 0
        self.minimum_surface = elevation_ft[np.argmax(occupied, axis=1)]
        self.maximum_surface = np.full(
            self.zone_count,
            MODEL_MAX_STAGE_FT,
            dtype=np.float64,
        )
        self.edges = {**edges, "crest_ft": edges["crest_ft"].copy()}
        self.routing_method = routing_method
        self.source_activation_navd88_ft = source_activation_navd88_ft
        self.manning_n = float(manning_n)
        self.minimum_mobile_depth_ft = float(minimum_mobile_depth_ft)
        self.control_volume_size_ft = float(control_volume_size_ft)
        if self.control_volume_size_ft <= 0.0:
            raise ValueError("Control-volume size must be positive")
        self.flow_length_ft = self.control_volume_size_ft
        self.maximum_numerical_speed_fps = (
            math.sqrt(2.0) * self.control_volume_size_ft / MODEL_STEP_SECONDS
        )
        self.maximum_numerical_travel_per_tide_step_ft = (
            self.maximum_numerical_speed_fps * TIDE_STEP_SECONDS
        )
        source_interface = self.source[self.edges["a"]] ^ self.source[self.edges["b"]]
        # Each complete qualified <=2.0-ft field defines the spatial footprint
        # of the tidal boundary. Two feet is not a sill: preserve every
        # one-foot perimeter width and its real DEM crest so both inflow and
        # recession are capacity-limited by the actual shared cross section.
        self.source_interface = source_interface
        self.source_inflow_crest_ft = self.edges["crest_ft"].copy()
        if source_activation_navd88_ft is not None:
            self.source_inflow_crest_ft[source_interface] = np.maximum(
                self.source_inflow_crest_ft[source_interface],
                source_activation_navd88_ft,
            )
        self.source_interface_edge_groups = int(np.count_nonzero(source_interface))
        self.source_interface_width_ft = float(
            self.edges["width_ft"][source_interface].sum()
        )

    def mobile_storage_threshold(self, surface: np.ndarray) -> np.ndarray:
        """Minimum volume needed before a finite-storage node can transmit.

        This is a standard wet/dry treatment expressed as physical depth over
        the node's currently wetted subgrid area. It replaces the previous
        0.01-cubic-foot switch, which let a microscopic numerical film move a
        full control volume every minute.
        """
        return self.wetted_area(surface) * self.minimum_mobile_depth_ft

    def storage(self, surface: np.ndarray) -> np.ndarray:
        bin_index = np.clip(
            np.floor(surface * 10.0 + 1e-8).astype(np.int32) - HIST_MIN10,
            0,
            HIST_COUNT - 1,
        )
        rows = np.arange(self.zone_count)
        count = self.cumulative_count[rows, bin_index]
        elevation_sum = self.cumulative_elevation[rows, bin_index]
        return np.maximum(0.0, count * surface - elevation_sum)

    def wetted_area(self, surface: np.ndarray) -> np.ndarray:
        bin_index = np.clip(
            np.floor(surface * 10.0 + 1e-8).astype(np.int32) - HIST_MIN10,
            0,
            HIST_COUNT - 1,
        )
        return self.cumulative_count[np.arange(self.zone_count), bin_index]

    def surface_from_storage(
        self,
        storage: np.ndarray,
        previous_surface: np.ndarray | None = None,
    ) -> np.ndarray:
        surface = (
            np.asarray(previous_surface, dtype=np.float64).copy()
            if previous_surface is not None
            else self.minimum_surface.copy()
        )
        dry = storage <= 1e-7
        surface[dry] = self.minimum_surface[dry]
        rows = np.arange(self.zone_count)
        for _ in range(7):
            bin_index = np.clip(
                np.floor(surface * 10.0 + 1e-8).astype(np.int32) - HIST_MIN10,
                0,
                HIST_COUNT - 1,
            )
            area = self.cumulative_count[rows, bin_index]
            elevation_sum = self.cumulative_elevation[rows, bin_index]
            calculated = np.maximum(0.0, area * surface - elevation_sum)
            correction = np.divide(
                storage - calculated,
                np.maximum(area, 1.0),
                out=np.zeros_like(storage),
                where=area > 0,
            )
            surface = np.clip(surface + correction, self.minimum_surface, self.maximum_surface)
        surface[dry] = self.minimum_surface[dry]
        return surface

    def equilibrium(self, sea_stage_ft: float) -> tuple[np.ndarray, np.ndarray]:
        connected = self.connection_ft <= sea_stage_ft + 1e-9
        surface = self.minimum_surface.copy()
        surface[connected] = sea_stage_ft
        storage = self.storage(surface)
        storage[~connected] = 0.0
        return storage, surface

    def dry_start(self, sea_stage_ft: float) -> tuple[np.ndarray, np.ndarray]:
        """Initialize only the open-boundary source cells at the sea stage."""
        storage = np.zeros(self.zone_count, dtype=np.float64)
        surface = self.minimum_surface.copy()
        boundary_surface = np.full(
            self.zone_count,
            float(sea_stage_ft),
            dtype=np.float64,
        )
        boundary_storage = self.storage(boundary_surface)
        storage[self.source] = boundary_storage[self.source]
        surface[self.source] = float(sea_stage_ft)
        return storage, surface

    def advance(
        self,
        storage: np.ndarray,
        surface: np.ndarray,
        sea_stage_ft: float,
        duration_seconds: int = TIDE_STEP_SECONDS,
    ) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
        edge_a = self.edges["a"]
        edge_b = self.edges["b"]
        base_crest = self.edges["crest_ft"]
        width = self.edges["width_ft"]
        source_exchange = 0.0
        internal_residual = 0.0
        # The forcing stage is constant throughout this 15-minute interval.
        # Compute its source-boundary storage once instead of repeating the
        # same full-zone hypsometry lookup in every 60-second substep.
        fixed_volume = self.storage(
            np.full(self.zone_count, sea_stage_ft, dtype=np.float64)
        )
        source_active = (
            self.source_activation_navd88_ft is None
            or sea_stage_ft >= self.source_activation_navd88_ft - 1e-9
        )
        if not source_active:
            fixed_volume[self.source] = 0.0

        if duration_seconds <= 0 or duration_seconds % MODEL_STEP_SECONDS:
            raise ValueError("Routing duration must be a positive whole number of model steps")
        for _ in range(duration_seconds // MODEL_STEP_SECONDS):
            # All edge fluxes are simultaneous. A terrain node that first
            # receives water in this substep cannot become a donor until the
            # next substep, so the numerical front advances at most one
            # control volume per minute (using the conservative tile diagonal).
            wet_at_substep_start = self.source | (
                storage >= self.mobile_storage_threshold(surface)
            )
            surface_a = surface[edge_a]
            surface_b = surface[edge_b]
            delta = surface_a - surface_b
            source_is_donor = np.where(
                delta >= 0.0,
                self.source[edge_a],
                self.source[edge_b],
            )
            crest = np.where(
                self.source_interface & source_is_donor,
                self.source_inflow_crest_ft,
                base_crest,
            )
            upstream = np.maximum(surface_a, surface_b)
            head = np.maximum(0.0, upstream - crest)
            if self.routing_method == "legacy_weir":
                downstream = np.minimum(surface_a, surface_b)
                tail = np.maximum(0.0, downstream - crest)
                ratio = np.divide(
                    tail,
                    head,
                    out=np.zeros_like(head),
                    where=head > 1e-9,
                )
                submergence = np.sqrt(
                    np.maximum(0.0, 1.0 - np.minimum(1.0, ratio) ** 1.5)
                )
                discharge = (
                    BROAD_CRESTED_WEIR_CFS * width * head**1.5 * submergence
                )
            else:
                hydraulic_slope = np.maximum(
                    0.0,
                    np.abs(delta) / self.flow_length_ft,
                )
                # Subgrid diffusive-wave conveyance. Every grouped record retains
                # the exact count of one-foot face segments at this crest, so the
                # sum of these discharges preserves narrow openings and partially
                # wetted faces instead of promoting a whole connection component.
                discharge = (
                    MANNING_US_CUSTOMARY
                    / self.manning_n
                    * width
                    * head ** (5.0 / 3.0)
                    * np.sqrt(hydraulic_slope)
                )
                if self.routing_method == "hybrid_diffusive":
                    # At a dry/free outfall the diffusive approximation can exceed
                    # the critical-flow capacity of a sill. Retain the weir relation
                    # only as that physical upper bound; submerged ordinary terrain
                    # flow is controlled by the water-surface gradient and friction.
                    free_weir_capacity = (
                        BROAD_CRESTED_WEIR_CFS * width * head**1.5
                    )
                    discharge = np.minimum(discharge, free_weir_capacity)
            transfer_magnitude = discharge * MODEL_STEP_SECONDS

            # A long explicit step can otherwise send more water than is
            # needed to equalize two small finite-volume nodes. Cap each edge
            # by the linearized two-basin equalization volume.
            area = np.maximum(self.wetted_area(surface), 1.0)
            equalization_volume = np.divide(
                np.abs(delta),
                (1.0 / area[edge_a]) + (1.0 / area[edge_b]),
            )
            transfer_magnitude = np.minimum(
                transfer_magnitude,
                equalization_volume,
            )
            transfer = np.sign(delta) * transfer_magnitude

            donor = np.where(transfer >= 0, edge_a, edge_b)
            receiver = np.where(transfer >= 0, edge_b, edge_a)
            transfer[~wet_at_substep_start[donor]] = 0.0
            outgoing = np.bincount(
                donor,
                weights=np.abs(transfer),
                minlength=self.zone_count,
            )
            limiter = np.ones(self.zone_count, dtype=np.float64)
            normal = ~self.source
            limiter[normal] = np.minimum(
                1.0,
                np.divide(
                    storage[normal],
                    outgoing[normal],
                    out=np.ones_like(storage[normal]),
                    where=outgoing[normal] > 0,
                ),
            )

            # Concurrent inflows from many edges must not lift a receiver
            # above the highest surface supplying it during this substep.
            target_surface = surface.copy()
            active_donor = (
                (np.abs(transfer) > 0.0)
                & wet_at_substep_start[donor]
            )
            donor_surface = np.where(
                active_donor,
                surface[donor],
                surface[receiver],
            )
            np.maximum.at(target_surface, receiver, donor_surface)
            receiver_capacity = np.maximum(
                0.0,
                self.storage(target_surface) - storage,
            )
            incoming = np.bincount(
                receiver,
                weights=np.abs(transfer),
                minlength=self.zone_count,
            )
            receiver_limiter = np.minimum(
                1.0,
                np.divide(
                    receiver_capacity,
                    incoming,
                    out=np.ones_like(receiver_capacity),
                    where=incoming > 0,
                ),
            )
            receiver_limiter[self.source] = 1.0
            transfer *= np.minimum(
                limiter[donor],
                receiver_limiter[receiver],
            )
            internal_net = (
                np.bincount(edge_b, weights=transfer, minlength=self.zone_count)
                - np.bincount(edge_a, weights=transfer, minlength=self.zone_count)
            )
            internal_residual = max(internal_residual, abs(float(np.sum(internal_net))))
            storage += internal_net
            storage = np.maximum(storage, 0.0)

            surface = self.surface_from_storage(storage, surface)
            source_exchange += float(np.sum(fixed_volume[self.source] - storage[self.source]))
            storage[self.source] = fixed_volume[self.source]
            surface[self.source] = sea_stage_ft

        return storage, surface, {
            "sourceExchangeFt3": source_exchange,
            "stormDrainExchangeFt3": 0.0,
            "maxInternalConservationResidualFt3": internal_residual,
        }

    def encode_surface(self, storage: np.ndarray, surface: np.ndarray) -> np.ndarray:
        encoded = np.full(self.zone_count + 1, DRY_SENTINEL, dtype="<i2")
        wet = storage > 0.01
        centift = np.clip(np.rint(surface[wet] * 100.0), -32767, 32767).astype("<i2")
        encoded[np.flatnonzero(wet) + 1] = centift
        return encoded


def load_complete_state(
    state_path: Path,
    expected_stride: int,
    *,
    require_current_physics: bool = False,
) -> tuple[dict[str, np.ndarray], dict]:
    raw = gzip.decompress(state_path.read_bytes())
    if raw[:8] != b"NWHYD2\x00\x00":
        raise RuntimeError(f"Unsupported reusable state package: {state_path}")
    header_length = int.from_bytes(raw[8:12], "little")
    header = json.loads(raw[12 : 12 + header_length])
    if (
        header.get("stageCount") != len(STAGES_FT)
        or header.get("zoneStride") != expected_stride
    ):
        raise RuntimeError("Reusable state package dimensions do not match the graph")

    payload_start = 12 + header_length
    families: dict[str, np.ndarray] = {}
    family_order = tuple(header.get("familyOrder") or header.get("phaseOrder") or ())
    if family_order != ATLAS_FAMILIES:
        raise RuntimeError("Reusable state package families do not match this atlas")
    if require_current_physics:
        physics = header.get("physics") or {}
        compatible = (
            header.get("schema") == "north-wildwood-hydraulic-states-binary-v14"
            and physics.get("modelKind")
            == "history-aware subgrid diffusive-wave finite-volume response atlas"
            and physics.get("sourceBlockActivationNavd88Ft")
            == SOURCE_BLOCK_ACTIVATION_NAVD88_FT
            and "defines geometry only"
            in str(physics.get("sourceInterfaceTreatment", ""))
        )
        if not compatible:
            raise RuntimeError(
                "State reuse requires a v27 package generated with the "
                "literal 2.0-ft tidal source field and continuous forcing"
            )
    for family in family_order:
        record = header["phaseArrays"][family]
        families[family] = decode_state_phase(
            raw,
            header,
            record,
            payload_start,
            expected_stride,
        )
    return families, dict(header.get("diagnostics") or {})


def decode_state_phase(
    raw: bytes,
    header: dict,
    record: dict,
    payload_start: int,
    expected_stride: int,
) -> np.ndarray:
    """Decode either the current centifeet payload or the legacy decifeet one."""
    offset = payload_start + int(record["offset"])
    byte_length = int(record["length"])
    if header.get("valueType") == "int16-le":
        expected_bytes = len(STAGES_FT) * expected_stride * 2
        if byte_length != expected_bytes:
            raise RuntimeError("Centifeet state phase has an invalid byte length")
        return np.frombuffer(
            raw,
            dtype="<i2",
            count=byte_length // 2,
            offset=offset,
        ).reshape(len(STAGES_FT), expected_stride)

    encoded = np.frombuffer(
        raw,
        dtype=np.uint8,
        count=byte_length,
        offset=offset,
    ).reshape(len(STAGES_FT), expected_stride)
    centift = (
        encoded.astype(np.int16)
        + int(header["surfaceOffsetDecifeet"])
    ) * 10
    centift[encoded == int(header["drySentinel"])] = DRY_SENTINEL
    return centift


def simulate(
    solver: HydraulicSolver,
) -> tuple[dict[str, np.ndarray], dict]:
    stride = solver.zone_count + 1
    families = {
        family: np.full((len(STAGES_FT), stride), DRY_SENTINEL, dtype="<i2")
        for family in ATLAS_FAMILIES
    }
    diagnostic_rows: list[dict] = []

    def restore(encoded: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        encoded_zones = encoded[1:]
        wet = encoded_zones != DRY_SENTINEL
        surface = solver.minimum_surface.copy()
        surface[wet] = encoded_zones[wet].astype(np.float64) / 100.0
        storage = solver.storage(surface)
        storage[~wet] = 0.0
        return storage, surface

    # Three rising histories use observed high-tide rise-rate quantiles. Each
    # family starts with only the fixed-head source zones wet. A 0.1-foot stage
    # step therefore consumes the physical time implied by that family rather
    # than the v19 atlas's artificial 15 minutes at every stage.
    for family, rise_rate in RISE_RATE_FAMILIES_FT_PER_HOUR.items():
        storage, surface = solver.dry_start(float(STAGES_FT[0]))
        duration_seconds = max(
            MODEL_STEP_SECONDS,
            round(
                MODEL_STAGE_STEP_FT / rise_rate * 3600.0 / MODEL_STEP_SECONDS
            ) * MODEL_STEP_SECONDS,
        )
        for index, stage_raw in enumerate(STAGES_FT):
            stage = float(stage_raw)
            storage, surface, diagnostic = solver.advance(
                storage,
                surface,
                stage,
                duration_seconds=duration_seconds,
            )
            families[family][index] = solver.encode_surface(storage, surface)
            diagnostic_rows.append(
                {
                    "family": family,
                    "stageNavd88Ft": stage,
                    "durationSeconds": duration_seconds,
                    **diagnostic,
                }
            )
            if index % 10 == 0:
                print(f"{family}: {stage:4.1f} ft NAVD88")

    # The turning-point state gets an explicit short hold. It is kept separate
    # from rising states, so dry lowlands cannot appear wet merely because the
    # browser called an hourly peak "slack".
    crest_duration_seconds = SHORT_CREST_MINUTES * 60
    for index, stage_raw in enumerate(STAGES_FT):
        stage = float(stage_raw)
        storage, surface = restore(families["rising_typical"][index])
        storage, surface, diagnostic = solver.advance(
            storage,
            surface,
            stage,
            duration_seconds=crest_duration_seconds,
        )
        families["crest"][index] = solver.encode_surface(storage, surface)
        diagnostic_rows.append(
            {
                "family": "crest",
                "stageNavd88Ft": stage,
                "durationSeconds": crest_duration_seconds,
                **diagnostic,
            }
        )
        if index % 10 == 0:
            print(f"crest: {stage:4.1f} ft NAVD88")

    # Each falling family is one continuous recession from an absolute prior
    # crest. This eliminates v19's stage+2.5-ft moving history and its one-foot
    # band resets. The browser chooses the closest prior crest once per frame.
    fall_duration_seconds = max(
        MODEL_STEP_SECONDS,
        round(
            MODEL_STAGE_STEP_FT
            / RISE_RATE_FAMILIES_FT_PER_HOUR["rising_typical"]
            * 3600.0
            / MODEL_STEP_SECONDS
        )
        * MODEL_STEP_SECONDS,
    )
    for family, prior_crest in FALLING_CREST_FAMILIES_FT.items():
        peak_index = int(round(prior_crest / MODEL_STAGE_STEP_FT))
        peak_index = max(0, min(len(STAGES_FT) - 1, peak_index))
        # Values above this family's crest are not normally requested. Keeping
        # the corresponding crest states makes browser fallbacks conservative
        # and avoids holes if a truncated forecast starts mid-event.
        families[family][peak_index:] = families["crest"][peak_index:]
        storage, surface = restore(families["crest"][peak_index])
        families[family][peak_index] = solver.encode_surface(storage, surface)
        for index in range(peak_index - 1, -1, -1):
            stage = float(STAGES_FT[index])
            storage, surface, diagnostic = solver.advance(
                storage,
                surface,
                stage,
                duration_seconds=fall_duration_seconds,
            )
            families[family][index] = solver.encode_surface(storage, surface)
            diagnostic_rows.append(
                {
                    "family": family,
                    "stageNavd88Ft": stage,
                    "historyPeakNavd88Ft": float(STAGES_FT[peak_index]),
                    "durationSeconds": fall_duration_seconds,
                    **diagnostic,
                }
            )
        print(
            f"{family}: continuous recession from "
            f"{float(STAGES_FT[peak_index]):.1f} ft NAVD88"
        )

    # March 1962 was not a single turning point. Route one offline design
    # hydrograph through all five documented high tides and retain only the
    # calibrated final-crest state. This adds one PNG per overlay to Bunny,
    # yet preserves the accumulated finite volume and drainage history that a
    # one-tide crest frame cannot represent.
    storage, surface = solver.dry_start(HISTORIC_1962_EXTREMA[0][1])
    historic_elapsed_seconds = 0
    historic_source_exchange_ft3 = 0.0
    for segment_index in range(1, len(HISTORIC_1962_EXTREMA)):
        start_hour, start_stage = HISTORIC_1962_EXTREMA[segment_index - 1]
        end_hour, end_stage = HISTORIC_1962_EXTREMA[segment_index]
        segment_steps = max(
            1,
            round((end_hour - start_hour) * 3600.0 / TIDE_STEP_SECONDS),
        )
        for step_index in range(1, segment_steps + 1):
            fraction = step_index / segment_steps
            eased = 0.5 - 0.5 * math.cos(math.pi * fraction)
            stage = start_stage + (end_stage - start_stage) * eased
            storage, surface, diagnostic = solver.advance(
                storage,
                surface,
                float(stage),
                duration_seconds=TIDE_STEP_SECONDS,
            )
            historic_elapsed_seconds += TIDE_STEP_SECONDS
            historic_source_exchange_ft3 += diagnostic["sourceExchangeFt3"]
            diagnostic_rows.append(
                {
                    "family": HISTORIC_1962_FAMILY,
                    "stageNavd88Ft": float(stage),
                    "durationSeconds": TIDE_STEP_SECONDS,
                    "elapsedSeconds": historic_elapsed_seconds,
                    **diagnostic,
                }
            )
    families[HISTORIC_1962_FAMILY][HISTORIC_1962_STAGE_INDEX] = (
        solver.encode_surface(storage, surface)
    )
    print(
        f"{HISTORIC_1962_FAMILY}: five-high-tide design hydrograph, "
        f"{historic_elapsed_seconds / 3600.0:.2f} hours to "
        f"{HISTORIC_1962_STAGE_FT:.1f} ft NAVD88"
    )

    summary = {
        "modelKind": "history-aware subgrid diffusive-wave finite-volume response atlas",
        "historyInvariant": False,
        "maximumInternalConservationResidualFt3": max(
            (row["maxInternalConservationResidualFt3"] for row in diagnostic_rows),
            default=0.0,
        ),
        "diagnosticStepCount": len(diagnostic_rows),
        "atlasFamilies": list(ATLAS_FAMILIES),
        "wettingAndFrontControls": {
            "controlVolumeSizeFt": solver.control_volume_size_ft,
            "maximumNumericalSpeedFtPerSecond": solver.maximum_numerical_speed_fps,
            "maximumNumericalTravelPer15MinutesFt": (
                solver.maximum_numerical_travel_per_tide_step_ft
            ),
            "rule": (
                "a newly wet control volume cannot donate until the next "
                "60-second substep and must first store at least the physical "
                "minimum mobile depth"
            ),
            "minimumMobileDepthFt": MIN_MOBILE_DEPTH_FT,
        },
        "risingHistoriesFtPerHour": RISE_RATE_FAMILIES_FT_PER_HOUR,
        "crestHistoryMinutes": SHORT_CREST_MINUTES,
        "fallingHistoryPeaksNavd88Ft": FALLING_CREST_FAMILIES_FT,
        "historic1962": {
            "family": HISTORIC_1962_FAMILY,
            "documentedHighTideCount": 5,
            "designHydrographExtremaHoursNavd88Ft": [
                list(item) for item in HISTORIC_1962_EXTREMA
            ],
            "durationHours": historic_elapsed_seconds / 3600.0,
            "retainedStageNavd88Ft": HISTORIC_1962_STAGE_FT,
            "sourceExchangeFt3": historic_source_exchange_ft3,
            "storedFrameCountPerOverlay": 1,
        },
    }
    return families, summary


def state_metadata(graph_manifest: dict, diagnostics: dict) -> dict:
    return {
        "schema": "north-wildwood-hydraulic-states-binary-v14",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "stageMinNavd88Ft": MODEL_MIN_STAGE_FT,
        "stageMaxNavd88Ft": MODEL_MAX_STAGE_FT,
        "stageStepFt": MODEL_STAGE_STEP_FT,
        "stageCount": len(STAGES_FT),
        "zoneCount": graph_manifest["zoneCount"],
        "zoneStride": graph_manifest["zoneCount"] + 1,
        "encoding": "gzip container: NWHYD2 magic, little-endian uint32 JSON header length, JSON header, then family little-endian Int16 arrays",
        "valueType": "int16-le",
        "bytesPerValue": 2,
        "surfaceUnits": "centifeet NAVD88",
        "surfaceScalePerFoot": 100,
        "drySentinelCentift": int(DRY_SENTINEL),
        "familyOrder": list(ATLAS_FAMILIES),
        "forcing": {
            "substepSeconds": MODEL_STEP_SECONDS,
            "risingFamiliesFtPerHour": RISE_RATE_FAMILIES_FT_PER_HOUR,
            "crestHoldMinutes": SHORT_CREST_MINUTES,
            "fallingPriorCrestsNavd88Ft": FALLING_CREST_FAMILIES_FT,
            "historic1962FiveTideExtremaHoursNavd88Ft": [
                list(item) for item in HISTORIC_1962_EXTREMA
            ],
            "selection": (
                "browser uses observed/forecast rising-limb rate or the "
                "preceding absolute crest, with one stored March 1962 "
                "five-high-tide maximum; no live tide-cycle hydraulic solve"
            ),
        },
        "physics": {
            "modelKind": "history-aware subgrid diffusive-wave finite-volume response atlas",
            "terrainFlow": (
                "Manning diffusive-wave conveyance with broad-crested-weir "
                "free-overflow capacity bound"
            ),
            "manningUsCustomaryFactor": MANNING_US_CUSTOMARY,
            "urbanOverlandManningN": URBAN_OVERLAND_MANNING_N,
            "flowLengthFt": graph_manifest["controlVolumeSizeFt"],
            "freeOverflowWeirCoefficientCfs": BROAD_CRESTED_WEIR_CFS,
            "crossSection": (
                "one foot of width per shared one-foot cell side, grouped by "
                "crest elevation"
            ),
            "sourceBoundary": graph_manifest["sourceBoundaryDefinition"],
            "sourceBoundaryPixelCount": graph_manifest[
                "qualifiedSourceBoundaryPixelCount"
            ],
            "sourceEnclaveTreatment": graph_manifest[
                "sourceEnclaveTreatment"
            ],
            "sourceZoneIsolation": graph_manifest[
                "sourceZonesIsolatedFromTerrain"
            ],
            "sourceExchange": (
                "fixed tide stage inside the qualified complete <=2.0-ft "
                "source footprint; terrain exchanges water only through "
                "explicit shared-edge flux at real DEM crest elevations"
            ),
            "sourceBlockActivationNavd88Ft": SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
            "sourceInterfaceTreatment": (
                "all one-foot edges along the complete source/terrain perimeter "
                "are preserved; both source-to-terrain inflow and "
                "terrain-to-source recession retain the actual graph crest; "
                "2.0 ft defines geometry only"
            ),
            "storage": (
                "one-foot DEM hypsometry integrated inside each finite-volume "
                "node"
            ),
            "fluxStability": (
                "edge transfers are bounded by two-basin equalization volume, "
                "aggregate receiver capacity, and available donor storage"
            ),
            "frontPropagation": (
                "newly wet nodes cannot donate until the next 60-second "
                "substep and contain the minimum mobile depth"
            ),
            "minimumMobileDepthFt": MIN_MOBILE_DEPTH_FT,
            "minimumRenderedDepthFt": MIN_DISPLAY_DEPTH_FT,
            "historyInvariant": False,
            "stormDrains": "disabled; no orifice exchange and no connectivity seeds",
            "bulkheadElevationNavd88Ft": 7.5,
            "bulkheadNominalWidthCells": 21,
            "bulkheadTerrainTreatment": (
                "stitched into the one-foot DEM with GDAL before graph construction"
            ),
            "waterSurface": "cell-specific finite-volume routed surface",
        },
        "diagnostics": diagnostics,
    }


def write_state_asset(
    output_path: Path,
    families: dict[str, np.ndarray],
    graph_manifest: dict,
    diagnostics: dict,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = state_metadata(graph_manifest, diagnostics)
    encoded_families: list[bytes] = []
    family_offsets: dict[str, dict[str, int]] = {}
    cursor = 0
    for family in metadata["familyOrder"]:
        raw_family = families[family].astype("<i2", copy=False).tobytes()
        encoded_families.append(raw_family)
        family_offsets[family] = {"offset": cursor, "length": len(raw_family)}
        cursor += len(raw_family)
    # Keep the container field name for old browsers; its keys are now atlas
    # families and are discovered dynamically by the current browser.
    metadata["phaseArrays"] = family_offsets
    header = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    raw = b"NWHYD2\x00\x00" + len(header).to_bytes(4, "little") + header + b"".join(encoded_families)
    output_path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"Hydraulic states: {len(raw):,} binary bytes -> {output_path.stat().st_size:,} gzip bytes")


def render_assets(
    graph_dir: Path,
    dem_path: Path,
    output_root: Path,
    families: dict[str, np.ndarray],
    family_names: tuple[str, ...] | None = None,
) -> dict:
    render_shape = (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE)
    render_cells = np.memmap(
        graph_dir / "render_cells.raw",
        dtype=RENDER_CELL_DTYPE,
        mode="r",
        shape=render_shape,
    )
    dem_ds = gdal.Open(str(dem_path))
    projection = dem_ds.GetProjection()
    origin = dem_ds.GetGeoTransform()
    dem_ds = None
    render_transform = (
        origin[0],
        origin[1] * RENDER_STRIDE,
        origin[2],
        origin[3],
        origin[4],
        origin[5] * RENDER_STRIDE,
    )

    depth_palette, depth_alpha = palette(DEPTH_COLORS)
    stage_palette, stage_alpha = palette(STAGE_COLORS)
    family_dirs = {family: family for family in ATLAS_FAMILIES}
    valid = render_cells["valid_count"] > 0
    counts = {}

    # Stage-hazard colors use the first rising stage at which each routed
    # finite-volume node actually contains water. This replaces the old static
    # minimum-connection-stage classification.
    filling_wet = families["rising_typical"][:, 1:] != DRY_SENTINEL
    filling_reached = np.any(filling_wet, axis=0)
    first_filling_index = np.argmax(filling_wet, axis=0)
    routed_activation = np.full(families["rising_typical"].shape[1], np.inf, dtype=np.float32)
    routed_activation[1:][filling_reached] = STAGES_FT[
        first_filling_index[filling_reached]
    ]

    def add_terrain_slot(
        slot: int,
        encoded_surface: np.ndarray,
        wet_area: np.ndarray,
        depth_sum: np.ndarray,
        activation_max: np.ndarray,
    ) -> None:
        zone = render_cells[f"terrain_zone{slot}"]
        count = render_cells[f"terrain_count{slot}"].astype(np.float32)
        present = (zone >= 0) & (count > 0)
        zone_lookup = np.where(present, zone + 1, 0)
        surface_centift = encoded_surface[zone_lookup]
        state_wet = present & (surface_centift != DRY_SENTINEL)
        if not np.any(state_wet):
            return
        surface = surface_centift.astype(np.float32) / 100.0
        ground_min = render_cells[f"terrain_ground_min10_{slot}"].astype(
            np.float32
        ) / 10.0
        ground_max = render_cells[f"terrain_ground_max10_{slot}"].astype(
            np.float32
        ) / 10.0
        ground_mean = np.divide(
            render_cells[f"terrain_ground_sum10_{slot}"].astype(np.float32),
            np.maximum(count * 10.0, 1.0),
        )
        threshold = surface - MIN_DISPLAY_DEPTH_FT
        fully_wet = state_wet & (threshold >= ground_max)
        partly_wet = state_wet & (threshold >= ground_min) & ~fully_wet
        slot_area = np.where(fully_wet, count, 0.0).astype(np.float32)
        slot_depth = np.where(
            fully_wet,
            np.maximum(surface - ground_mean, MIN_DISPLAY_DEPTH_FT),
            0.0,
        ).astype(np.float32)
        if np.any(partly_wet):
            span = np.maximum(ground_max - ground_min, 0.1)
            fraction = np.clip((threshold - ground_min + 0.1) / (span + 0.1), 0.0, 1.0)
            partial_area = count * fraction
            wet_ground_mean = (ground_min + np.minimum(ground_max, threshold)) / 2.0
            partial_depth = np.maximum(
                surface - wet_ground_mean,
                MIN_DISPLAY_DEPTH_FT,
            )
            slot_area = np.where(partly_wet, partial_area, slot_area)
            slot_depth = np.where(partly_wet, partial_depth, slot_depth)
        contributing = slot_area > 0
        wet_area += slot_area
        depth_sum += slot_area * slot_depth
        activation = np.maximum(ground_mean, routed_activation[zone_lookup])
        activation_max[contributing] = np.maximum(
            activation_max[contributing],
            activation[contributing],
        )

    selected_family_dirs = (
        tuple(family_dirs.items())
        if family_names is None
        else tuple((family, family_dirs[family]) for family in family_names)
    )
    for family, directory in selected_family_dirs:
        depth_dir = output_root / "DepthPNGs" / "North Wildwood" / directory
        stage_dir = output_root / "StagePNGs" / "North Wildwood" / directory
        depth_dir.mkdir(parents=True, exist_ok=True)
        stage_dir.mkdir(parents=True, exist_ok=True)
        family_bytes = 0
        maximum_flooded_pixels = 0
        minimum_flooded_pixels = None
        render_stage_indices = (
            (HISTORIC_1962_STAGE_INDEX,)
            if family == HISTORIC_1962_FAMILY
            else range(len(STAGES_FT))
        )
        for stage_index in render_stage_indices:
            stage = STAGES_FT[stage_index]
            encoded_surface = families[family][stage_index]
            wet_area = np.zeros(render_shape, dtype=np.float32)
            depth_sum = np.zeros(render_shape, dtype=np.float32)
            activation_max = np.full(render_shape, -np.inf, dtype=np.float32)

            # The fixed-head source is a forcing reservoir, not modeled flood
            # impact. Never paint source cells into either public overlay. Only
            # finite-storage terrain that receives routed volume contributes to
            # wet area, depth, or stage color.

            add_terrain_slot(
                0,
                encoded_surface,
                wet_area,
                depth_sum,
                activation_max,
            )
            add_terrain_slot(
                1,
                encoded_surface,
                wet_area,
                depth_sum,
                activation_max,
            )

            flooded = valid & (wet_area > 0)
            coverage = np.clip(wet_area / float(RENDER_STRIDE**2), 0.0, 1.0)
            depth = np.divide(
                depth_sum,
                np.maximum(wet_area, 1e-6),
                out=np.zeros_like(depth_sum),
                where=wet_area > 0,
            )
            # Smooth only the displayed depth values, weighted by represented
            # wet area.  The immutable wet mask and fractional edge coverage
            # are never expanded by this display-only filter.
            wet_weight = gaussian_filter(
                coverage,
                sigma=1.0,
                mode="nearest",
            )
            filtered_depth = gaussian_filter(
                depth * coverage,
                sigma=1.0,
                mode="nearest",
            )
            depth = np.where(
                flooded,
                np.divide(
                    filtered_depth,
                    np.maximum(wet_weight, 1e-6),
                    out=np.zeros_like(filtered_depth),
                    where=wet_weight > 1e-6,
                ),
                0.0,
            )
            flooded_pixels = int(np.count_nonzero(flooded))
            maximum_flooded_pixels = max(maximum_flooded_pixels, flooded_pixels)
            minimum_flooded_pixels = (
                flooded_pixels
                if minimum_flooded_pixels is None
                else min(minimum_flooded_pixels, flooded_pixels)
            )
            coverage_code = np.digitize(
                coverage,
                COVERAGE_BREAKS,
                right=False,
            ).astype(np.uint8)
            depth_codes = np.zeros(render_shape, dtype=np.uint8)
            if np.any(flooded):
                depth_class = np.digitize(
                    depth[flooded], DEPTH_BREAKS_FT, right=False
                ).astype(np.uint8)
                depth_codes[flooded] = (
                    depth_class * len(COVERAGE_ALPHA_LEVELS)
                    + coverage_code[flooded]
                    + 1
                )

            stage_codes = np.zeros(render_shape, dtype=np.uint8)
            if np.any(flooded):
                activation = activation_max[flooded]
                stage_class = np.where(
                    activation < MINOR_NAVD88_FT,
                    0,
                    np.where(activation < MODERATE_NAVD88_FT, 1, 2),
                ).astype(np.uint8)
                stage_codes[flooded] = (
                    stage_class * len(COVERAGE_ALPHA_LEVELS)
                    + coverage_code[flooded]
                    + 1
                )

            code = stage_code(float(stage))
            depth_path = depth_dir / f"NorthWildwoodDepth{code}.png"
            stage_path = stage_dir / f"NorthWildwoodStage{code}.png"
            for array, image_palette, transparency, path in (
                (depth_codes, depth_palette, depth_alpha, depth_path),
                (stage_codes, stage_palette, stage_alpha, stage_path),
            ):
                image = Image.fromarray(array, mode="P")
                image.putpalette(image_palette)
                image.info["transparency"] = transparency
                image.save(path, format="PNG", optimize=False, compress_level=7)
                family_bytes += path.stat().st_size
            if stage_index % 20 == 0:
                print(f"Rendered {family:16s} {stage:4.1f} ft")
        counts[family] = {
            "stageCount": len(render_stage_indices),
            "pngBytes": family_bytes,
            "modelKind": "history-aware subgrid diffusive-wave finite-volume response atlas",
            "historyInvariant": False,
            "wetFootprint": (
                "area-weighted one-foot subcells from immutable finite-volume "
                "routed terrain nodes only; the fixed-head forcing boundary is "
                "excluded from public overlays and "
                "smoothing cannot add wet pixels"
            ),
            "minimumFloodedPixels": minimum_flooded_pixels or 0,
            "maximumFloodedPixels": maximum_flooded_pixels,
        }

    world_path = output_root / "NorthWildwoodOverlay5ft.pgw"
    center_x = render_transform[0] + render_transform[1] / 2
    center_y = render_transform[3] + render_transform[5] / 2
    world_path.write_text(
        "\n".join(
            f"{value:.12f}"
            for value in (
                render_transform[1],
                render_transform[4],
                render_transform[2],
                render_transform[5],
                center_x,
                center_y,
            )
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "renderWidth": int(render_shape[1]),
        "renderHeight": int(render_shape[0]),
        "renderCellSizeFt": RENDER_STRIDE,
        "projection": projection,
        "geotransform": list(render_transform),
        "fixedHeadBoundaryDisplay": (
            "the complete qualified source is hydraulic forcing only and is "
            "never painted; all twenty-five underlying terrain cells are area "
            "aggregated with fractional coverage"
        ),
        "sourceBoundaryRendered": False,
        "coverageAlphaLevels": list(COVERAGE_ALPHA_LEVELS),
        "maximumOmittedTerrainSubcells": int(
            np.max(render_cells["omitted_terrain_count"])
        ),
        "totalOmittedTerrainSubcells": int(
            np.sum(render_cells["omitted_terrain_count"], dtype=np.int64)
        ),
        "minimumRenderedDepthFt": MIN_DISPLAY_DEPTH_FT,
        "families": counts,
    }


def build_query_cog(graph_dir: Path, dem_path: Path, destination: Path) -> None:
    elevation10 = np.memmap(
        graph_dir / "elevation10.raw", dtype="<i2", mode="r", shape=(HEIGHT, WIDTH)
    )
    connection10 = np.memmap(
        graph_dir / "connection10.raw", dtype="<i2", mode="r", shape=(HEIGHT, WIDTH)
    )
    zone = np.memmap(
        graph_dir / "zone_id.raw", dtype="<i4", mode="r", shape=(HEIGHT, WIDTH)
    )
    source = np.memmap(
        graph_dir / "source_flag.raw", dtype="u1", mode="r", shape=(HEIGHT, WIDTH)
    )
    hard = np.memmap(
        graph_dir / "hard_flag.raw", dtype="u1", mode="r", shape=(HEIGHT, WIDTH)
    )
    grates = np.memmap(
        graph_dir / "grate_flag.raw", dtype="u1", mode="r", shape=(HEIGHT, WIDTH)
    )
    dem_ds = gdal.Open(str(dem_path))
    projection = dem_ds.GetProjection()
    transform = dem_ds.GetGeoTransform()
    dem_ds = None

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="north-wildwood-query-") as temp_raw:
        temp = Path(temp_raw)
        projected = temp / "query_projected.tif"
        wgs84 = temp / "query_wgs84.tif"
        driver = gdal.GetDriverByName("GTiff")
        ds = driver.Create(
            str(projected),
            WIDTH,
            HEIGHT,
            6,
            gdal.GDT_Float32,
            options=[
                "TILED=YES",
                "BLOCKXSIZE=512",
                "BLOCKYSIZE=512",
                "COMPRESS=DEFLATE",
                "PREDICTOR=3",
                "BIGTIFF=YES",
            ],
        )
        ds.SetProjection(projection)
        ds.SetGeoTransform(transform)
        descriptions = (
            "conditioned_ground_elevation_navd88_ft",
            "hydraulic_zone_id_plus_one",
            "first_equilibrium_connection_stage_navd88_ft",
            "qualified_source_block_flag",
            "twenty_one_cell_bulkhead_7_5ft_navd88_flag",
            "storm_drain_disabled_flag",
        )
        for band_number, description in enumerate(descriptions, start=1):
            ds.GetRasterBand(band_number).SetDescription(description)
            ds.GetRasterBand(band_number).SetNoDataValue(-9999.0)
        for y in range(0, HEIGHT, 256):
            end = min(HEIGHT, y + 256)
            valid = elevation10[y:end] != np.iinfo(np.int16).min
            arrays = (
                np.where(valid, elevation10[y:end].astype(np.float32) / 10.0, -9999.0),
                np.where(zone[y:end] >= 0, zone[y:end].astype(np.float32) + 1.0, -9999.0),
                np.where(
                    connection10[y:end] != np.iinfo(np.int16).max,
                    connection10[y:end].astype(np.float32) / 10.0,
                    9999.0,
                ),
                source[y:end].astype(np.float32),
                hard[y:end].astype(np.float32),
                grates[y:end].astype(np.float32),
            )
            for band_number, array in enumerate(arrays, start=1):
                ds.GetRasterBand(band_number).WriteArray(array, 0, y)
            if y % 2048 == 0:
                print(f"Writing query raster row {y:,}/{HEIGHT:,}")
        ds.SetMetadataItem(
        "MODEL",
            "subgrid diffusive-wave finite-volume routing; storm drains disabled",
        )
        ds.SetMetadataItem("VERTICAL_DATUM", "NAVD88 feet")
        ds.FlushCache()
        ds = None

        result = gdal.Warp(
            str(wgs84),
            str(projected),
            options=gdal.WarpOptions(
                dstSRS="EPSG:4326",
                resampleAlg="near",
                srcNodata=-9999,
                dstNodata=-9999,
                multithread=True,
                creationOptions=[
                    "TILED=YES",
                    "BLOCKXSIZE=512",
                    "BLOCKYSIZE=512",
                    # GeoTIFF.js reads this COG through HTTP range requests.
                    # LZW avoids the raw/zlib DEFLATE wrapper ambiguity that
                    # can produce "incorrect header check" in browsers.
                    "COMPRESS=LZW",
                    "PREDICTOR=3",
                    "BIGTIFF=YES",
                ],
            ),
        )
        if result is None:
            raise RuntimeError("Could not warp hydraulic query raster")
        result = None
        wgs84_ds = gdal.Open(str(wgs84))
        query_width = math.ceil(wgs84_ds.RasterXSize / RENDER_STRIDE)
        query_height = math.ceil(wgs84_ds.RasterYSize / RENDER_STRIDE)
        wgs84_ds = None
        result = gdal.Translate(
            str(destination),
            str(wgs84),
            options=gdal.TranslateOptions(
                format="COG",
                width=query_width,
                height=query_height,
                resampleAlg="near",
                creationOptions=[
                    # GeoTIFF.js has produced intermittent DEFLATE and LZW
                    # decoder failures against valid ranged COG tiles. The
                    # five-foot query grid matches the display PNG grid and is
                    # small enough to store uncompressed, eliminating that
                    # browser failure mode without changing the one-foot solve.
                    "COMPRESS=NONE",
                    "BLOCKSIZE=512",
                    "OVERVIEWS=IGNORE_EXISTING",
                    "BIGTIFF=YES",
                ],
            ),
        )
        if result is None:
            raise RuntimeError("Could not create hydraulic query COG")
        result = None
    print(f"Query COG: {destination.stat().st_size:,} bytes")


def build_packed_query_png(graph_dir: Path, destination: Path) -> dict:
    """Pack the five-foot ground/connection lookup into a browser-native PNG."""
    render_shape = (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE)
    render_cells = np.memmap(
        graph_dir / "render_cells.raw",
        dtype=RENDER_CELL_DTYPE,
        mode="r",
        shape=render_shape,
    )
    represented_count = (
        render_cells["source_count"].astype(np.int32)
        + render_cells["terrain_count0"].astype(np.int32)
        + render_cells["terrain_count1"].astype(np.int32)
    )
    represented_ground_sum10 = (
        render_cells["source_ground_sum10"].astype(np.int32)
        + render_cells["terrain_ground_sum10_0"].astype(np.int32)
        + render_cells["terrain_ground_sum10_1"].astype(np.int32)
    )
    elevation10 = np.rint(
        np.divide(
            represented_ground_sum10.astype(np.float32),
            np.maximum(represented_count, 1),
        )
    ).astype(np.int16)
    connection10 = np.memmap(
        graph_dir / "connection10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]

    valid = represented_count > 0
    unsigned_elevation = np.zeros(elevation10.shape, dtype=np.uint16)
    unsigned_elevation[valid] = (
        elevation10[valid].astype(np.int32) + 32768
    ).astype(np.uint16)

    packed = np.empty((*elevation10.shape, 4), dtype=np.uint8)
    packed[..., 0] = (unsigned_elevation >> 8).astype(np.uint8)
    packed[..., 1] = (unsigned_elevation & 0xFF).astype(np.uint8)
    packed[..., 2] = 255
    # One byte covers -3.0 through 22.4 ft in tenths. Connection stages below
    # -3 ft are equivalent here because the published depth catalog starts at 0.
    packed_connection10 = np.maximum(connection10, -30)
    encodable_connection = (
        valid
        & (packed_connection10 >= -30)
        & (packed_connection10 <= 224)
    )
    packed[..., 2][encodable_connection] = (
        packed_connection10[encodable_connection].astype(np.int32) + 30
    ).astype(np.uint8)
    packed[..., 3] = 255

    destination.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(packed, mode="RGBA").save(
        destination,
        format="PNG",
        optimize=False,
        compress_level=7,
    )
    metadata = {
        "schema": "north-wildwood-packed-depth-query-v3",
        "width": int(packed.shape[1]),
        "height": int(packed.shape[0]),
        "renderCellSizeFt": RENDER_STRIDE,
        "channels": {
            "redGreen": (
                "conditioned elevation in tenths NAVD88; unsigned big-endian "
                "value minus 32768; zero is nodata"
            ),
            "blue": (
                "first four-neighbour connection stage in tenths NAVD88 plus "
                "30; values below -3 ft are clamped to -3 ft; 255 means not "
                "connected through the graph-build ceiling"
            ),
            "alpha": "255",
        },
        "bytes": destination.stat().st_size,
    }
    print(f"Packed query PNG: {destination.stat().st_size:,} bytes")
    return metadata


def build_zone_query_png(
    graph_dir: Path,
    destination: Path,
    families: dict[str, np.ndarray],
) -> dict:
    """Pack displayable five-foot terrain zone IDs into a browser-native PNG."""
    render_shape = (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE)
    render_cells = np.memmap(
        graph_dir / "render_cells.raw",
        dtype=RENDER_CELL_DTYPE,
        mode="r",
        shape=render_shape,
    )
    source_dominates = (
        (render_cells["source_zone"] >= 0)
        & (
            render_cells["source_count"]
            >= render_cells["terrain_count0"]
        )
    )
    zone = np.where(
        source_dominates,
        render_cells["source_zone"],
        render_cells["terrain_zone0"],
    )
    zone = np.where(
        (zone < 0) & (render_cells["source_zone"] >= 0),
        render_cells["source_zone"],
        zone,
    ).astype(np.int32)
    encoded = np.where(
        zone >= 0,
        zone.astype(np.uint32) + 1,
        0,
    )
    if int(encoded.max()) >= 1 << 24:
        raise RuntimeError("Hydraulic zone IDs do not fit in a 24-bit PNG")
    packed = np.empty((*zone.shape, 3), dtype=np.uint8)
    packed[..., 0] = ((encoded >> 16) & 0xFF).astype(np.uint8)
    packed[..., 1] = ((encoded >> 8) & 0xFF).astype(np.uint8)
    packed[..., 2] = (encoded & 0xFF).astype(np.uint8)
    destination.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(packed, mode="RGB").save(
        destination,
        format="PNG",
        optimize=False,
        compress_level=7,
    )
    metadata = {
        "schema": "north-wildwood-packed-zone-query-v1",
        "width": int(packed.shape[1]),
        "height": int(packed.shape[0]),
        "renderCellSizeFt": RENDER_STRIDE,
        "channels": (
            "24-bit big-endian hydraulic terrain zone ID plus one; zero is "
            "nodata"
        ),
        "fixedHeadBoundaryQuery": (
            "included; complete connected source-footprint depth remains queryable"
        ),
        "bytes": destination.stat().st_size,
    }
    print(f"Packed zone query PNG: {destination.stat().st_size:,} bytes")
    return metadata


def main() -> None:
    args = parse_args()
    graph_dir = args.graph.resolve()
    output_root = args.output.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    def asset_path(path: Path) -> str:
        return path.relative_to(output_root).as_posix()

    asset_manifest_path = (
        output_root / "NorthWildwoodHydraulicAssetManifest.json"
    )
    graph_manifest = json.loads((graph_dir / "graph_manifest.json").read_text(encoding="utf-8"))
    packed_query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicQuery5ft.png"
    )
    zone_query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicZone5ft.png"
    )
    state_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicStates.json.png"
    )
    if args.packed_query_only:
        if not state_path.is_file():
            raise FileNotFoundError(
                "Packed zone-query generation requires the existing hydraulic "
                f"state package at {state_path}"
            )
        query_families, _ = load_complete_state(
            state_path,
            int(graph_manifest["zoneCount"]) + 1,
            require_current_physics=True,
        )
        packed_query_manifest = build_packed_query_png(
            graph_dir,
            packed_query_path,
        )
        zone_query_manifest = build_zone_query_png(
            graph_dir,
            zone_query_path,
            query_families,
        )
        manifest = {}
        if asset_manifest_path.is_file():
            manifest = json.loads(
                asset_manifest_path.read_text(encoding="utf-8")
            )
        manifest.update(
            {
                "generatedUtc": datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
                "packedQueryPng": asset_path(packed_query_path),
                "packedQuery": packed_query_manifest,
                "packedZoneQueryPng": asset_path(zone_query_path),
                "packedZoneQuery": zone_query_manifest,
            }
        )
        asset_manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )
        print("North Wildwood packed depth-query asset complete")
        return
    reusable_complete_state = state_path if args.reuse_complete_state else None
    if reusable_complete_state is not None and not reusable_complete_state.is_file():
        raise FileNotFoundError(
            "State reuse requires an existing hydraulic state package at "
            f"{reusable_complete_state}"
        )
    if reusable_complete_state is not None:
        families, diagnostics = load_complete_state(
            reusable_complete_state,
            int(graph_manifest["zoneCount"]) + 1,
            require_current_physics=True,
        )
        print(f"Reused all hydraulic states: {reusable_complete_state}")
    else:
        zones = load_zones(graph_dir / "zones.csv")
        edges = load_edges(graph_dir / "edges.csv")
        print(
            f"Loaded {len(zones['connection10']):,} finite-volume zones and "
            f"{len(edges['a']):,} crest-width edge groups"
        )
        solver = HydraulicSolver(
            zones,
            edges,
            control_volume_size_ft=float(
                graph_manifest["controlVolumeSizeFt"]
            ),
        )
        families, diagnostics = simulate(solver)
    # Repacking a reused payload is intentional: solver/forcing metadata can
    # be strengthened without recomputing the 707 hydraulic states, and the
    # state package must describe the code that generated the public atlas.
    write_state_asset(state_path, families, graph_manifest, diagnostics)
    render_manifest = None
    if not args.skip_render:
        render_manifest = render_assets(
            graph_dir,
            args.dem.resolve(),
            output_root,
            families,
        )
    query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicQueryWGS84.cog.tif"
    )
    if not args.skip_query_cog:
        build_query_cog(graph_dir, args.dem.resolve(), query_path)
    packed_query_manifest = build_packed_query_png(
        graph_dir,
        packed_query_path,
    )
    zone_query_manifest = build_zone_query_png(
        graph_dir,
        zone_query_path,
        families,
    )

    manifest = {
        "schema": "north-wildwood-hydraulic-assets-v15",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "modelKind": "history-aware subgrid diffusive-wave finite-volume response atlas",
        "historyInvariant": False,
        "stageCatalog": {
            "minimumNavd88Ft": MODEL_MIN_STAGE_FT,
            "maximumNavd88Ft": MODEL_MAX_STAGE_FT,
            "incrementFt": MODEL_STAGE_STEP_FT,
            "operationalStageCountPerFamily": len(STAGES_FT),
            "historic1962StageCount": 1,
            "familyCount": len(ATLAS_FAMILIES),
            "depthPngCount": (
                len(STAGES_FT) * len(OPERATIONAL_ATLAS_FAMILIES) + 1
            ),
            "stagePngCount": (
                len(STAGES_FT) * len(OPERATIONAL_ATLAS_FAMILIES) + 1
            ),
        },
        "graph": {
            **graph_manifest,
            "modelMaximumNavd88Ft": MODEL_MAX_STAGE_FT,
        },
        "render": render_manifest,
        "thresholdsNAVD88": {
            "minorLow": MINOR_NAVD88_FT,
            "moderateLow": MODERATE_NAVD88_FT,
            "majorLow": MAJOR_NAVD88_FT,
        },
        "thresholdsMLLW": {"minorLow": 6.0, "moderateLow": 7.0, "majorLow": 8.0},
        "navd88OffsetFromMllwFt": -2.75,
        "families": list(ATLAS_FAMILIES),
        "familySelection": {
            "risingRatesFtPerHour": RISE_RATE_FAMILIES_FT_PER_HOUR,
            "crestHoldMinutes": SHORT_CREST_MINUTES,
            "fallingPriorCrestsNavd88Ft": FALLING_CREST_FAMILIES_FT,
            "historic1962": {
                "family": HISTORIC_1962_FAMILY,
                "date": "1962-03-07",
                "documentedHighTideCount": 5,
                "storedStageNavd88Ft": HISTORIC_1962_STAGE_FT,
                "storedFrameCountPerOverlay": 1,
            },
        },
        "diagnostics": diagnostics,
        "queryCog": asset_path(query_path) if query_path.exists() else None,
        "packedQueryPng": asset_path(packed_query_path),
        "packedQuery": packed_query_manifest,
        "packedZoneQueryPng": asset_path(zone_query_path),
        "packedZoneQuery": zone_query_manifest,
        "hydraulicStates": asset_path(state_path),
    }
    asset_manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print("North Wildwood hydraulic assets complete")


if __name__ == "__main__":
    main()
