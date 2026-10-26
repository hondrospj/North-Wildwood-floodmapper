"""Content-based identities for terrain, simulations and rendered products."""
from __future__ import annotations
import hashlib
from importlib import metadata
import json
import math
from pathlib import Path
import sys


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


def content_identity(schema: str, value: dict) -> dict:
    """Keep the effective inputs inspectable as well as giving them a stable key."""
    payload = {"schema": schema, **value}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {**payload, "sha256": hashlib.sha256(encoded.encode()).hexdigest()}


def dependency_versions(names: tuple[str, ...]) -> dict:
    versions = {}
    for name in names:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = None
        # Some ANUGA conda builds expose an unknown Python package version.
        # Match the runner's fallback to conda's actual engine build metadata.
        if name == "anuga" and versions[name] in (None, "unknown", "0.0.0+unknown"):
            for path in sorted((Path(sys.prefix) / "conda-meta").glob("anuga-*.json")):
                try:
                    record = json.loads(path.read_text())
                    if record.get("version"):
                        versions[name] = {key: record.get(key) for key in ("version", "build", "build_number")}
                except (OSError, ValueError):
                    continue
    return versions


def input_records(root: Path, paths: list[str]) -> list[dict]:
    # Missing inputs fail closed instead of accepting an old cache entry.
    return [{"path": path, "sha256": sha256_file(root / path)} for path in paths]


def simulation_identity(root: Path, config: dict, guidance: dict, scenario: str,
                        overrides: dict | None = None) -> dict:
    """Identify the actual boundary, terrain, settings and implementation used.

    Override names mirror run_anuga's CLI. Resolved defaults ensure an explicit
    default and an omitted option share an identity, while diagnostic overrides
    can never be mistaken for a production run.
    """
    options = overrides or {}
    curve = guidance["scenarios"][scenario]
    final_time = float(curve[-1]["secondsFromModelStart"])
    if options.get("duration_hours") is not None:
        final_time = min(final_time, float(options["duration_hours"]) * 3600.0)
    domain = {**config["domain"],
              "meshCellM": float(options.get("mesh_cell_m") or config["domain"]["meshCellM"]),
              "meshType": options.get("mesh_type") or config["domain"]["meshType"]}
    solver = {**config["solver"],
              "openMpThreads": int(options.get("threads") or config["solver"]["openMpThreads"])}
    interval = int(options.get("output_interval_seconds") or config["petss"]["outputIntervalSeconds"])
    boundary = [{"timeUtc": row["timeUtc"],
                 "secondsFromModelStart": float(row["secondsFromModelStart"]),
                 "navd88M": float(options["constant_stage_m"] if options.get("constant_stage_m") is not None else row["navd88M"])}
                for row in curve]
    return content_identity("north-wildwood-simulation-identity-v1", {
        "model": {key: config.get(key) for key in
                  ("modelId", "modelCrs", "horizontalUnits", "verticalDatum", "verticalUnits")},
        "cycleId": guidance["cycleId"], "scenario": scenario,
        "domain": domain, "solver": solver, "friction": config["friction"],
        "terrain": config["terrain"], "boundary": boundary,
        "durationSeconds": final_time, "outputIntervalSeconds": interval,
        "frameCount": int(math.floor(final_time / interval)) + 1,
        "inputs": input_records(root, [config["terrain"]["computationalDem"],
                                        config["terrain"]["bulkheadMask"],
                                        "model/cache/terrain_manifest.json"]),
        "builders": input_records(root, ["model/src/run_anuga.py", "model/src/cache_contract.py"]),
        "dependencies": dependency_versions(("anuga", "numpy", "scipy", "rasterio")),
    })


def render_identity(root: Path, config: dict, simulation: dict) -> dict:
    return content_identity("north-wildwood-render-identity-v1", {
        "simulationIdentitySha256": simulation["sha256"],
        "render": config["render"],
        "presentation": {key: config.get(key) for key in ("modelId", "town", "verticalDatum", "verticalUnits")},
        "inputs": input_records(root, [config["terrain"]["computationalDem"], config["terrain"]["displayDem"]]),
        "builders": input_records(root, ["model/src/render_physics.py", "model/src/validate_products.py", "model/src/cache_contract.py"]),
        "dependencies": dependency_versions(("numpy", "scipy", "rasterio", "Pillow", "pyproj")),
    })


def identity_matches(recorded: dict | None, expected: dict) -> bool:
    # Compare the complete canonical record: copying a stale sha onto modified
    # metadata must not make it a valid identity.
    return isinstance(recorded, dict) and recorded == expected


def product_identities(root: Path, config: dict, guidance: dict) -> dict[str, str]:
    return {scenario: render_identity(root, config, simulation_identity(root, config, guidance, scenario))["sha256"]
            for scenario in config["petss"]["scenarios"]}


def published_pointer_matches(pointer: dict, cycle_id: str, identities: dict[str, str]) -> bool:
    return (isinstance(pointer, dict) and pointer.get("status") == "complete" and pointer.get("cycleId") == cycle_id
            and pointer.get("productIdentitySha256ByScenario") == identities)


def spatial_lookup_fingerprint(coordinates, transform, crs, row_slice, column_slice) -> str:
    import numpy as np
    array = np.ascontiguousarray(coordinates, dtype="<f8")
    digest = hashlib.sha256(array.tobytes())
    digest.update(json.dumps({"shape": array.shape, "transform": tuple(transform), "crs": str(crs),
                              "rows": [row_slice.start, row_slice.stop],
                              "columns": [column_slice.start, column_slice.stop]}, sort_keys=True).encode())
    return digest.hexdigest()
