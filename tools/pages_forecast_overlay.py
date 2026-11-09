#!/usr/bin/env python3
"""Stage a validated PETSS forecast pair over the approved GitHub Pages site."""

import argparse
import json
from pathlib import Path
import shutil

from release_data import validate_operational_petss


FORECAST_PATHS = ("forecast.json", "data/experimental_petss_guidance.json")


def stage_forecast(source, site, now=None):
    receipt = validate_operational_petss(source, now=now)
    for relative in FORECAST_PATHS:
        shutil.copyfile(source / relative, site / relative)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("site", type=Path)
    args = parser.parse_args()
    print(json.dumps(stage_forecast(args.source, args.site), indent=2))
