#!/usr/bin/env python3
"""Build small tide-archive indexes and year shards for the browser.

The scheduled observed-data workflow still maintains the canonical compact
archives. This script derives:

* a lightweight Stone Harbor day index,
* a lightweight Lewes day index, and
* one compact payload per source/year.

The app can therefore render the archive calendar immediately and download
only the year that contains the day the user opens.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


STONE_SOURCE = "stone-harbor"
LEWES_SOURCE = "lewes"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_compact_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def build_index(source: dict[str, Any], source_key: str, path_template: str) -> dict[str, Any]:
    days = [
        {
            "d": day["d"],
            "p": day.get("p"),
            "c": day.get("c", "none"),
        }
        for day in source.get("days", [])
        if day.get("d")
    ]
    return {
        "schema": "north-wildwood-observed-day-index-v1",
        "source": source_key,
        "gaugeName": source.get("gaugeName") or source.get("stationName"),
        "stationId": source.get("site") or source.get("stationId"),
        "datum": source.get("datum", "NAVD88"),
        "timeZone": source.get("timeZone", "America/New_York"),
        "sourceResolutionMinutes": source.get("sourceResolutionMinutes")
        or source.get("intervalMinutes"),
        "archiveStartDate": source.get("archiveStartDate")
        or (days[0]["d"] if days else None),
        "archiveEndDate": source.get("archiveEndDate")
        or (days[-1]["d"] if days else None),
        "lastProcessedISO": source.get("lastProcessedISO")
        or source.get("lastIncrementalUpdateISO"),
        "stoneHarborCutoffDate": source.get("stoneHarborCutoffDate", "2007-10-01"),
        "shardPathTemplate": path_template,
        "days": days,
    }


def build_year_shards(
    source: dict[str, Any],
    source_key: str,
    shard_dir: Path,
) -> list[Path]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for day in source.get("days", []):
        date_key = str(day.get("d", ""))
        if len(date_key) >= 4:
            grouped[date_key[:4]].append(day)

    written: list[Path] = []
    for year, days in sorted(grouped.items()):
        path = shard_dir / source_key / f"{year}.json"
        payload = {
            "schema": "north-wildwood-observed-year-v1",
            "source": source_key,
            "year": int(year),
            "stationId": source.get("site") or source.get("stationId"),
            "stationName": source.get("gaugeName") or source.get("stationName"),
            "datum": source.get("datum", "NAVD88"),
            "timeZone": source.get("timeZone", "America/New_York"),
            "intervalMinutes": source.get("intervalMinutes"),
            "sourceResolutionMinutes": source.get("sourceResolutionMinutes")
            or source.get("intervalMinutes"),
            "days": days,
        }
        write_compact_json(path, payload)
        written.append(path)
    return written


def build(args: argparse.Namespace) -> dict[str, Any]:
    stone = load_json(args.stone_archive)
    lewes = load_json(args.lewes_archive)

    stone_index = build_index(
        stone,
        STONE_SOURCE,
        f"./{args.shard_dir.as_posix().rstrip('/')}/{STONE_SOURCE}/{{year}}.json",
    )
    lewes_index = build_index(
        lewes,
        LEWES_SOURCE,
        f"./{args.shard_dir.as_posix().rstrip('/')}/{LEWES_SOURCE}/{{year}}.json",
    )

    write_compact_json(args.stone_index, stone_index)
    write_compact_json(args.lewes_index, lewes_index)
    stone_shards = build_year_shards(stone, STONE_SOURCE, args.shard_dir)
    lewes_shards = build_year_shards(lewes, LEWES_SOURCE, args.shard_dir)

    return {
        "stoneIndex": str(args.stone_index),
        "stoneDays": len(stone_index["days"]),
        "stoneShards": len(stone_shards),
        "lewesIndex": str(args.lewes_index),
        "lewesDays": len(lewes_index["days"]),
        "lewesShards": len(lewes_shards),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stone-archive", type=Path, default=Path("observed15min.json"))
    parser.add_argument("--lewes-archive", type=Path, default=Path("lewes_hourly.json"))
    parser.add_argument("--stone-index", type=Path, default=Path("observed_archive_index.json"))
    parser.add_argument("--lewes-index", type=Path, default=Path("lewes_archive_index.json"))
    parser.add_argument("--shard-dir", type=Path, default=Path("observed_archive"))
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(build(parse_args()), indent=2))
