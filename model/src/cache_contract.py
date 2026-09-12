"""Content-based identities for terrain and spatial lookup products."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def terrain_config_fingerprint(config: dict) -> str:
    selected = {k: config.get(k) for k in ("modelCrs", "verticalDatum", "verticalUnits", "domain", "terrain")}
    return hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def terrain_manifest_matches(root: Path, config: dict, manifest: dict) -> bool:
    if manifest.get("configSha256") != terrain_config_fingerprint(config):
        return False
    if manifest.get("builderSha256") != sha256_file(root / "model/src/prepare_terrain.py"):
        return False
    records = [*manifest.get("inputs", {}).values(), *manifest.get("outputs", {}).values(), *manifest.get("tileFingerprints", [])]
    if not records or not manifest.get("tileFingerprints"):
        return False
    try:
        for row in records:
            if not row.get("path") or not row.get("sha256") or sha256_file(root / row["path"]) != row["sha256"]:
                return False
    except (OSError, KeyError, TypeError):
        return False
    return True


def spatial_lookup_fingerprint(coordinates, transform, crs, row_slice, column_slice) -> str:
    import numpy as np
    array = np.ascontiguousarray(coordinates, dtype="<f8")
    digest = hashlib.sha256(array.tobytes())
    digest.update(json.dumps({"shape": array.shape, "transform": tuple(transform), "crs": str(crs),
                              "rows": [row_slice.start, row_slice.stop],
                              "columns": [column_slice.start, column_slice.stop]}, sort_keys=True).encode())
    return digest.hexdigest()
