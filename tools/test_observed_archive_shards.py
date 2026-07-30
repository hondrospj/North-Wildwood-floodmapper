#!/usr/bin/env python3
"""Regression checks for the browser-optimized tide archive."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check_source(
    canonical_path: str,
    index_path: str,
    source: str,
) -> None:
    canonical = read_json(ROOT / canonical_path)
    index = read_json(ROOT / index_path)

    if index.get("schema") != "north-wildwood-observed-day-index-v1":
        raise AssertionError(f"{source} index schema is incorrect")
    if index.get("source") != source:
        raise AssertionError(f"{source} index source is incorrect")

    canonical_days = canonical.get("days", [])
    index_days = index.get("days", [])
    if len(index_days) != len(canonical_days):
        raise AssertionError(f"{source} index day count differs from the canonical archive")
    if not index_days:
        raise AssertionError(f"{source} index is empty")

    canonical_by_date = {day["d"]: day for day in canonical_days}
    indexed_by_date = {day["d"]: day for day in index_days}
    if set(indexed_by_date) != set(canonical_by_date):
        raise AssertionError(f"{source} index dates differ from the canonical archive")

    shard_template = str(index.get("shardPathTemplate", ""))
    years = sorted({date[:4] for date in canonical_by_date})
    reconstructed: dict[str, dict] = {}
    for year in years:
        relative = shard_template.replace("{year}", year).removeprefix("./")
        shard_path = ROOT / relative
        if not shard_path.exists():
            raise AssertionError(f"Missing {source} shard for {year}")
        shard = read_json(shard_path)
        if shard.get("schema") != "north-wildwood-observed-year-v1":
            raise AssertionError(f"{source} {year} shard schema is incorrect")
        if shard.get("source") != source or str(shard.get("year")) != year:
            raise AssertionError(f"{source} {year} shard metadata is incorrect")
        for day in shard.get("days", []):
            reconstructed[day["d"]] = day

    if reconstructed != canonical_by_date:
        raise AssertionError(f"{source} shards do not exactly reconstruct the canonical archive")

    for date_key, row in indexed_by_date.items():
        canonical_row = canonical_by_date[date_key]
        if row.get("p") != canonical_row.get("p") or row.get("c") != canonical_row.get("c"):
            raise AssertionError(f"{source} index metadata differs on {date_key}")


def main() -> None:
    check_source(
        canonical_path="observed15min.json",
        index_path="observed_archive_index.json",
        source="stone-harbor",
    )
    check_source(
        canonical_path="lewes_hourly.json",
        index_path="lewes_archive_index.json",
        source="lewes",
    )
    print("North Wildwood observed archive shard checks passed")


if __name__ == "__main__":
    main()
