#!/usr/bin/env python3
"""Build North Wildwood's phase-aware conditional-connectivity assets.

The conditioned one-foot DEM and its four-neighbour connection-stage raster
remain the hydraulic constraints. Connectivity is evaluated at the selected
gauge stage. In NJDEP-developed land only, a quadratic penalty marks the
shallower rising/slack-tide band green (uncertain) and a positive recession
offset retains already-routed water during draining. Wetlands, water, and
barren beach land receive neither adjustment. The polynomial is anchored at
0.75 ft at minor, 0.25 ft at moderate, and 0.00 ft at major flood.

Filling/slack and draining assets are intentionally different. Storm drains
remain disabled, and the 21-cell, 7.5-ft NAVD88 bulkhead remains stitched into
the DEM before connection stages are computed.
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
try:
    from osgeo import gdal
except ModuleNotFoundError:  # Unit checks do not open or write rasters.
    gdal = None
try:
    from PIL import Image
except ModuleNotFoundError:  # Unit checks do not render images.
    Image = None
try:
    from scipy.ndimage import (
        binary_dilation,
        gaussian_filter,
        label as ndimage_label,
    )
except ModuleNotFoundError:  # Unit checks do not render images.
    binary_dilation = None
    gaussian_filter = None
    ndimage_label = None


if gdal is not None:
    gdal.UseExceptions()

WIDTH = 10_930
HEIGHT = 14_120
RENDER_STRIDE = 5
STAGES_FT = np.round(np.arange(0.0, 20.0 + 0.05, 0.1), 2)
DRY_SENTINEL = np.int16(-32768)
HIST_MIN10 = -100
HIST_MAX10 = 200
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
MINOR_VERTICAL_PENALTY_FT = 0.75
MODERATE_VERTICAL_PENALTY_FT = 0.25
MAJOR_VERTICAL_PENALTY_FT = 0.0

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
        "--packed-query-only",
        action="store_true",
        help=(
            "Build only the browser-native five-foot depth-query PNG and update "
            "the existing asset manifest"
        ),
    )
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
    return f"{sign}{round(abs(stage_ft) * 100):04d}"


def vertical_penalty_ft(stage_ft: float) -> float:
    """Return the three-anchor quadratic adjustment in NAVD88 feet."""
    stage = float(stage_ft)
    if stage <= MINOR_NAVD88_FT:
        return MINOR_VERTICAL_PENALTY_FT
    if stage >= MAJOR_NAVD88_FT:
        return MAJOR_VERTICAL_PENALTY_FT
    # With x measured in feet above minor flood, the unique quadratic through
    # (0, .75), (1, .25), and (2, 0) is .125x^2 - .625x + .75.
    x = stage - MINOR_NAVD88_FT
    return max(0.0, 0.125 * x * x - 0.625 * x + 0.75)


def phase_adjusted_stage_ft(
    stage_ft: float,
    phase: str,
    developed: np.ndarray | bool,
) -> np.ndarray:
    """Apply negative rising and positive draining offsets to developed land."""
    stage = float(stage_ft)
    penalty = vertical_penalty_ft(stage)
    direction = 1.0 if phase == "draining" else -1.0
    return stage + np.asarray(developed, dtype=np.float64) * direction * penalty


def vertical_penalty_metadata() -> dict:
    return {
        "anchors": [
            {"threshold": "minor", "stageNavd88Ft": MINOR_NAVD88_FT, "penaltyFt": MINOR_VERTICAL_PENALTY_FT},
            {"threshold": "moderate", "stageNavd88Ft": MODERATE_NAVD88_FT, "penaltyFt": MODERATE_VERTICAL_PENALTY_FT},
            {"threshold": "major", "stageNavd88Ft": MAJOR_NAVD88_FT, "penaltyFt": MAJOR_VERTICAL_PENALTY_FT},
        ],
        "curve": "quadratic through all three anchors",
        "polynomial": "0.125*x^2 - 0.625*x + 0.75; x = stage - minor",
        "belowMinorTreatment": "clamped to 0.75 ft",
        "aboveMajorTreatment": "clamped to 0.00 ft",
        "spatialMask": "NJDEP Land Use 2015 TYPE15 = URBAN only",
        "fillingAndSlack": "negative offset; excluded connected band is green uncertainty",
        "draining": "positive offset retains prior routed water; it is not new inflow",
        "undeveloped": "zero offset on wetlands, water, beaches, and other non-urban land",
    }


def penalized_connected_depth_ft(
    stage_ft: float,
    ground_ft: np.ndarray | float,
    developed: np.ndarray | bool = True,
    phase: str = "slack",
) -> np.ndarray:
    """Return phase-adjusted depth; the caller separately labels uncertainty."""
    adjusted_stage = phase_adjusted_stage_ft(stage_ft, phase, developed)
    return np.maximum(
        0.0,
        adjusted_stage - np.asarray(ground_ft, dtype=np.float64),
    )


def load_zones(path: Path) -> dict[str, np.ndarray]:
    connection: list[int] = []
    cell_count: list[int] = []
    source_cells: list[int] = []
    grate_cells: list[int] = []
    hard_cells: list[int] = []
    developed_cells: list[int] = []
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
            developed_cells.append(int(row.get("developed_cells", 0)))
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
        "developed_cells": np.asarray(developed_cells, dtype=np.int64),
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
        self.maximum_surface = np.full(self.zone_count, 20.0, dtype=np.float64)
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
        reusable[phase] = decode_state_phase(
            raw,
            header,
            record,
            payload_start,
            expected_stride,
        )
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
        phases[phase] = decode_state_phase(
            raw,
            header,
            record,
            payload_start,
            expected_stride,
        )
    return phases, dict(header.get("diagnostics") or {})


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
    reusable_static_state: Path | None = None,
) -> tuple[dict[str, np.ndarray], dict]:
    if reusable_static_state is not None:
        raise ValueError(
            "Partial phase reuse is incompatible with the phase-aware "
            "conditional-connectivity model"
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
        storage, surface = solver.equilibrium(stage)
        encoded = solver.encode_surface(storage, surface)
        # The one-foot state container remains the unadjusted connectivity
        # audit. Developed-only phase adjustments are applied to raster cells
        # during rendering and by the browser's developed-mask point query.
        for phase in phases:
            phases[phase][index] = encoded
        stage_diagnostics.append(
            {
                "stageNavd88Ft": stage,
                "developedLandPolynomialPenaltyFt": penalty,
                "connectivityStageNavd88Ft": stage,
            }
        )
        if index % 10 == 0:
            print(
                f"Conditional connectivity: {stage:4.1f} ft gauge; "
                f"developed-land polynomial adjustment {penalty:4.2f} ft"
            )

    summary = {
        "modelKind": "phase-aware developed-land conditional connectivity",
        "phaseInvariant": False,
        "diagnosticStageCount": len(stage_diagnostics),
        "stageDiagnostics": stage_diagnostics,
        "verticalPenalty": vertical_penalty_metadata(),
    }
    return phases, summary


def state_metadata(graph_manifest: dict, diagnostics: dict) -> dict:
    return {
        "schema": "north-wildwood-conditional-connectivity-states-v1",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "stageMinNavd88Ft": 0.0,
        "stageMaxNavd88Ft": 20.0,
        "stageStepFt": 0.1,
        "stageCount": len(STAGES_FT),
        "zoneCount": graph_manifest["zoneCount"],
        "zoneStride": graph_manifest["zoneCount"] + 1,
        "encoding": "gzip container: NWHYD2 magic, little-endian uint32 JSON header length, JSON header, then phase little-endian Int16 arrays",
        "valueType": "int16-le",
        "bytesPerValue": 2,
        "surfaceUnits": "centifeet NAVD88",
        "surfaceScalePerFoot": 100,
        "drySentinelCentift": int(DRY_SENTINEL),
        "phaseOrder": ["filling", "slack", "draining"],
        "forcing": {
            "phaseTreatment": "developed-only raster adjustment; audit state arrays are unadjusted",
            "filling": "negative polynomial offset with green uncertainty band",
            "slack": "negative polynomial offset with green uncertainty band",
            "draining": "positive polynomial recession-retention offset",
        },
        "physics": {
            "modelKind": "phase-aware developed-land conditional connectivity",
            "terrainFlow": "none; static water surface",
            "connectivity": (
                "ground and exact four-neighbour source-connection stage must "
                "both be below the full selected gauge stage"
            ),
            "phaseInvariant": False,
            "verticalPenalty": vertical_penalty_metadata(),
            "stormDrains": "disabled; no orifice exchange and no connectivity seeds",
            "bulkheadElevationNavd88Ft": 7.5,
            "bulkheadNominalWidthCells": 21,
            "bulkheadTerrainTreatment": (
                "stitched into the one-foot DEM with GDAL before graph construction"
            ),
            "waterSurface": (
                "cell-specific phase-adjusted surface in developed land only"
            ),
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
        raw_phase = phases[phase].astype("<i2", copy=False).tobytes()
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


def pool_mask_majority(mask: np.ndarray) -> np.ndarray:
    """Classify a five-foot display cell as developed by one-foot majority."""
    if mask.shape != (HEIGHT, WIDTH):
        raise ValueError(f"Unexpected developed-mask shape {mask.shape}")
    counts = np.zeros(
        (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE), dtype=np.uint8
    )
    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            counts += (
                mask[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE] != 0
            )
    return counts >= ((RENDER_STRIDE * RENDER_STRIDE) // 2 + 1)


def build_render_cell_summaries(graph_dir: Path) -> dict[str, np.ndarray]:
    """Collapse the one-foot topology without losing sub-pixel flow paths.

    The previous renderer sampled only the center one-foot cell from every
    five-foot display cell, then rebuilt connectivity on that sampled grid.
    A valid one- to four-foot-wide connection could consequently disappear.
    Here each display cell represents all 25 underlying model cells.  The
    earliest eligible one-foot connection paints the full five-foot display
    cell, so a preserved feeder is visibly five one-foot cells wide while its
    activation stage still comes from the original shared-side topology.
    """
    render_shape = (HEIGHT // RENDER_STRIDE, WIDTH // RENDER_STRIDE)
    elevation10 = np.memmap(
        graph_dir / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    connection10 = np.memmap(
        graph_dir / "connection10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    developed = np.memmap(
        graph_dir / "developed_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    source = np.memmap(
        graph_dir / "source_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )

    maximum = np.iinfo(np.int16).max
    activation_maximum = np.iinfo(np.int32).max
    nodata = np.iinfo(np.int16).min
    summary = {
        "minimum_ground10": np.full(render_shape, maximum, dtype=np.int16),
        "minimum_ground10_developed": np.full(render_shape, maximum, dtype=np.int16),
        "minimum_ground10_undeveloped": np.full(render_shape, maximum, dtype=np.int16),
        "minimum_activation100": np.full(
            render_shape, activation_maximum, dtype=np.int32
        ),
        "minimum_activation100_developed": np.full(
            render_shape, activation_maximum, dtype=np.int32
        ),
        "minimum_activation100_undeveloped": np.full(
            render_shape, activation_maximum, dtype=np.int32
        ),
        "source": np.zeros(render_shape, dtype=bool),
    }

    for y_offset in range(RENDER_STRIDE):
        for x_offset in range(RENDER_STRIDE):
            ground = elevation10[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE]
            connection = connection10[
                y_offset::RENDER_STRIDE,
                x_offset::RENDER_STRIDE,
            ]
            is_valid = ground != nodata
            is_developed = (developed[
                y_offset::RENDER_STRIDE,
                x_offset::RENDER_STRIDE,
            ] != 0) & is_valid
            is_undeveloped = is_valid & ~is_developed
            # Include a zero-depth crest cell when it is the shared-side route
            # from the source into a lower basin. The palette renders that
            # topological bridge as the shallowest water class, producing a
            # continuous visible feeder instead of a detached blue basin.
            activation = np.maximum(
                ground.astype(np.int32) * 10,
                connection.astype(np.int32) * 10,
            )
            activation = np.where(
                is_valid,
                activation,
                activation_maximum,
            ).astype(
                np.int32,
                copy=False,
            )
            valid_ground = np.where(is_valid, ground, maximum)

            np.minimum(summary["minimum_ground10"], valid_ground, out=summary["minimum_ground10"])
            np.minimum(
                summary["minimum_activation100"],
                activation,
                out=summary["minimum_activation100"],
            )
            np.minimum(
                summary["minimum_ground10_developed"],
                np.where(is_developed, ground, maximum),
                out=summary["minimum_ground10_developed"],
            )
            np.minimum(
                summary["minimum_ground10_undeveloped"],
                np.where(is_undeveloped, ground, maximum),
                out=summary["minimum_ground10_undeveloped"],
            )
            np.minimum(
                summary["minimum_activation100_developed"],
                np.where(is_developed, activation, activation_maximum),
                out=summary["minimum_activation100_developed"],
            )
            np.minimum(
                summary["minimum_activation100_undeveloped"],
                np.where(is_undeveloped, activation, activation_maximum),
                out=summary["minimum_activation100_undeveloped"],
            )
            summary["source"] |= (
                source[y_offset::RENDER_STRIDE, x_offset::RENDER_STRIDE] != 0
            )

    return summary


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


def add_visible_source_feeders(
    adjusted_flooded: np.ndarray,
    baseline_flooded: np.ndarray,
    source: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    """Join adjusted blue basins to a source with one-pixel feeder paths.

    A developed-land penalty can turn a few cells along an otherwise valid
    source route green, leaving a lower adjusted-blue basin looking detached.
    A four-neighbour wave records geodesic distance through the unadjusted
    connected mask, then traces only the first shortest path to every detached
    blue component. One display pixel is five one-foot cells wide, satisfying
    the visible several-cell feeder requirement without painting the entire
    penalty band blue.
    """
    labels, component_count = ndimage_label(
        adjusted_flooded,
        structure=FOUR_NEIGHBOUR_STRUCTURE,
    )
    if component_count == 0:
        empty = np.zeros(adjusted_flooded.shape, dtype=bool)
        return adjusted_flooded, empty, {
            "detachedComponentsJoined": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
        }

    source_labels = np.unique(labels[adjusted_flooded & source])
    source_labels = source_labels[source_labels > 0]
    all_labels = np.arange(1, component_count + 1, dtype=np.int32)
    detached_labels = np.setdiff1d(all_labels, source_labels, assume_unique=True)
    if detached_labels.size == 0:
        empty = np.zeros(adjusted_flooded.shape, dtype=bool)
        return adjusted_flooded, empty, {
            "detachedComponentsJoined": 0,
            "feederPixels": 0,
            "maximumFeederLengthPixels": 0,
        }

    source_lookup = np.zeros(component_count + 1, dtype=bool)
    source_lookup[source_labels] = True
    routed_source = adjusted_flooded & source_lookup[labels]
    if not np.any(routed_source):
        raise RuntimeError("Adjusted flood mask has no visible source component")

    distance = np.full(adjusted_flooded.shape, -1, dtype=np.int16)
    distance[routed_source] = 0
    frontier = routed_source
    unresolved = set(int(value) for value in detached_labels)
    first_hits: dict[int, int] = {}

    for step in range(1, np.iinfo(np.int16).max):
        new = (
            binary_dilation(frontier, structure=FOUR_NEIGHBOUR_STRUCTURE)
            & baseline_flooded
            & (distance < 0)
        )
        if not np.any(new):
            break
        distance[new] = step
        hit_positions = np.flatnonzero(new & (labels > 0))
        if hit_positions.size:
            hit_values = labels.ravel()[hit_positions]
            for label_value in np.unique(hit_values):
                label_id = int(label_value)
                if label_id not in unresolved:
                    continue
                first_index = int(np.flatnonzero(hit_values == label_id)[0])
                first_hits[label_id] = int(hit_positions[first_index])
                unresolved.remove(label_id)
        if not unresolved:
            break
        frontier = new

    if unresolved:
        raise RuntimeError(
            "Could not trace a visible source feeder to adjusted components "
            + ", ".join(str(value) for value in sorted(unresolved)[:20])
        )

    paths = np.zeros(adjusted_flooded.shape, dtype=bool)
    maximum_length = 0
    height, width = adjusted_flooded.shape
    for flat_position in first_hits.values():
        y, x = divmod(flat_position, width)
        path_length = int(distance[y, x])
        maximum_length = max(maximum_length, path_length)
        while distance[y, x] > 0:
            paths[y, x] = True
            target_distance = int(distance[y, x]) - 1
            next_cell = None
            for candidate_y, candidate_x in (
                (y - 1, x),
                (y, x - 1),
                (y, x + 1),
                (y + 1, x),
            ):
                if (
                    0 <= candidate_y < height
                    and 0 <= candidate_x < width
                    and distance[candidate_y, candidate_x] == target_distance
                ):
                    next_cell = (candidate_y, candidate_x)
                    break
            if next_cell is None:
                raise RuntimeError("Visible feeder distance trace is discontinuous")
            y, x = next_cell
        paths[y, x] = True

    feeder = paths & baseline_flooded & ~adjusted_flooded
    flooded = adjusted_flooded | feeder
    return flooded, feeder, {
        "detachedComponentsJoined": int(detached_labels.size),
        "feederPixels": int(np.count_nonzero(feeder)),
        "maximumFeederLengthPixels": maximum_length,
    }


def render_assets(
    graph_dir: Path,
    dem_path: Path,
    output_root: Path,
    phases: dict[str, np.ndarray],
    phase_names: tuple[str, ...] | None = None,
) -> dict:
    zone = np.memmap(
        graph_dir / "zone_id.raw", dtype="<i4", mode="r", shape=(HEIGHT, WIDTH)
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    render_summary = build_render_cell_summaries(graph_dir)
    source = render_summary["source"]

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
    maximum = np.iinfo(np.int16).max
    valid = render_summary["minimum_ground10"] != maximum
    ground = render_summary["minimum_ground10"].astype(np.float32) / 10.0
    ground_developed = (
        render_summary["minimum_ground10_developed"].astype(np.float32) / 10.0
    )
    ground_undeveloped = (
        render_summary["minimum_ground10_undeveloped"].astype(np.float32) / 10.0
    )
    activation = (
        render_summary["minimum_activation100"].astype(np.float64) / 100.0
    )
    activation_developed = (
        render_summary["minimum_activation100_developed"].astype(np.float64)
        / 100.0
    )
    activation_undeveloped = (
        render_summary["minimum_activation100_undeveloped"].astype(np.float64)
        / 100.0
    )
    counts = {}

    selected_phase_dirs = (
        tuple(phase_dirs.items())
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
        uncertainty_pixels = 0
        disconnected_pixels = 0
        recession_retained_pixels = 0
        feeder_pixels = 0
        detached_components_joined = 0
        maximum_feeder_length = 0
        for stage_index, stage in enumerate(STAGES_FT):
            stage_value = float(stage)
            baseline_flooded = valid & (activation <= stage_value + 1e-9)
            labels, unfiltered_components = ndimage_label(
                baseline_flooded,
                structure=FOUR_NEIGHBOUR_STRUCTURE,
            )
            seeded_labels = (
                np.unique(labels[baseline_flooded & source])
                if unfiltered_components
                else np.asarray([], dtype=np.int32)
            )
            retained_components = int(np.count_nonzero(seeded_labels > 0))
            maximum_unfiltered_components = max(
                maximum_unfiltered_components,
                int(unfiltered_components),
            )
            maximum_retained_components = max(
                maximum_retained_components,
                retained_components,
            )
            penalty = vertical_penalty_ft(stage_value)
            adjusted_developed_stage = (
                stage_value + penalty if phase == "draining"
                else stage_value - penalty
            )
            developed_flooded = (
                activation_developed <= adjusted_developed_stage + 1e-9
            )
            undeveloped_flooded = (
                activation_undeveloped <= stage_value + 1e-9
            )
            adjusted_flooded = valid & (developed_flooded | undeveloped_flooded)
            terrain_wet = valid & (ground < stage_value - 0.005)
            disconnected = terrain_wet & ~baseline_flooded
            disconnected_pixels += int(np.count_nonzero(disconnected))
            if phase == "draining":
                retained_lag = adjusted_flooded & ~baseline_flooded
                flooded = adjusted_flooded
                recession_retained_pixels += int(np.count_nonzero(retained_lag))
            else:
                flooded, feeder, feeder_diagnostics = add_visible_source_feeders(
                    adjusted_flooded,
                    baseline_flooded,
                    source,
                )
                feeder_pixels += feeder_diagnostics["feederPixels"]
                detached_components_joined += feeder_diagnostics[
                    "detachedComponentsJoined"
                ]
                maximum_feeder_length = max(
                    maximum_feeder_length,
                    feeder_diagnostics["maximumFeederLengthPixels"],
                )
                penalized = baseline_flooded & ~flooded
                uncertainty_pixels += int(np.count_nonzero(penalized))
            # Green is a diagnostic state, not a declaration of dry land: it
            # includes terrain below the gauge stage that is disconnected as
            # well as the developed-land band held back by the polynomial.
            green = ~flooded & (disconnected | (baseline_flooded & ~flooded))

            depth = np.maximum(
                np.where(
                    developed_flooded,
                    adjusted_developed_stage - ground_developed,
                    0.0,
                ),
                np.where(
                    undeveloped_flooded,
                    stage_value - ground_undeveloped,
                    0.0,
                ),
            ).astype(
                np.float32,
                copy=False,
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
            depth_codes = np.zeros(zone.shape, dtype=np.uint8)
            depth_codes[green] = 12
            if np.any(flooded):
                depth_codes[flooded] = (
                    np.digitize(depth[flooded], DEPTH_BREAKS_FT, right=False) + 1
                ).astype(np.uint8)

            stage_codes = np.zeros(zone.shape, dtype=np.uint8)
            stage_codes[green] = 4
            if np.any(flooded):
                local_activation = np.minimum(
                    np.where(developed_flooded, activation_developed, np.inf),
                    np.where(undeveloped_flooded, activation_undeveloped, np.inf),
                )
                if phase != "draining":
                    # Feeder pixels inherit their unadjusted hydraulic
                    # activation so their stage color remains meaningful.
                    local_activation = np.where(
                        feeder,
                        activation,
                        local_activation,
                    )
                stage_codes[flooded] = np.where(
                    local_activation[flooded] < MINOR_NAVD88_FT,
                    1,
                    np.where(
                        local_activation[flooded] < MODERATE_NAVD88_FT,
                        2,
                        3,
                    ),
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
            "modelKind": "phase-aware developed-land conditional connectivity",
            "phaseInvariant": False,
            "verticalPenalty": vertical_penalty_metadata(),
            "connectivity": "four-neighbour render components touching a qualified source",
            "disconnectedBluePixelsRemoved": disconnected_pixels_removed,
            "maximumUnfilteredComponents": maximum_unfiltered_components,
            "maximumRetainedSourceComponents": maximum_retained_components,
            "disconnectedGreenPixelInstances": disconnected_pixels,
            "developedUncertaintyPixelInstances": uncertainty_pixels,
            "developedRecessionRetainedPixelInstances": recession_retained_pixels,
            "visibleFeederPixelInstances": feeder_pixels,
            "detachedComponentsJoinedByFeeders": detached_components_joined,
            "maximumVisibleFeederLengthPixels": maximum_feeder_length,
            "renderConnectivity": (
                "all 25 one-foot cells pooled into each five-foot pixel; "
                "sub-pixel feeder paths preserved at five-foot visible width"
            ),
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
    developed = np.memmap(
        graph_dir / "developed_flag.raw", dtype="u1", mode="r", shape=(HEIGHT, WIDTH)
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
            7,
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
            "njdep_2015_type15_urban_developed_penalty_flag",
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
                developed[y:end].astype(np.float32),
            )
            for band_number, array in enumerate(arrays, start=1):
                ds.GetRasterBand(band_number).WriteArray(array, 0, y)
            if y % 2048 == 0:
                print(f"Writing query raster row {y:,}/{HEIGHT:,}")
        ds.SetMetadataItem(
            "MODEL",
            "one-foot phase-aware developed-land conditional connectivity; storm drains disabled",
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
    elevation10 = np.memmap(
        graph_dir / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]
    connection10 = np.memmap(
        graph_dir / "connection10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )[RENDER_STRIDE // 2 :: RENDER_STRIDE, RENDER_STRIDE // 2 :: RENDER_STRIDE]

    valid = elevation10 != np.iinfo(np.int16).min
    unsigned_elevation = np.zeros(elevation10.shape, dtype=np.uint16)
    unsigned_elevation[valid] = (
        elevation10[valid].astype(np.int32) + 32768
    ).astype(np.uint16)

    packed = np.empty((*elevation10.shape, 4), dtype=np.uint8)
    packed[..., 0] = (unsigned_elevation >> 8).astype(np.uint8)
    packed[..., 1] = (unsigned_elevation & 0xFF).astype(np.uint8)
    packed[..., 2] = 255
    # One byte covers -5.0 through 20.4 ft in tenths. Connection stages below
    # -5 ft are equivalent here because the published depth catalog starts at 0.
    packed_connection10 = np.maximum(connection10, -50)
    encodable_connection = (
        valid
        & (packed_connection10 >= -50)
        & (packed_connection10 <= 204)
    )
    packed[..., 2][encodable_connection] = (
        packed_connection10[encodable_connection].astype(np.int32) + 50
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
        "schema": "north-wildwood-packed-depth-query-v2",
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
                "50; values below -5 ft are clamped to -5 ft; 255 means not "
                "connected through 20 ft"
            ),
            "alpha": "255",
        },
        "bytes": destination.stat().st_size,
    }
    print(f"Packed query PNG: {destination.stat().st_size:,} bytes")
    return metadata


def build_developed_query_png(graph_dir: Path, destination: Path) -> dict:
    """Write the five-foot majority-developed point-query mask."""
    developed_raw = np.memmap(
        graph_dir / "developed_flag.raw",
        dtype=np.uint8,
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    developed = pool_mask_majority(developed_raw)
    destination.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((developed.astype(np.uint8) * 255), mode="L").save(
        destination,
        format="PNG",
        optimize=False,
        compress_level=9,
    )
    metadata = {
        "schema": "north-wildwood-developed-query-v1",
        "width": int(developed.shape[1]),
        "height": int(developed.shape[0]),
        "renderCellSizeFt": RENDER_STRIDE,
        "classification": "developed when at least 13 of 25 one-foot cells are NJDEP TYPE15 URBAN",
        "developedPixels": int(np.count_nonzero(developed)),
        "bytes": destination.stat().st_size,
    }
    print(f"Developed query PNG: {destination.stat().st_size:,} bytes")
    return metadata


def main() -> None:
    if (
        gdal is None
        or Image is None
        or binary_dilation is None
        or gaussian_filter is None
        or ndimage_label is None
    ):
        raise RuntimeError(
            "GDAL, Pillow, and SciPy are required to build hydraulic assets"
        )
    args = parse_args()
    if args.draining_only:
        raise ValueError(
            "--draining-only is unavailable because the developed-land mask "
            "must be validated across all three phase catalogs"
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
    if (args.draining_only or args.skip_render) and asset_manifest_path.is_file():
        previous_asset_manifest = json.loads(
            asset_manifest_path.read_text(encoding="utf-8")
        )
        previous_render_manifest = previous_asset_manifest.get("render")
    graph_manifest = json.loads((graph_dir / "graph_manifest.json").read_text(encoding="utf-8"))
    packed_query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodHydraulicQuery5ft.png"
    )
    developed_query_path = (
        output_root
        / "COGs"
        / "North Wildwood"
        / "NorthWildwoodDevelopedMask5ft.png"
    )
    if args.packed_query_only:
        packed_query_manifest = build_packed_query_png(
            graph_dir,
            packed_query_path,
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
                "packedQueryPng": str(packed_query_path),
                "packedQuery": packed_query_manifest,
            }
        )
        asset_manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )
        print("North Wildwood packed depth-query asset complete")
        return
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
            f"Loaded {len(zones['connection10']):,} conditional-connectivity zones; "
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
    elif previous_render_manifest is not None:
        render_manifest = previous_render_manifest
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
    developed_query_manifest = build_developed_query_png(
        graph_dir,
        developed_query_path,
    )

    manifest = {
        "schema": "north-wildwood-conditional-connectivity-assets-v1",
        "generatedUtc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "modelKind": "phase-aware developed-land conditional connectivity",
        "phaseInvariant": False,
        "verticalPenalty": vertical_penalty_metadata(),
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
        "queryCog": str(query_path.relative_to(output_root)) if query_path.exists() else None,
        "packedQueryPng": str(packed_query_path.relative_to(output_root)),
        "packedQuery": packed_query_manifest,
        "developedQueryPng": str(developed_query_path.relative_to(output_root)),
        "developedQuery": developed_query_manifest,
        "hydraulicStates": str(state_path.relative_to(output_root)),
    }
    asset_manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print("North Wildwood hydraulic assets complete")


if __name__ == "__main__":
    main()
