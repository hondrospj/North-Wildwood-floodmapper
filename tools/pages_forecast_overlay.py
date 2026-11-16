#!/usr/bin/env python3
"""Stage generated forecast and observation data over a pinned Pages UI."""

import argparse
from datetime import date
from filecmp import cmp
import json
from pathlib import Path
import shutil

from release_data import GENERATED_DIRECTORIES, GENERATED_FILES, read_json, validate_data


OBSERVED_INDEXES = {
    "observed_archive_index.json": "observed_archive/stone-harbor",
    "lewes_archive_index.json": "observed_archive/lewes",
}
CITY_INDEXES = ("city-gauge/data/index.json", "city-gauge/comparison/index.json")


def generated_paths(source):
    paths = set(GENERATED_FILES).union(CITY_INDEXES)
    for prefix in GENERATED_DIRECTORIES:
        paths.update(path.relative_to(source).as_posix() for path in (source / prefix).rglob("*.json"))
    return sorted(paths)


def observed_coverage(source, available):
    """Require the immutable snapshot to include every indexed archive year."""
    latest = {}
    for path, directory in OBSERVED_INDEXES.items():
        index = read_json(source / path)
        years = {date.fromisoformat(day["d"]).year for day in index["days"]}
        missing = {f"{directory}/{year}.json" for year in years} - available
        if not years or missing:
            raise ValueError(f"{path}: missing indexed observation shards: {sorted(missing)}")
        day = index["days"][-1]
        shard_path = f"{directory}/{date.fromisoformat(day['d']).year}.json"
        shard = read_json(source / shard_path)
        if not shard["days"] or any(shard["days"][-1][key] != day[key] for key in ("d", "p", "c")):
            raise ValueError(f"{shard_path}: latest day differs from {path}")
        latest[path] = {"lastDate": day["d"], "shard": shard_path}
    for path in CITY_INDEXES:
        index = read_json(source / path)
        directory = Path(path).parent
        missing = {(directory / f"{int(year['year'])}.json").as_posix() for year in index["years"]} - available
        if missing:
            raise ValueError(f"{path}: missing indexed municipal gauge shards: {sorted(missing)}")
    return latest


def stage_pages_data(source, site, now=None):
    paths = generated_paths(source)
    for relative in paths:
        path = source / relative
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"Missing or invalid source data: {relative}")
    changed = [relative for relative in paths
               if not (site / relative).is_file() or not cmp(source / relative, site / relative, shallow=False)]
    receipt = validate_data(source, changed, now=now, operational_petss=True)
    receipt["observations"] = observed_coverage(source, set(paths))
    for relative in changed:
        destination = site / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, destination)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("site", type=Path)
    args = parser.parse_args()
    print(json.dumps(stage_pages_data(args.source, args.site), indent=2))
