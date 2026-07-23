#!/usr/bin/env python3
"""Build North Wildwood's vertically penalized connected-bathtub assets.

The conditioned one-foot DEM and its four-neighbour connection-stage raster
remain the hydraulic constraints. For each gauge stage, a transparent
piecewise vertical penalty lowers the effective bathtub water surface at lower
flood levels. A cell can be blue only when both its ground and its exact
side-connected source threshold are below that effective surface.

Filling, slack, and draining assets are intentionally identical. Storm drains
remain disabled, and the 21-cell, 7.5-ft NAVD88 bulkhead remains stitched into
the DEM before connection stages are computed.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image
from scipy.ndimage import gaussian_filter, label as ndimage_label


gdal.UseExceptions()

WIDTH = 10_930
HEIGHT = 14_120
RENDER_STRIDE = 5
STAGES_FT = np.round(np.arange(0.0, 14.0 + 0.05, 0.1), 1)
DRY_SENTINEL = np.int16(-32768)
HIST_MIN10 = -100
HIST_MAX10 = 140
HIST_COUNT = HIST_MAX10 - HIST_MIN10 + 1
MODEL_STEP_SECONDS = 60
TIDE_STEP_SECONDS = 15 * 60
CONTROL_VOLUME_SIZE_FT = 25
MAX_CONTROL_VOLUME_DIAGONAL_FT = math.sqrt(2.0) * CONTROL_VOLUME_SIZE_FT
MAX_OVERLAND_FRONT_SPEED_FPS = (
    MAX_CONTROL_VOLUME_DIAGONAL_FT / MODEL_STEP_SECONDS
)
MAX_OVERLAND_FRONT_TRAVEL_PER_TIDE_STEP_FT = (
    MAX_OVERLAND_FRONT_SPEED_FPS * TIDE_STEP_SECONDS
)
BROAD_CRESTED_WEIR_CFS = 3.10
MINOR_NAVD88_FT = 3.25
MODERATE_NAVD88_FT = 4.25
MAJOR_NAVD88_FT = 5.25
LOW_STAGE_VERTICAL_PENALTY_FT = 0.75
MODERATE_VERTICAL_PENALTY_FT = 0.35

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
DISCONNECTED_COLOR = "#63D471"
STAGE_COLORS = ["#F4A742", "#E74C3C", "#7D3C98"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-query-cog", action="store_true")
    parser.add_argument("--skip-render", action="store_true")
    parser.add_argument(
        "--draining-only",
        action="store_true",
        help=(
            "Reuse filling/slack arrays from the existing output state package, "
            "then solve and render only draining assets"
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


def palette(colors: list[str], green_index: int) -> tuple[list[int], bytes]:
    values = [0] * (256 * 3)
    alpha = bytearray([0] * 256)
    for index, color in enumerate(colors, start=1):
        values[index * 3 : index * 3 + 3] = hex_rgb(color)
        alpha[index] = 225
    values[green_index * 3 : green_index * 3 + 3] = hex_rgb(DISCONNECTED_COLOR)
    alpha[green_index] = 205
    return values, bytes(alpha)


def stage_code(stage_ft: float) -> str:
    sign = "m" if stage_ft < 0 else "p"
    return f"{sign}{round(abs(stage_ft) * 10):03d}"


def vertical_penalty_ft(stage_ft: float) -> float:
    """Return the low-stage water-surface reduction in NAVD88 feet."""
    stage = float(stage_ft)
    if stage <= MINOR_NAVD88_FT:
        return LOW_STAGE_VERTICAL_PENALTY_FT
    if stage <= MODERATE_NAVD88_FT:
        fraction = (
            (stage - MINOR_NAVD88_FT)
            / (MODERATE_NAVD88_FT - MINOR_NAVD88_FT)
        )
        return (
            LOW_STAGE_VERTICAL_PENALTY_FT
            + fraction
            * (
                MODERATE_VERTICAL_PENALTY_FT
                - LOW_STAGE_VERTICAL_PENALTY_FT
            )
        )
    if stage <= MAJOR_NAVD88_FT:
        fraction = (
            (stage - MODERATE_NAVD88_FT)
            / (MAJOR_NAVD88_FT - MODERATE_NAVD88_FT)
        )
        return MODERATE_VERTICAL_PENALTY_FT * (1.0 - fraction)
    return 0.0


def effective_bathtub_stage_ft(stage_ft: float) -> float:
    return float(stage_ft) - vertical_penalty_ft(stage_ft)


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
    def __init__(self, zones: dict[str, np.ndarray], edges: dict[str, np.ndarray]):
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
        self.maximum_surface = np.full(self.zone_count, 14.0, dtype=np.float64)
        self.edges = edges

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

    def advance(
        self,
        storage: np.ndarray,
        surface: np.ndarray,
        sea_stage_ft: float,
    ) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
        edge_a = self.edges["a"]
        edge_b = self.edges["b"]
        crest = self.edges["crest_ft"]
        width = self.edges["width_ft"]
        source_exchange = 0.0
        internal_residual = 0.0
        # The forcing stage is constant throughout this 15-minute interval.
        # Compute its source-boundary storage once instead of repeating the
        # same full-zone hypsometry lookup in every 60-second substep.
        fixed_volume = self.storage(
            np.full(self.zone_count, sea_stage_ft, dtype=np.float64)
        )

        for _ in range(TIDE_STEP_SECONDS // MODEL_STEP_SECONDS):
            # All edge fluxes are simultaneous. A terrain node that first
            # receives water in this substep cannot become a donor until the
            # next substep, so the numerical front advances at most one
            # 25-foot control volume per minute (35.4 ft using the conservative
            # tile diagonal).
            wet_at_substep_start = self.source | (storage > 0.01)
            surface_a = surface[edge_a]
            surface_b = surface[edge_b]
            delta = surface_a - surface_b
            upstream = np.maximum(surface_a, surface_b)
            downstream = np.minimum(surface_a, surface_b)
            head = np.maximum(0.0, upstream - crest)
            tail = np.maximum(0.0, downstream - crest)
            ratio = np.divide(tail, head, out=np.zeros_like(head), where=head > 1e-9)
            submergence = np.sqrt(np.maximum(0.0, 1.0 - np.minimum(1.0, ratio) ** 1.5))
            discharge = BROAD_CRESTED_WEIR_CFS * width * head**1.5 * submergence
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


def load_reusable_static_phases(
    state_path: Path,
    expected_stride: int,
) -> dict[str, np.ndarray]:
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
    reusable: dict[str, np.ndarray] = {}
    for phase in ("filling", "slack"):
        record = header["phaseArrays"][phase]
        encoded = np.frombuffer(
            raw,
            dtype=np.uint8,
            count=record["length"],
            offset=payload_start + record["offset"],
        ).reshape(len(STAGES_FT), expected_stride)
        centift = (
            encoded.astype(np.int16)
            + int(header["surfaceOffsetDecifeet"])
        ) * 10
        centift[encoded == int(header["drySentinel"])] = DRY_SENTINEL
        reusable[phase] = centift
    return reusable


def load_complete_state(
    state_path: Path,
    expected_stride: int,
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
    phases: dict[str, np.ndarray] = {}
    for phase in ("filling", "slack", "draining"):
        record = header["phaseArrays"][phase]
        encoded = np.frombuffer(
            raw,
            dtype=np.uint8,
            count=record["length"],
            offset=payload_start + record["offset"],
        ).reshape(len(STAGES_FT), expected_stride)
        centift = (
            encoded.astype(np.int16)
            + int(header["surfaceOffsetDecifeet"])
        ) * 10
        centift[encoded == int(header["drySentinel"])] = DRY_SENTINEL
        phases[phase] = centift
    return phases, dict(header.get("diagnostics") or {})


def simulate(
    solver: HydraulicSolver,
    reusable_static_state: Path | None = None,
) -> tuple[dict[str, np.ndarray], dict]:
    if reusable_static_state is not None:
        raise ValueError(
            "Partial phase reuse is incompatible with the phase-invariant "
            "connected-bathtub model"
        )
    stride = solver.zone_count + 1
    phases = {
        phase: np.full((len(STAGES_FT), stride), DRY_SENTINEL, dtype="<i2")
        for phase in ("filling", "slack", "draining")
    }
    stage_diagnostics = []
    for index, stage_raw in enumerate(STAGES_FT):
        stage = float(stage_raw)
        penalty = vertical_penalty_ft(stage)
        effective_stage = stage - penalty
        storage, surface = solver.equilibrium(effective_stage)
        encoded = solver.encode_surface(storage, surface)
        for phase in phases:
            phases[phase][index] = encoded
        stage_diagnostics.append(
            {
                "stageNavd88Ft": stage,
                "verticalPenaltyFt": penalty,
                "effectiveBathtubStageNavd88Ft": effective_stage,
            }
        )
        if index % 10 == 0:
            print(
                f"Connected bathtub: {stage:4.1f} ft gauge -> "
                f"{effective_stage:4.2f} ft effective"
            )

    summary = {
        "modelKind": "vertically-penalized connected bathtub",
        "phaseInvariant": True,
        "diagnosticStageCount": len(stage_diagnostics),
        "stageDiagnostics": stage_diagnostics,
        "verticalPenalty": {
            "atOrBelowMinorFt": LOW_STAGE_VERTICAL_PENALTY_FT,
            "atModerateFt": MODERATE_VERTICAL_PENALTY_FT,
            "atOrAboveMajorFt": 0.0,
            "interpolation": "piecewise linear",
        },
    }
    return phases, summary


def state_metadata(graph_manifest: dict, diagnostics: dict) -> dict:
    return {
        "schema": "north-wildwood-hydraulic-states-binary-v4",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "stageMinNavd88Ft": 0.0,
        "stageMaxNavd88Ft": 14.0,
        "stageStepFt": 0.1,
        "stageCount": len(STAGES_FT),
        "zoneCount": graph_manifest["zoneCount"],
        "zoneStride": graph_manifest["zoneCount"] + 1,
        "encoding": "gzip container: NWHYD2 magic, little-endian uint32 JSON header length, JSON header, then phase Uint8 arrays",
        "surfaceUnits": "decifeet NAVD88",
        "surfaceOffsetDecifeet": -100,
        "drySentinel": 255,
        "phaseOrder": ["filling", "slack", "draining"],
        "forcing": {
            "phaseTreatment": "filling, slack, and draining are identical",
            "filling": "vertically penalized connected bathtub",
            "slack": "vertically penalized connected bathtub",
            "draining": "vertically penalized connected bathtub",
        },
        "physics": {
            "modelKind": "vertically-penalized connected bathtub",
            "terrainFlow": "none; static water surface",
            "connectivity": (
                "ground and exact four-neighbour source-connection stage must "
                "both be below the effective bathtub surface"
            ),
            "phaseInvariant": True,
            "verticalPenalty": {
                "atOrBelowMinorFt": LOW_STAGE_VERTICAL_PENALTY_FT,
                "atModerateFt": MODERATE_VERTICAL_PENALTY_FT,
                "atOrAboveMajorFt": 0.0,
                "interpolation": "piecewise linear",
            },
            "stormDrains": "disabled; no orifice exchange and no connectivity seeds",
            "bulkheadElevationNavd88Ft": 7.5,
            "bulkheadNominalWidthCells": 21,
            "bulkheadTerrainTreatment": (
                "stitched into the one-foot DEM with GDAL before graph construction"
            ),
            "waterSurface": "selected gauge stage minus vertical penalty",
        },
        "diagnostics": diagnostics,
    }


def write_state_asset(
    output_path: Path,
    phases: dict[str, np.ndarray],
    graph_manifest: dict,
    diagnostics: dict,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = state_metadata(graph_manifest, diagnostics)
    encoded_phases: list[bytes] = []
    phase_offsets: dict[str, dict[str, int]] = {}
    cursor = 0
    for phase in metadata["phaseOrder"]:
        centift = phases[phase].astype(np.int32, copy=False)
        dry = centift == int(DRY_SENTINEL)
        decifeet = np.rint(centift / 10.0).astype(np.int32)
        encoded = np.clip(decifeet - metadata["surfaceOffsetDecifeet"], 0, 254).astype(np.uint8)
        encoded[dry] = metadata["drySentinel"]
        raw_phase = encoded.tobytes()
        encoded_phases.append(raw_phase)
        phase_offsets[phase] = {"offset": cursor, "length": len(raw_phase)}
        cursor += len(raw_phase)
    metadata["phaseArrays"] = phase_offsets
    header = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
    raw = b"NWHYD2\x00\x00" + len(header).to_bytes(4, "little") + header + b"".join(encoded_phases)
    output_path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"Hydraulic states: {len(raw):,} binary bytes -> {output_path.stat().st_size:,} gzip bytes")


FOUR_NEIGHBOUR_STRUCTURE = np.asarray(
    (
        (0, 1, 0),
        (1, 1, 1),
        (0, 1, 0),
    ),
    dtype=np.uint8,
)


def pool_source_to_render_grid(source: np.ndarray) -> np.ndarray:
    """Preserve any one-foot source cell inside each five-foot render pixel."""
    if source.shape != (HEIGHT, WIDTH):
        raise ValueError(f"Unexpected source raster shape {source.shape}")
    if HEIGHT % RENDER_STRIDE or WIDTH % RENDER_STRIDE:
        raise ValueError("One-foot source raster is not divisible by render stride")
    pooled = np.zeros(
        (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE),
        dtype=bool,
    )
    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            pooled |= (
                source[
                    y_offset::RENDER_STRIDE,
                    x_offset::RENDER_STRIDE,
                ]
                != 0
            )
    return pooled


def retain_source_connected_water(
    flooded: np.ndarray,
    source: np.ndarray,
) -> tuple[np.ndarray, int, int, int]:
    """Keep only side-connected blue components that touch a qualified source."""
    labels, component_count = ndimage_label(
        flooded,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        return flooded, 0, 0, 0
    seeded_labels = np.unique(labels[flooded & source])
    seeded_labels = seeded_labels[seeded_labels > 0]
    component_sizes = np.bincount(labels.ravel(), minlength=component_count + 1)
    seeded_labels = seeded_labels[component_sizes[seeded_labels] >= 2]
    keep = np.zeros(component_count + 1, dtype=bool)
    keep[seeded_labels] = True
    connected = flooded & keep[labels]
    removed = int(np.count_nonzero(flooded & ~connected))
    return connected, int(component_count), int(seeded_labels.size), removed


def render_assets(
    graph_dir: Path,
    dem_path: Path,
    output_root: Path,
    phases: dict[str, np.ndarray],
    phase_names: tuple[str, ...] | None = None,
) -> dict:
    elevation10 = np.memmap(
        graph_dir / "elevation10.raw", dtype="<i2", mode="r", shape=(HEIGHT, WIDTH)
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    connection10 = np.memmap(
        graph_dir / "connection10.raw", dtype="<i2", mode="r", shape=(HEIGHT, WIDTH)
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    zone = np.memmap(
        graph_dir / "zone_id.raw", dtype="<i4", mode="r", shape=(HEIGHT, WIDTH)
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    source_raw = np.memmap(
        graph_dir / "source_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    source = pool_source_to_render_grid(source_raw)
    del source_raw

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

    depth_palette, depth_alpha = palette(DEPTH_COLORS, 12)
    stage_palette, stage_alpha = palette(STAGE_COLORS, 4)
    phase_dirs = {
        "filling": "filling",
        "slack": "",
        "draining": "draining",
    }
    valid = elevation10 != np.iinfo(np.int16).min
    ground = elevation10.astype(np.float32) / 10.0
    connection = connection10.astype(np.float32) / 10.0
    counts = {}

    # The model is phase-invariant, so render the canonical slack catalog once
    # and byte-copy it to the two phase directories. This cuts the expensive
    # component labeling and PNG encoding work by two thirds.
    selected_phase_dirs = (
        (("slack", phase_dirs["slack"]),)
        if phase_names is None
        else tuple((phase, phase_dirs[phase]) for phase in phase_names)
    )
    for phase, directory in selected_phase_dirs:
        depth_dir = output_root / "DepthPNGs" / "North Wildwood" / directory
        stage_dir = output_root / "StagePNGs" / "North Wildwood" / directory
        depth_dir.mkdir(parents=True, exist_ok=True)
        stage_dir.mkdir(parents=True, exist_ok=True)
        phase_bytes = 0
        disconnected_pixels_removed = 0
        maximum_unfiltered_components = 0
        maximum_retained_components = 0
        for stage_index, stage in enumerate(STAGES_FT):
            effective_stage = effective_bathtub_stage_ft(float(stage))
            local_surface = np.full(
                ground.shape,
                effective_stage,
                dtype=np.float32,
            )
            depth = local_surface - ground
            # A blue cell must be physically below the penalized water
            # surface and reachable from a qualified source by cell sides at
            # that same surface. The final component filter below enforces the
            # same four-side rule after five-foot display resampling.
            flooded = (
                valid
                & (depth > 0.005)
                & (connection <= effective_stage + 1e-9)
            )
            (
                flooded,
                unfiltered_components,
                retained_components,
                removed_pixels,
            ) = retain_source_connected_water(flooded, source)
            disconnected_pixels_removed += removed_pixels
            maximum_unfiltered_components = max(
                maximum_unfiltered_components,
                unfiltered_components,
            )
            maximum_retained_components = max(
                maximum_retained_components,
                retained_components,
            )
            if np.any(flooded):
                # Smooth only the depth values inside the immutable connected
                # water mask. This removes 5-ft palette stippling caused by
                # one-cell lidar noise without creating a single new wet pixel.
                wet_weight = gaussian_filter(
                    flooded.astype(np.float32),
                    sigma=2.0,
                    mode="nearest",
                )
                filtered_depth = gaussian_filter(
                    np.where(flooded, np.maximum(depth, 0.0), 0.0),
                    sigma=2.0,
                    mode="nearest",
                )
                smoothed_depth = np.divide(
                    filtered_depth,
                    np.maximum(wet_weight, 1e-6),
                    out=np.zeros_like(filtered_depth),
                    where=wet_weight > 1e-6,
                )
                depth = np.where(flooded, smoothed_depth, depth)
            below_stage = valid & (ground <= stage + 0.0001)
            green = below_stage & ~flooded

            depth_codes = np.zeros(zone.shape, dtype=np.uint8)
            depth_codes[green] = 12
            if np.any(flooded):
                depth_codes[flooded] = (
                    np.digitize(depth[flooded], DEPTH_BREAKS_FT, right=False) + 1
                ).astype(np.uint8)

            stage_codes = np.zeros(zone.shape, dtype=np.uint8)
            stage_codes[green] = 4
            if np.any(flooded):
                activation = np.maximum(ground[flooded], connection[flooded])
                stage_codes[flooded] = np.where(
                    activation < MINOR_NAVD88_FT,
                    1,
                    np.where(activation < MODERATE_NAVD88_FT, 2, 3),
                ).astype(np.uint8)

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
                phase_bytes += path.stat().st_size
            if stage_index % 20 == 0:
                print(f"Rendered {phase:8s} {stage:4.1f} ft")
        counts[phase] = {
            "stageCount": len(STAGES_FT),
            "pngBytes": phase_bytes,
            "modelKind": "vertically-penalized connected bathtub",
            "phaseInvariant": True,
            "verticalPenalty": {
                "atOrBelowMinorFt": LOW_STAGE_VERTICAL_PENALTY_FT,
                "atModerateFt": MODERATE_VERTICAL_PENALTY_FT,
                "atOrAboveMajorFt": 0.0,
                "interpolation": "piecewise linear",
            },
            "connectivity": "four-neighbour render components touching a qualified source",
            "disconnectedBluePixelsRemoved": disconnected_pixels_removed,
            "maximumUnfilteredComponents": maximum_unfiltered_components,
            "maximumRetainedSourceComponents": maximum_retained_components,
        }

    if phase_names is None:
        canonical = counts["slack"]
        for phase in ("filling", "draining"):
            directory = phase_dirs[phase]
            copied_bytes = 0
            for family, prefix in (
                ("DepthPNGs", "NorthWildwoodDepth"),
                ("StagePNGs", "NorthWildwoodStage"),
            ):
                source_dir = output_root / family / "North Wildwood"
                destination_dir = source_dir / directory
                destination_dir.mkdir(parents=True, exist_ok=True)
                for stage in STAGES_FT:
                    filename = f"{prefix}{stage_code(float(stage))}.png"
                    source_path = source_dir / filename
                    destination_path = destination_dir / filename
                    shutil.copyfile(source_path, destination_path)
                    copied_bytes += destination_path.stat().st_size
            counts[phase] = dict(canonical)
            counts[phase]["pngBytes"] = copied_bytes
            counts[phase]["copiedFromCanonicalPhase"] = "slack"
            print(f"Copied canonical slack catalog to {phase}")

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
        "renderWidth": int(zone.shape[1]),
        "renderHeight": int(zone.shape[0]),
        "renderCellSizeFt": RENDER_STRIDE,
        "projection": projection,
        "geotransform": list(render_transform),
        "phases": counts,
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
            "one-foot finite-volume broad-crested-weir routing; storm drains disabled",
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
        result = gdal.Translate(
            str(destination),
            str(wgs84),
            options=gdal.TranslateOptions(
                format="COG",
                creationOptions=[
                    "COMPRESS=LZW",
                    "PREDICTOR=3",
                    "BLOCKSIZE=512",
                    "OVERVIEWS=AUTO",
                    "BIGTIFF=YES",
                ],
            ),
        )
        if result is None:
            raise RuntimeError("Could not create hydraulic query COG")
        result = None
    print(f"Query COG: {destination.stat().st_size:,} bytes")


def main() -> None:
    args = parse_args()
    if args.draining_only:
        raise ValueError(
            "--draining-only is unavailable for the phase-invariant connected-"
            "bathtub model; rebuild all three identical phases together"
        )
    if args.draining_only and args.reuse_complete_state:
        raise ValueError("--draining-only and --reuse-complete-state are mutually exclusive")
    graph_dir = args.graph.resolve()
    output_root = args.output.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    asset_manifest_path = (
        output_root / "NorthWildwoodHydraulicAssetManifest.json"
    )
    previous_render_manifest = None
    if args.draining_only and asset_manifest_path.is_file():
        previous_asset_manifest = json.loads(
            asset_manifest_path.read_text(encoding="utf-8")
        )
        previous_render_manifest = previous_asset_manifest.get("render")
    graph_manifest = json.loads((graph_dir / "graph_manifest.json").read_text(encoding="utf-8"))
    state_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicStates.json.png"
    )
    reusable_static_state = state_path if args.draining_only else None
    reusable_complete_state = state_path if args.reuse_complete_state else None
    required_state = reusable_complete_state or reusable_static_state
    if required_state is not None and not required_state.is_file():
        raise FileNotFoundError(
            "State reuse requires an existing hydraulic state package at "
            f"{required_state}"
        )
    if reusable_complete_state is not None:
        phases, diagnostics = load_complete_state(
            reusable_complete_state,
            int(graph_manifest["zoneCount"]) + 1,
        )
        print(f"Reused all hydraulic states: {reusable_complete_state}")
    else:
        zones = load_zones(graph_dir / "zones.csv")
        edges = {
            "a": np.empty(0, dtype=np.int32),
            "b": np.empty(0, dtype=np.int32),
            "crest_ft": np.empty(0, dtype=np.float64),
            "width_ft": np.empty(0, dtype=np.float64),
        }
        print(
            f"Loaded {len(zones['connection10']):,} connected-bathtub zones; "
            "routing edges are not needed"
        )
        solver = HydraulicSolver(zones, edges)
        phases, diagnostics = simulate(solver, reusable_static_state)
        write_state_asset(state_path, phases, graph_manifest, diagnostics)
    render_manifest = None
    if not args.skip_render:
        render_manifest = render_assets(
            graph_dir,
            args.dem.resolve(),
            output_root,
            phases,
            phase_names=("draining",) if args.draining_only else None,
        )
        if previous_render_manifest is not None:
            phase_counts = dict(previous_render_manifest.get("phases", {}))
            phase_counts.update(render_manifest["phases"])
            phase_directories = {
                "filling": "filling",
                "slack": "",
                "draining": "draining",
            }
            for phase, directory in phase_directories.items():
                if phase in phase_counts:
                    continue
                paths = []
                for family in ("DepthPNGs", "StagePNGs"):
                    paths.extend(
                        (
                            output_root
                            / family
                            / "North Wildwood"
                            / directory
                        ).glob("*.png")
                    )
                if len(paths) != len(STAGES_FT) * 2:
                    raise RuntimeError(
                        f"Cannot restore {phase} render manifest: "
                        f"expected {len(STAGES_FT) * 2} PNGs, found {len(paths)}"
                    )
                phase_counts[phase] = {
                    "stageCount": len(STAGES_FT),
                    "pngBytes": sum(path.stat().st_size for path in paths),
                }
            render_manifest["phases"] = phase_counts
    query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicQueryWGS84.cog.tif"
    )
    if not args.skip_query_cog:
        build_query_cog(graph_dir, args.dem.resolve(), query_path)

    manifest = {
        "schema": "north-wildwood-hydraulic-assets-v3",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "modelKind": "vertically-penalized connected bathtub",
        "phaseInvariant": True,
        "verticalPenalty": {
            "atOrBelowMinorFt": LOW_STAGE_VERTICAL_PENALTY_FT,
            "atModerateFt": MODERATE_VERTICAL_PENALTY_FT,
            "atOrAboveMajorFt": 0.0,
            "interpolation": "piecewise linear",
        },
        "graph": graph_manifest,
        "render": render_manifest,
        "thresholdsNAVD88": {
            "minorLow": MINOR_NAVD88_FT,
            "moderateLow": MODERATE_NAVD88_FT,
            "majorLow": MAJOR_NAVD88_FT,
        },
        "thresholdsMLLW": {"minorLow": 6.0, "moderateLow": 7.0, "majorLow": 8.0},
        "navd88OffsetFromMllwFt": -2.75,
        "phases": ["filling", "slack", "draining"],
        "diagnostics": diagnostics,
        "queryCog": str(query_path) if query_path.exists() else None,
        "hydraulicStates": str(state_path),
    }
    asset_manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print("North Wildwood hydraulic assets complete")


if __name__ == "__main__":
    main()
