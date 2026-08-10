#!/usr/bin/env python3
"""Benchmark compact response-atlas strategies against volume routing.

The benchmark isolates the failure that matters in North Wildwood: a narrow
opening joins a very large, low storage area.  The reference model integrates
submerged broad-crested-weir flow and finite basin storage on the complete
hydrograph.  The alternatives deliberately receive only the information that
their browser lookup would have:

* equilibrium: current water level only;
* v19: current water level and rising/slack/falling phase;
* v20: current level plus a compact hydrograph-history family selected from
  observed rise rate (rising) or preceding crest (falling).

This is not a calibration of North Wildwood.  It is a deterministic screening
test for atlas design, mass conservation, cross-section throttling, and asset
count before the city-wide graph is rebuilt.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np


WEIR_COEFFICIENT_CFS = 3.10
DT_SECONDS = 60
OUTPUT_SECONDS = 15 * 60
GROUND_FT = 0.0

# Quantiles measured from 940 observed high tides in observed15min.json.
V20_RISE_RATES_FT_PER_HOUR = (0.55, 0.79, 0.90)
V20_PRIOR_CRESTS_FT = (4.0, 5.5, 8.5)


@dataclass(frozen=True)
class Bottleneck:
    name: str
    crest_ft: float
    width_ft: float
    storage_area_ft2: float


BOTTLENECKS = (
    Bottleneck("31-acre / 3-ft opening", 3.7, 3.0, 1_366_757.0),
    Bottleneck("9-acre / 1-ft opening", 3.8, 1.0, 401_912.0),
    Bottleneck("3-acre / 1-ft opening", 4.4, 1.0, 139_375.0),
    Bottleneck("123-acre / 1-ft opening", 7.2, 1.0, 5_357_594.0),
)


@dataclass(frozen=True)
class Hydrograph:
    peak_ft: float
    rise_rate_ft_per_hour: float
    crest_hold_hours: float
    fall_rate_ft_per_hour: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def phase_and_stage(event: Hydrograph, elapsed_hours: float) -> tuple[str, float]:
    rise_hours = event.peak_ft / event.rise_rate_ft_per_hour
    fall_start = rise_hours + event.crest_hold_hours
    if elapsed_hours < rise_hours:
        return "rising", elapsed_hours * event.rise_rate_ft_per_hour
    if elapsed_hours < fall_start:
        return "slack", event.peak_ft
    stage = event.peak_ft - (elapsed_hours - fall_start) * event.fall_rate_ft_per_hour
    return "falling", max(0.0, stage)


def event_duration_hours(event: Hydrograph) -> float:
    return (
        event.peak_ft / event.rise_rate_ft_per_hour
        + event.crest_hold_hours
        + event.peak_ft / event.fall_rate_ft_per_hour
    )


def weir_discharge_cfs(
    sea_surface_ft: float,
    basin_surface_ft: float,
    crest_ft: float,
    width_ft: float,
) -> float:
    delta = sea_surface_ft - basin_surface_ft
    if abs(delta) <= 1e-12:
        return 0.0
    upstream = max(sea_surface_ft, basin_surface_ft)
    downstream = min(sea_surface_ft, basin_surface_ft)
    head = max(0.0, upstream - crest_ft)
    if head <= 0.0:
        return 0.0
    tail = max(0.0, downstream - crest_ft)
    ratio = min(1.0, tail / head)
    submergence = math.sqrt(max(0.0, 1.0 - ratio**1.5))
    magnitude = WEIR_COEFFICIENT_CFS * width_ft * head**1.5 * submergence
    return math.copysign(magnitude, delta)


def advance_storage(
    volume_ft3: float,
    sea_surface_ft: float,
    bottleneck: Bottleneck,
    dt_seconds: int = DT_SECONDS,
) -> float:
    basin_surface = GROUND_FT + volume_ft3 / bottleneck.storage_area_ft2
    discharge = weir_discharge_cfs(
        sea_surface_ft,
        basin_surface,
        bottleneck.crest_ft,
        bottleneck.width_ft,
    )
    proposed = volume_ft3 + discharge * dt_seconds
    # The only opening is bidirectional; never remove unavailable volume and
    # never let one explicit step cross the source water surface.
    source_level_volume = max(
        0.0,
        (sea_surface_ft - GROUND_FT) * bottleneck.storage_area_ft2,
    )
    if discharge >= 0.0:
        return min(max(0.0, proposed), source_level_volume)
    return max(0.0, proposed)


def route_event(event: Hydrograph, bottleneck: Bottleneck) -> dict[str, np.ndarray]:
    duration_seconds = round(event_duration_hours(event) * 3600)
    output_times = np.arange(0, duration_seconds + OUTPUT_SECONDS, OUTPUT_SECONDS)
    output_times[-1] = min(output_times[-1], duration_seconds)
    times: list[int] = []
    stages: list[float] = []
    phases: list[str] = []
    volumes: list[float] = []
    volume = 0.0
    output_index = 0
    for second in range(0, duration_seconds + 1, DT_SECONDS):
        elapsed_hours = second / 3600.0
        phase, stage = phase_and_stage(event, elapsed_hours)
        if second > 0:
            volume = advance_storage(volume, stage, bottleneck)
        while output_index < len(output_times) and second >= output_times[output_index]:
            times.append(int(output_times[output_index]))
            stages.append(stage)
            phases.append(phase)
            volumes.append(volume)
            output_index += 1
    return {
        "time_seconds": np.asarray(times, dtype=np.int32),
        "stage_ft": np.asarray(stages, dtype=np.float64),
        "phase": np.asarray(phases, dtype=object),
        "volume_ft3": np.asarray(volumes, dtype=np.float64),
    }


@lru_cache(maxsize=None)
def route_to_stage(
    bottleneck: Bottleneck,
    target_stage_ft: float,
    rise_rate_ft_per_hour: float,
) -> float:
    event = Hydrograph(
        peak_ft=max(0.0, target_stage_ft),
        rise_rate_ft_per_hour=rise_rate_ft_per_hour,
        crest_hold_hours=0.0,
        fall_rate_ft_per_hour=rise_rate_ft_per_hour,
    )
    return float(route_event(event, bottleneck)["volume_ft3"][-1])


@lru_cache(maxsize=None)
def route_from_crest_to_stage(
    bottleneck: Bottleneck,
    target_stage_ft: float,
    crest_ft: float,
    rate_ft_per_hour: float,
    hold_hours: float = 0.25,
) -> float:
    crest = max(target_stage_ft, crest_ft)
    event = Hydrograph(
        peak_ft=crest,
        rise_rate_ft_per_hour=rate_ft_per_hour,
        crest_hold_hours=hold_hours,
        fall_rate_ft_per_hour=rate_ft_per_hour,
    )
    routed = route_event(event, bottleneck)
    falling = np.flatnonzero(routed["phase"] == "falling")
    if not len(falling):
        return float(routed["volume_ft3"][-1])
    candidates = falling[
        np.argmin(np.abs(routed["stage_ft"][falling] - target_stage_ft))
    ]
    return float(routed["volume_ft3"][candidates])


def predict_equilibrium(stage_ft: float, bottleneck: Bottleneck) -> float:
    if stage_ft + 1e-9 < bottleneck.crest_ft:
        return 0.0
    return max(0.0, stage_ft - GROUND_FT) * bottleneck.storage_area_ft2


def predict_v19(stage_ft: float, phase: str, bottleneck: Bottleneck) -> float:
    stage = round(max(0.0, stage_ft) * 10.0) / 10.0
    if phase == "rising":
        return route_to_stage(bottleneck, stage, 0.4)
    if phase == "slack":
        volume = route_to_stage(bottleneck, stage, 0.4)
        for _ in range(round(0.25 * 3600 / DT_SECONDS)):
            volume = advance_storage(volume, stage, bottleneck)
        return volume
    return route_from_crest_to_stage(bottleneck, stage, stage + 2.5, 0.4)


def nearest(value: float, choices: tuple[float, ...]) -> float:
    return min(choices, key=lambda candidate: abs(candidate - value))


def predict_v20(
    stage_ft: float,
    phase: str,
    event: Hydrograph,
    bottleneck: Bottleneck,
) -> float:
    stage = round(max(0.0, stage_ft) * 10.0) / 10.0
    if phase in ("rising", "slack"):
        rate = nearest(event.rise_rate_ft_per_hour, V20_RISE_RATES_FT_PER_HOUR)
        volume = route_to_stage(bottleneck, stage, rate)
        if phase == "slack":
            for _ in range(round(0.25 * 3600 / DT_SECONDS)):
                volume = advance_storage(volume, stage, bottleneck)
        return volume
    prior_crest = nearest(event.peak_ft, V20_PRIOR_CRESTS_FT)
    return route_from_crest_to_stage(bottleneck, stage, prior_crest, 0.79)


def error_metrics(reference: np.ndarray, prediction: np.ndarray, capacity: float) -> dict[str, float]:
    difference = prediction - reference
    scale = max(capacity, 1.0)
    return {
        "normalizedRmse": float(np.sqrt(np.mean(difference**2)) / scale),
        "normalizedMae": float(np.mean(np.abs(difference)) / scale),
        "maximumOverprediction": float(max(0.0, np.max(difference)) / scale),
        "maximumUnderprediction": float(max(0.0, -np.min(difference)) / scale),
    }


def combine_metrics(records: list[dict[str, float]]) -> dict[str, float]:
    return {
        key: float(np.mean([record[key] for record in records]))
        for key in records[0]
    }


def main() -> None:
    args = parse_args()
    events = [
        Hydrograph(peak, rise, hold, fall)
        for peak in (4.0, 5.0, 6.5, 8.5)
        for rise in V20_RISE_RATES_FT_PER_HOUR
        for hold in (0.0, 0.75, 1.5)
        for fall in V20_RISE_RATES_FT_PER_HOUR
    ]
    model_records: dict[str, list[dict[str, float]]] = {
        "equilibrium": [],
        "v19FixedPhase": [],
        "v20HistoryFamily": [],
    }
    bottleneck_records = []
    for bottleneck in BOTTLENECKS:
        local: dict[str, list[dict[str, float]]] = {key: [] for key in model_records}
        for event in events:
            routed = route_event(event, bottleneck)
            reference = routed["volume_ft3"]
            capacity = bottleneck.storage_area_ft2 * max(event.peak_ft, 1.0)
            equilibrium = np.asarray([
                predict_equilibrium(stage, bottleneck)
                for stage in routed["stage_ft"]
            ])
            v19 = np.asarray([
                predict_v19(stage, str(phase), bottleneck)
                for stage, phase in zip(routed["stage_ft"], routed["phase"])
            ])
            v20 = np.asarray([
                predict_v20(stage, str(phase), event, bottleneck)
                for stage, phase in zip(routed["stage_ft"], routed["phase"])
            ])
            for name, prediction in (
                ("equilibrium", equilibrium),
                ("v19FixedPhase", v19),
                ("v20HistoryFamily", v20),
            ):
                metrics = error_metrics(reference, prediction, capacity)
                local[name].append(metrics)
                model_records[name].append(metrics)
        one_hour_volume = (
            WEIR_COEFFICIENT_CFS * bottleneck.width_ft * 1.0**1.5 * 3600.0
        )
        bottleneck_records.append(
            {
                "name": bottleneck.name,
                "crestNavd88Ft": bottleneck.crest_ft,
                "openingWidthFt": bottleneck.width_ft,
                "newlyConnectedAreaFt2": bottleneck.storage_area_ft2,
                "newlyConnectedAreaAcres": bottleneck.storage_area_ft2 / 43_560.0,
                "oneHourVolumeAtOneFootHeadFt3": one_hour_volume,
                "meanDepthIfSpreadAcrossWholeAreaInches": (
                    one_hour_volume / bottleneck.storage_area_ft2 * 12.0
                ),
                "metrics": {name: combine_metrics(rows) for name, rows in local.items()},
            }
        )

    result = {
        "schema": "north-wildwood-atlas-benchmark-v1",
        "reference": (
            "60-second finite-storage routing with bidirectional submerged "
            "broad-crested-weir flow over each full hydrograph"
        ),
        "scenarioCount": len(events) * len(BOTTLENECKS),
        "hydrographCount": len(events),
        "riseRatesFtPerHour": list(V20_RISE_RATES_FT_PER_HOUR),
        "priorCrestFamiliesNavd88Ft": list(V20_PRIOR_CRESTS_FT),
        "aggregateMetrics": {
            name: combine_metrics(rows) for name, rows in model_records.items()
        },
        "assetBudget": {
            "v19PngCount": 3 * 221 * 2,
            "v20PngCountThrough10Ft": (
                len(V20_RISE_RATES_FT_PER_HOUR)
                + 1  # one explicit short-crest family
                + len(V20_PRIOR_CRESTS_FT)
            ) * 101 * 2,
        },
        "bottlenecks": bottleneck_records,
    }
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
