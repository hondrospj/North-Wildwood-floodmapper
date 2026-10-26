#!/usr/bin/env python3
"""Exercise generation reuse/validation on tiny fixtures without running ANUGA."""
from __future__ import annotations

import argparse
import ast
import contextlib
import copy
import io
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "model/src"))
import cache_contract as cache
import publish_bunny as publisher
import run_pipeline as pipeline
import validate_products as validator

CYCLE = "20261026T0000Z"
ORIGINAL = json.loads((ROOT / "model/config/north_wildwood.json").read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def record(root, path):
    return {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size,
            "sha256": cache.sha256_file(path)}


def make_fixture(root):
    config = copy.deepcopy(ORIGINAL)
    for name in ("prepare_terrain.py", "run_anuga.py", "render_physics.py", "validate_products.py", "cache_contract.py"):
        target = root / "model/src" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "model/src" / name, target)
    terrain = []
    for key in ("computationalDem", "displayDem", "bulkheadMask"):
        target = root / config["terrain"][key]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"tiny identity fixture; not a hydraulic raster")
        terrain.append(target)
    write_json(root / "model/cache/terrain_manifest.json", {
        "configSha256": cache.terrain_config_fingerprint(config),
        "builderSha256": cache.sha256_file(root / "model/src/prepare_terrain.py"),
        "inputs": {"dem": record(root, terrain[0])},
        "outputs": {str(i): record(root, p) for i, p in enumerate(terrain)},
        "tileFingerprints": [record(root, terrain[0])],
    })
    frames = [{"timeUtc": f"2026-10-26T04:{minute:02d}:00Z", "secondsFromModelStart": minute * 60,
               "navd88M": 1., "navd88Ft": 1. / .3048} for minute in (0, 15)]
    guidance = {"cycleId": CYCLE, "scenarios": {s: frames for s in config["petss"]["scenarios"]}}
    write_json(root / "model/state/latest_petss.json", guidance)
    for scenario in config["petss"]["scenarios"]:
        simulation = cache.simulation_identity(root, config, guidance, scenario)
        rendered = cache.render_identity(root, config, simulation)
        run = root / "model/runs" / CYCLE / scenario
        public = run / "public"
        public.mkdir(parents=True)
        write_json(run / "run_manifest.json", {
            "status": "complete", "cycleId": CYCLE, "scenario": scenario,
            "simulationIdentity": simulation, "output": {"frameCount": 2, "intervalSeconds": 900},
            "qualitySummary": {"maximumSpeedMps": .1},
            "domain": {"triangleCount": 1, "openBoundaryEdgeCount": 1},
        })
        # Only the pipeline's availability check reads these sentinel files.
        hydraulic = run / "hydraulic"
        hydraulic.mkdir()
        (hydraulic / "stage_centroid_m.npy").write_bytes(b"not executed")
        (hydraulic / "mesh.npz").write_bytes(b"not executed")
        products = []
        for i, frame in enumerate(frames):
            files = {}
            for kind in ("visible", "impact", "query"):
                path = public / f"{i}-{kind}.png"
                values = np.array([[[0, 100 * (i + 1), 1]]], dtype=np.uint8) if kind == "query" else np.ones((1, 1), dtype=np.uint8)
                Image.fromarray(values).save(path)
                files[kind] = record(public, path)
            products.append({"timeUtc": frame["timeUtc"], "modelTimeSeconds": frame["secondsFromModelStart"],
                "boundaryStageNavd88M": frame["navd88M"], "boundaryStageNavd88Ft": frame["navd88Ft"],
                "wetPixelCount": 1, "maximumDepthM": (i + 1) / 10, **files})
        write_json(public / "manifest.json", {
            "status": "complete", "cycleId": CYCLE, "scenario": scenario,
            "simulationIdentitySha256": simulation["sha256"], "renderIdentity": rendered,
            "frameCount": 2, "frameIntervalSeconds": 900, "frames": products,
            "dailyMaximums": [{"dateLocal": "2026-10-26", **{k: products[-1][k] for k in ("visible", "impact", "query")}}],
            "image": {"width": 1, "height": 1}, "boundsWgs84": [[38.99, -74.82], [39.03, -74.78]],
        })
    return config, guidance


def main_body(name, root, config_path):
    """Execute the real CLI body only up to its reuse/rejection boundary.

    ANUGA, rasterio and SciPy are deliberately unnecessary for these branches.
    No simulated or rendered output is produced by these tests.
    """
    tree = ast.parse((ROOT / "model/src" / name).read_text())
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
    ns = dict(argparse=argparse, Path=Path, ROOT=root, DEFAULT_CONFIG=config_path,
              json=json, np=np, math=math, shutil=shutil,
              simulation_identity=cache.simulation_identity, render_identity=cache.render_identity,
              identity_matches=cache.identity_matches, anuga=None)
    exec(compile(ast.Module(body=[main], type_ignores=[]), name, "exec"), ns)
    return ns["main"]


class GenerationIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config, self.guidance = make_fixture(self.root)
        self.config_path = self.root / "model/config/current.json"
        write_json(self.config_path, self.config)
        for module in (pipeline, validator, publisher):
            patch = mock.patch.object(module, "ROOT", self.root)
            patch.start()
            self.addCleanup(patch.stop)

    def call_pipeline(self, config=None, publish=False, force=False, pointer=None):
        write_json(self.config_path, config or self.config)
        commands = []
        argv = ["run_pipeline.py", "--config", str(self.config_path), "--skip-fetch"]
        if not publish:
            argv.append("--no-publish")
        if force:
            argv.append("--force")
        with mock.patch.object(sys, "argv", argv), mock.patch.object(pipeline, "run_step", side_effect=lambda label, cmd: commands.append((label, cmd)) or 0.), mock.patch.object(pipeline, "remote_pointer", return_value=pointer or {}), contextlib.redirect_stdout(io.StringIO()):
            pipeline.main()
        return commands, json.loads((self.root / "model/state/last_pipeline.json").read_text())

    def validate(self, config=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return [validator.validate_scenario(config or self.config, CYCLE, s) for s in self.config["petss"]["scenarios"]]

    def test_unchanged_reuse_and_actual_validator_acceptance(self):
        commands, status = self.call_pipeline()
        self.assertEqual(status["status"], "complete-local")
        self.assertEqual(len(commands), 1)
        self.assertIn("validate_products.py", commands[0][1][2])
        self.assertEqual(len(self.validate()), 3)

    def test_all_five_audit_variants_invalidate_expected_stages(self):
        cases = ("friction", "solver", "domain", "builder", "render")
        for case in cases:
            with self.subTest(case=case):
                config = copy.deepcopy(self.config)
                builder = self.root / "model/src/run_anuga.py"
                original_builder = builder.read_text()
                if case == "friction": config["friction"]["developedManningN"] = .11
                if case == "solver": config["solver"]["flowAlgorithm"] = "DE1"
                if case == "domain": config["domain"]["meshCellM"] = 40.
                if case == "builder": builder.write_text(original_builder.replace('float(friction_config["openWaterManningN"])', 'float(friction_config["openWaterManningN"]) * 2.', 1))
                if case == "render": config["render"]["minimumWetDepthM"] = .5
                try:
                    commands, _ = self.call_pipeline(config)
                    simulations = [cmd for _, cmd in commands if "model/src/run_anuga.py" in cmd]
                    renders = [cmd for _, cmd in commands if "model/src/render_physics.py" in cmd]
                    self.assertEqual(len(simulations), 0 if case == "render" else 3)
                    self.assertEqual(len(renders), 3)
                    self.assertTrue(all("--force" in cmd for cmd in simulations))
                    if case == "render": self.assertTrue(all("--force" in cmd for cmd in renders))
                    with self.assertRaisesRegex(RuntimeError, "identity"):
                        self.validate(config)
                finally:
                    builder.write_text(original_builder)

    def test_force_rebuilds_unchanged_products(self):
        commands, _ = self.call_pipeline(force=True)
        rebuilds = [cmd for _, cmd in commands if "model/src/run_anuga.py" in cmd or "model/src/render_physics.py" in cmd]
        self.assertEqual(len(rebuilds), 6)
        self.assertTrue(all("--force" in cmd for cmd in rebuilds))

    def test_render_change_rebuilds_pruned_hydraulic_states(self):
        for scenario in self.config["petss"]["scenarios"]:
            shutil.rmtree(self.root / "model/runs" / CYCLE / scenario / "hydraulic")
        config = copy.deepcopy(self.config); config["render"]["minimumWetDepthM"] = .5
        commands, _ = self.call_pipeline(config)
        self.assertEqual(sum("model/src/run_anuga.py" in cmd for _, cmd in commands), 3)
        self.assertEqual(sum("model/src/render_physics.py" in cmd for _, cmd in commands), 3)

    def test_renderer_implementation_change_invalidates_only_render(self):
        path = self.root / "model/src/render_physics.py"
        path.write_text(path.read_text().replace('"#7DF9FF"', '"#7DF9FE"', 1))
        commands, _ = self.call_pipeline()
        self.assertEqual(sum("model/src/run_anuga.py" in cmd for _, cmd in commands), 0)
        self.assertEqual(sum("model/src/render_physics.py" in cmd for _, cmd in commands), 3)
        with self.assertRaisesRegex(RuntimeError, "render identity"):
            self.validate()

    def test_boundary_and_terrain_content_changes_invalidate_same_cycle(self):
        for kind in ("boundary", "terrain"):
            with self.subTest(kind=kind):
                if kind == "boundary":
                    guidance = copy.deepcopy(self.guidance)
                    guidance["scenarios"]["mean"][0]["navd88M"] += .1
                    write_json(self.root / "model/state/latest_petss.json", guidance)
                else:
                    write_json(self.root / "model/state/latest_petss.json", self.guidance)
                    (self.root / self.config["terrain"]["bulkheadMask"]).write_bytes(b"changed terrain")
                commands, _ = self.call_pipeline()
                self.assertTrue(any("model/src/run_anuga.py" in cmd for _, cmd in commands))
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    self.validate()

    def test_direct_runner_reuses_only_matching_effective_arguments(self):
        main = main_body("run_anuga.py", self.root, self.config_path)
        argv = ["run_anuga.py", "--config", str(self.config_path), "--petss", str(self.root / "model/state/latest_petss.json")]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as output:
            main()
        self.assertIn("Completed matching run", output.getvalue())
        for override in (("--mesh-cell-m", "40"), ("--constant-stage-m", "9"), ("--threads", "1"), ("--output-interval-seconds", "300")):
            with self.subTest(override=override), mock.patch.object(sys, "argv", argv + list(override)):
                with self.assertRaisesRegex(RuntimeError, "--force"):
                    main()
        self.assertTrue((self.root / "model/runs" / CYCLE / "mean/public/manifest.json").is_file())

    def test_direct_renderer_reuses_only_matching_render_settings(self):
        main = main_body("render_physics.py", self.root, self.config_path)
        argv = ["render_physics.py", "--config", str(self.config_path), "--petss", str(self.root / "model/state/latest_petss.json")]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as output:
            main()
        self.assertIn("Completed matching render", output.getvalue())
        config = copy.deepcopy(self.config)
        config["render"]["minimumWetDepthM"] = .5
        write_json(self.config_path, config)
        with mock.patch.object(sys, "argv", argv), self.assertRaisesRegex(RuntimeError, "--force"):
            main()
        config["friction"]["developedManningN"] = .11
        write_json(self.config_path, config)
        with mock.patch.object(sys, "argv", argv), self.assertRaisesRegex(RuntimeError, "Rebuild the simulation"):
            main()

    def test_legacy_manifests_without_identities_fail_closed(self):
        path = self.root / "model/runs" / CYCLE / "mean/run_manifest.json"
        manifest = json.loads(path.read_text()); manifest.pop("simulationIdentity"); write_json(path, manifest)
        commands, _ = self.call_pipeline()
        self.assertTrue(any("model/src/run_anuga.py" in cmd for _, cmd in commands))
        with self.assertRaisesRegex(RuntimeError, "identity"):
            self.validate()

    def test_published_shortcut_requires_current_effective_identities(self):
        identities = cache.product_identities(self.root, self.config, self.guidance)
        pointer = {"status": "complete", "cycleId": CYCLE, "productIdentitySha256ByScenario": identities}
        write_json(self.root / "model/state" / f"published_{CYCLE}_pointer.json", pointer)
        commands, status = self.call_pipeline(publish=True, pointer=pointer)
        self.assertEqual(commands, [])
        self.assertEqual(status["status"], "skipped-current")
        config = copy.deepcopy(self.config); config["friction"]["developedManningN"] = .11
        commands, status = self.call_pipeline(config, publish=True, pointer=pointer)
        self.assertEqual(status["status"], "complete")
        self.assertEqual(sum("model/src/run_anuga.py" in cmd for _, cmd in commands), 3)

    def test_publication_rejects_stale_validation_or_changed_manifests(self):
        results = self.validate()
        identities = cache.product_identities(self.root, self.config, self.guidance)
        validation = {"scenarios": results, "productIdentitySha256ByScenario": identities}
        self.assertEqual(publisher.validate_publication_inputs(self.config, self.guidance, CYCLE, validation), identities)
        config = copy.deepcopy(self.config); config["render"]["minimumWetDepthM"] = .5
        with self.assertRaisesRegex(RuntimeError, "stale"):
            publisher.validate_publication_inputs(config, self.guidance, CYCLE, validation)
        path = self.root / "model/runs" / CYCLE / "mean/public/manifest.json"
        manifest = json.loads(path.read_text()); manifest["extra"] = "changed after validation"; write_json(path, manifest)
        with self.assertRaisesRegex(RuntimeError, "changed since validation"):
            publisher.validate_publication_inputs(self.config, self.guidance, CYCLE, validation)

    def test_dependencies_and_identity_record_tampering_invalidate(self):
        expected = cache.simulation_identity(self.root, self.config, self.guidance, "mean")
        changed = copy.deepcopy(expected); changed["friction"]["developedManningN"] = .11
        self.assertFalse(cache.identity_matches(changed, expected))
        with mock.patch.object(cache, "dependency_versions", return_value={"anuga": "different-engine"}):
            self.assertNotEqual(expected["sha256"], cache.simulation_identity(self.root, self.config, self.guidance, "mean")["sha256"])

    def test_unknown_anuga_package_version_uses_conda_build_identity(self):
        path = self.root / "conda-meta/anuga-fixture.json"
        write_json(path, {"version": "3.3.0", "build": "build-a", "build_number": 0})
        with mock.patch.object(cache.metadata, "version", return_value="0.0.0+unknown"), mock.patch.object(cache.sys, "prefix", str(self.root)):
            before = cache.dependency_versions(("anuga",))
            write_json(path, {"version": "3.3.0", "build": "build-b", "build_number": 1})
            self.assertNotEqual(before, cache.dependency_versions(("anuga",)))
            self.assertEqual(before["anuga"]["version"], "3.3.0")


if __name__ == "__main__":
    unittest.main()
