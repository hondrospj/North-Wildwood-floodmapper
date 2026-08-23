#!/usr/bin/env python3
"""Unit checks for the site-agnostic hydraulic-mask sequence stabilizer."""

from __future__ import annotations

import numpy as np

from hydraulic_mask_sequence import (
    HydraulicMaskSequence,
    assert_temporal_invariant,
    repair_small_enclosed_holes,
)


def main() -> None:
    first = np.zeros((7, 9), dtype=bool)
    first[2:5, 2:7] = True
    first[3, 4] = False
    eligible = np.ones(first.shape, dtype=bool)

    repaired, count = repair_small_enclosed_holes(
        first,
        eligible,
        max_hole_pixels=1,
    )
    if count != 1 or not repaired[3, 4]:
        raise AssertionError("A one-cell eligible enclosed hole was not repaired")

    blocked = first.copy()
    blocked_eligible = eligible.copy()
    blocked_eligible[3, 4] = False
    blocked_repair, blocked_count = repair_small_enclosed_holes(
        blocked,
        blocked_eligible,
        max_hole_pixels=1,
    )
    if blocked_count or blocked_repair[3, 4]:
        raise AssertionError("Hole repair crossed an ineligible hydraulic cell")

    sequence = HydraulicMaskSequence(max_hole_pixels=1)
    rising_1 = sequence.update(first, "filling", eligible)
    rising_candidate = rising_1.copy()
    rising_candidate[:, 2] = False  # Simulate a threshold/mask regression.
    rising_candidate[1, 4] = True
    rising_2 = sequence.update(rising_candidate, "filling", eligible)
    assert_temporal_invariant(rising_1, rising_2, "filling")
    if not np.all(rising_2[rising_1]):
        raise AssertionError("Filling did not preserve the prior wet footprint")

    crest_candidate = rising_2.copy()
    crest_candidate[3, 3] = False
    crest = sequence.update(crest_candidate, "slack", eligible)
    assert_temporal_invariant(rising_2, crest, "filling")

    draining_candidate = crest.copy()
    draining_candidate[1, 7] = True  # Penalty release must not add this cell.
    draining_candidate[2, 2] = False
    draining = sequence.update(draining_candidate, "draining", eligible)
    assert_temporal_invariant(crest, draining, "draining")
    if draining[1, 7]:
        raise AssertionError("Drainage admitted a cell outside the crest mask")
    if draining[2, 2]:
        raise AssertionError("Drainage failed to remove a dry candidate cell")

    if sequence.diagnostics.frames != 4:
        raise AssertionError("The stabilizer changed the source-frame count")
    if sequence.diagnostics.filling_pixels_preserved <= 0:
        raise AssertionError("The filling regression was not diagnosed")
    if sequence.diagnostics.draining_pixels_rejected != 1:
        raise AssertionError("The post-crest admission was not diagnosed")

    print(
        {
            "status": "passed",
            "inputFrames": 4,
            "outputFrames": sequence.diagnostics.frames,
            "frameMultiplier": 1.0,
            "fillingPixelsPreserved": (
                sequence.diagnostics.filling_pixels_preserved
            ),
            "drainingPixelsRejected": (
                sequence.diagnostics.draining_pixels_rejected
            ),
            "holePixelsRepaired": (
                sequence.diagnostics.enclosed_hole_pixels_repaired
            ),
        }
    )


if __name__ == "__main__":
    main()
