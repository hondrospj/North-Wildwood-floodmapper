"""Align forecast boundary metadata with actual solver output times."""
from __future__ import annotations
from bisect import bisect_left
from datetime import datetime, timedelta
import math
from typing import Any

METRES_TO_FEET = 1 / 0.3048


def load_guidance_frames(
    guidance: dict[str, Any],
    scenario: str,
    frame_statistics: list[dict[str, Any]],
    constant_stage_m: float | None = None,
) -> list[dict[str, Any]]:
    """Align metadata with recorded solver times, including custom intervals."""
    if constant_stage_m is not None and not math.isfinite(float(constant_stage_m)):
        raise RuntimeError("Constant boundary stage must be finite")
    source = guidance["scenarios"][scenario]
    seconds = [float(frame["secondsFromModelStart"]) for frame in source]
    if not seconds or any(not math.isfinite(value) for value in seconds) or any(
        after <= before for before, after in zip(seconds, seconds[1:])
    ):
        raise RuntimeError("Guidance times must be finite and strictly increasing")
    origin = datetime.fromisoformat(source[0]["timeUtc"].replace("Z", "+00:00")) - timedelta(seconds=seconds[0])
    frames = []
    previous = -math.inf
    for statistic in frame_statistics:
        second = float(statistic["modelTimeSeconds"])
        if not math.isfinite(second) or second <= previous or second < seconds[0] or second > seconds[-1]:
            raise RuntimeError(f"Invalid or out-of-guidance model time: {second}")
        previous = second
        index = bisect_left(seconds, second)
        if index < len(seconds) and abs(seconds[index] - second) < 1e-6:
            frame = dict(source[index])
        else:
            before, after = source[index - 1], source[index]
            fraction = (second - seconds[index - 1]) / (seconds[index] - seconds[index - 1])
            frame = {
                **before,
                "secondsFromModelStart": second,
                "timeUtc": (origin + timedelta(seconds=second)).isoformat().replace("+00:00", "Z"),
                "navd88M": before["navd88M"] + fraction * (after["navd88M"] - before["navd88M"]),
                "navd88Ft": before["navd88Ft"] + fraction * (after["navd88Ft"] - before["navd88Ft"]),
                "isHourlySourcePoint": False,
            }
        if constant_stage_m is not None:
            frame["navd88M"] = float(constant_stage_m)
            frame["navd88Ft"] = float(constant_stage_m) * METRES_TO_FEET
        frames.append(frame)
    return frames

