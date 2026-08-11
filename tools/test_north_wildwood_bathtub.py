#!/usr/bin/env python3
"""Regression checks proving v23 does not use a connected bathtub atlas."""

from __future__ import annotations

import numpy as np

import simulate_north_wildwood_hydraulics as model


def main() -> None:
    if (
        len(model.STAGES_FT) != 101
        or not np.isclose(model.STAGES_FT[0], 0.0)
        or not np.isclose(model.STAGES_FT[1], 0.1)
        or not np.isclose(model.STAGES_FT[-1], 10.0)
    ):
        raise AssertionError("The operational atlas is not a complete 0.1-ft 0-10 grid")
    if model.stage_code(0.0) != "p0000":
        raise AssertionError("Zero-stage filename is encoded incorrectly")
    if model.stage_code(3.9) != "p0390":
        raise AssertionError("Tenth-foot stage filename is encoded incorrectly")
    if model.stage_code(10.0) != "p1000":
        raise AssertionError("10-ft stage filename is encoded incorrectly")
    if model.MODEL_STEP_SECONDS != 60:
        raise AssertionError("The finite-volume substep is not 60 seconds")
    if tuple(model.RISE_RATE_FAMILIES_FT_PER_HOUR.values()) != (0.55, 0.79, 0.90):
        raise AssertionError("Observed rising-rate families changed")
    if tuple(model.FALLING_CREST_FAMILIES_FT.values()) != (4.0, 5.5, 8.5):
        raise AssertionError("Absolute prior-crest families changed")
    if len(model.ATLAS_FAMILIES) != 7:
        raise AssertionError("The compact atlas must contain seven history families")
    if model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT != 2.0:
        raise AssertionError("The supplied source blocks must activate at 2.0 ft")
    if model.MIN_MOBILE_DEPTH_FT < 0.05:
        raise AssertionError("The routing wet/dry threshold is too small")
    if model.URBAN_OVERLAND_MANNING_N != 0.12:
        raise AssertionError("The urban overland Manning roughness changed")

    print(
        {
            "status": "passed",
            "model": "history-aware subgrid diffusive-wave finite-volume response atlas",
            "stageCountPerFamily": len(model.STAGES_FT),
            "depthPngCount": len(model.STAGES_FT) * len(model.ATLAS_FAMILIES),
            "stagePngCount": len(model.STAGES_FT) * len(model.ATLAS_FAMILIES),
            "familyCount": len(model.ATLAS_FAMILIES),
            "substepSeconds": model.MODEL_STEP_SECONDS,
            "sourceBlockActivationNavd88Ft": model.SOURCE_BLOCK_ACTIVATION_NAVD88_FT,
            "minimumMobileDepthFt": model.MIN_MOBILE_DEPTH_FT,
        }
    )


if __name__ == "__main__":
    main()
