#!/usr/bin/env python3
"""Stage a validated forecast and observation snapshot over the GitHub Pages release."""

import argparse
import json
from pathlib import Path
import shutil

from release_data import GENERATED_DIRECTORIES, GENERATED_FILES, read_json, validate_data


FORECAST_PATHS = ("forecast.json", "data/experimental_petss_guidance.json")
ARCHIVE_INDEXES = ("observed_archive_index.json", "lewes_archive_index.json")


def stage_data(source, site, now=None):
    paths = sorted(GENERATED_FILES | {
        path.relative_to(source).as_posix()
        for directory in GENERATED_DIRECTORIES
        for path in (source / directory).rglob("*.json")
        if path.is_file()
    })
    for relative in paths:
        if not (source / relative).is_file():
            raise ValueError(f"Missing generated data: {relative}")

    receipt = validate_data(source, paths, now=now, operational_petss=True)
    verified_paths = list(FORECAST_PATHS)
    for relative in ARCHIVE_INDEXES:
        index = read_json(source / relative)
        template = index["shardPathTemplate"].removeprefix("./")
        for year in sorted({day["d"][:4] for day in index["days"]}):
            shard = template.format(year=year)
            if shard not in paths:
                raise ValueError(f"{relative} references missing shard {shard}")
        latest = template.format(year=index["archiveEndDate"][:4])
        if read_json(source / latest)["days"][-1]["d"] != index["archiveEndDate"]:
            raise ValueError(f"{relative} and {latest} have different end dates")
        verified_paths.extend((relative, latest))

    for relative in paths:
        target = site / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    return {**receipt, "verifiedPaths": verified_paths}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("site", type=Path)
    args = parser.parse_args()
    print(json.dumps(stage_data(args.source, args.site), indent=2))
