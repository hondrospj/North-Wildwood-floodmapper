#!/usr/bin/env python3
"""Inventory non-source terrain components enclosed by the tidal source."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy import ndimage


WIDTH = 10_930
HEIGHT = 14_120
NODATA = np.int16(-32768)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    elevation = np.memmap(
        args.graph / "elevation10.raw",
        dtype="<i2",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    source = np.memmap(
        args.graph / "source_flag.raw",
        dtype="u1",
        mode="r",
        shape=(HEIGHT, WIDTH),
    )
    valid = elevation != NODATA
    terrain = valid & (source == 0)
    labels, component_count = ndimage.label(
        terrain,
        structure=np.asarray([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8),
    )
    counts = np.bincount(labels.ravel())
    exterior = np.zeros(component_count + 1, dtype=bool)
    exterior[np.unique(labels[0, :])] = True
    exterior[np.unique(labels[-1, :])] = True
    exterior[np.unique(labels[:, 0])] = True
    exterior[np.unique(labels[:, -1])] = True
    invalid = ~valid
    horizontal = invalid[:, 1:] & terrain[:, :-1]
    exterior[np.unique(labels[:, :-1][horizontal])] = True
    horizontal = invalid[:, :-1] & terrain[:, 1:]
    exterior[np.unique(labels[:, 1:][horizontal])] = True
    vertical = invalid[1:, :] & terrain[:-1, :]
    exterior[np.unique(labels[:-1, :][vertical])] = True
    vertical = invalid[:-1, :] & terrain[1:, :]
    exterior[np.unique(labels[1:, :][vertical])] = True
    exterior[0] = True

    enclosed_ids = np.flatnonzero(~exterior)
    enclosed_ids = enclosed_ids[enclosed_ids != 0]
    order = enclosed_ids[np.argsort(counts[enclosed_ids])[::-1]]
    objects = ndimage.find_objects(labels)
    largest = []
    for component_id in order[:50]:
        y_slice, x_slice = objects[int(component_id) - 1]
        largest.append(
            {
                "componentId": int(component_id),
                "cellCount": int(counts[component_id]),
                "acres": float(counts[component_id] / 43_560.0),
                "xMin": int(x_slice.start),
                "xMaxExclusive": int(x_slice.stop),
                "yMin": int(y_slice.start),
                "yMaxExclusive": int(y_slice.stop),
            }
        )
    report = {
        "schema": "north-wildwood-source-enclave-inventory-v1",
        "terrainComponentCount": int(component_count),
        "enclosedComponentCount": int(enclosed_ids.size),
        "enclosedCellCount": int(counts[enclosed_ids].sum()),
        "enclosedAcres": float(counts[enclosed_ids].sum() / 43_560.0),
        "largestEnclosedComponents": largest,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
