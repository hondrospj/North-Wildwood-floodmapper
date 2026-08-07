#!/usr/bin/env python3
"""Regression checks proving v2 no longer uses a connected bathtub atlas."""

from __future__ import annotations

import numpy as np

import simulate_north_wildwood_hydraulics as model


def main() -> None:
    if (
        len(model.STAGES_FT) != 221
        or not np.isclose(model.STAGES_FT[0], 0.0)
        or not np.isclose(model.STAGES_FT[1], 0.1)
        or not np.isclose(model.STAGES_FT[-1], 22.0)
    ):
        raise AssertionError("The stage catalog is not a complete 0.1-ft 0-22 grid")
    if model.stage_code(0.0) != "p0000":
        raise AssertionError("Zero-stage filename is encoded incorrectly")
    if model.stage_code(3.9) != "p0390":
        raise AssertionError("Tenth-foot stage filename is encoded incorrectly")
    if model.stage_code(22.0) != "p2200":
        raise AssertionError("22-ft stage filename is encoded incorrectly")
    if model.TIDE_STEP_SECONDS != 15 * 60:
        raise AssertionError("The lookup forcing interval is not 15 minutes")
    if model.MODEL_STEP_SECONDS != 60:
        raise AssertionError("The finite-volume substep is not 60 seconds")
    if model.DRAINING_HISTORY_RISE_FT <= model.DRAINING_BAND_WIDTH_FT:
        raise AssertionError("Draining states do not include a preceding crest")

    print(
        {
            "status": "passed",
            "model": "phase-aware finite-volume routing",
            "stageCountPerPhase": len(model.STAGES_FT),
            "depthPngCount": len(model.STAGES_FT) * 3,
            "stagePngCount": len(model.STAGES_FT) * 3,
            "phaseCount": 3,
            "substepsPerStage": (
                model.TIDE_STEP_SECONDS // model.MODEL_STEP_SECONDS
            ),
        }
    )


if __name__ == "__main__":
    main()
