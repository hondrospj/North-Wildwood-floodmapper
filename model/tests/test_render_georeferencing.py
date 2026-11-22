#!/usr/bin/env python3
"""Real GDAL regressions for optional physics PNG placement and alignment.

Run with the GIS environment; no ANUGA, network or production inputs are used.
"""
from __future__ import annotations

import contextlib
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "model/src"))
try:
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import transform as project
    import render_physics as renderer
except ModuleNotFoundError as error:
    GIS_IMPORT_ERROR = str(error)
else:
    GIS_IMPORT_ERROR = None
import cache_contract as cache
import validate_products as validator


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


def grid_manifest(profile):
    return {
        "schema": "north-wildwood-physics-forecast-v2",
        "image": {"width": profile["width"], "height": profile["height"],
                  "crs": "EPSG:3857", "coordinateSystem": "web-mercator",
                  "transform": list(profile["transform"])[:6]},
        "boundsWgs84": renderer.image_bounds_wgs84(
            profile["transform"], slice(0, profile["height"]),
            slice(0, profile["width"]), profile["crs"]),
    }


@unittest.skipIf(GIS_IMPORT_ERROR, f"Optional GIS runtime unavailable: {GIS_IMPORT_ERROR}")
class RenderGeoreferencingTests(unittest.TestCase):
    def test_real_domain_edge_and_center_pixels_match_browser_mercator_grid(self):
        config = json.loads((ROOT / "model/config/north_wildwood.json").read_text())
        domain = config["domain"]
        resolution = domain["terrainGridM"]
        width = round((domain["xmax"] - domain["xmin"]) / resolution)
        height = round((domain["ymax"] - domain["ymin"]) / resolution)
        native = {"width": width, "height": height, "crs": config["modelCrs"],
                  "transform": from_origin(domain["xmin"], domain["ymax"], resolution, resolution)}
        web = renderer.web_render_grid(native)
        manifest = grid_manifest(web)
        validator.validate_web_grid(manifest)
        ids = np.arange(1, width * height + 1, dtype=np.int32).reshape(height, width)
        actual_ids = renderer.warp_to_web_grid(ids, native, web)
        points = []
        # A small inset keeps each point inside the rotated native footprint.
        for column, row in [(8, 8), (web["width"] - 9, 8), (8, web["height"] - 9),
                            (web["width"] - 9, web["height"] - 9),
                            (web["width"] // 2, web["height"] // 2)]:
            x, y = web["transform"] * (column + .5, row + .5)
            source_x, source_y = project(web["crs"], native["crs"], [x], [y])
            source_column, source_row = ~native["transform"] * (source_x[0], source_y[0])
            source_column, source_row = math.floor(source_column), math.floor(source_row)
            self.assertEqual(int(actual_ids[row, column]), int(ids[source_row, source_column]))
            longitude, latitude = project(web["crs"], "EPSG:4326", [x], [y])
            points.append({"x": column, "y": row, "lon": longitude[0], "lat": latitude[0]})
        # Show this fixture catches the original edge-cell registration error.
        (south, west), (north, east) = renderer.image_bounds_wgs84(
            native["transform"], slice(0, height), slice(0, width), native["crs"])
        old_errors = []
        for column, row in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]:
            x, y = native["transform"] * (column + .5, row + .5)
            longitude, latitude = project(native["crs"], "EPSG:4326", [x], [y])
            old_column = math.floor((longitude[0] - west) / (east - west) * width)
            old_row = math.floor((north - latitude[0]) / (north - south) * height)
            old_errors.append(math.hypot(column - old_column, row - old_row))
        self.assertGreater(max(old_errors), 1)
        if shutil.which("node"):
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "grid.json"
                write_json(path, {"manifest": manifest, "points": points})
                result = subprocess.run(["node", str(ROOT / "tools/test_north_wildwood_physics_contract.mjs"),
                                         "--grid-fixture", str(path)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_real_renderer_preserves_depth_mask_arrivals_and_25_hour_day(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = copy.deepcopy(json.loads((ROOT / "model/config/north_wildwood.json").read_text()))
            config["petss"]["scenarios"] = ["mean"]
            for name in ("run_anuga.py", "render_physics.py", "frame_alignment.py", "validate_products.py",
                         "output_replacement.py", "cache_contract.py"):
                path = root / "model/src" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / "model/src" / name, path)
            height, width = 14, 12
            native_transform = from_origin(515300, 4320100, 5, 5)
            profile = {"driver": "GTiff", "height": height, "width": width, "count": 1,
                       "dtype": "float32", "crs": config["modelCrs"], "transform": native_transform,
                       "nodata": -9999.0}
            cell_ids = np.arange(width * height).reshape(height, width)
            terrain = (cell_ids % 11 * .02).astype(np.float32)
            valid = np.ones((height, width), dtype=bool)
            valid[[0, -1], :] = False
            valid[:, [0, -1]] = False
            valid[4:7, 5] = False
            for key in ("computationalDem", "displayDem", "bulkheadMask"):
                path = root / config["terrain"][key]
                path.parent.mkdir(parents=True, exist_ok=True)
                values = terrain if key == "computationalDem" else (
                    np.where(valid, terrain, -9999) if key == "displayDem" else np.zeros_like(terrain))
                with rasterio.open(path, "w", **profile) as dataset:
                    dataset.write(values.astype(np.float32), 1)
            write_json(root / "model/cache/terrain_manifest.json", {"fixture": "real tiny GIS rasters"})
            start = datetime(2026, 11, 1, 3, 45, tzinfo=timezone.utc)
            cycle = "20261101T0000Z"
            source_depths, curve = [], []
            for index in range(102):
                feet = 1.0 if index == 0 else (4.5 if index == 1 else 6.0)
                curve.append({"timeUtc": (start + timedelta(seconds=index * 900)).isoformat().replace("+00:00", "Z"),
                              "secondsFromModelStart": index * 900, "navd88Ft": feet,
                              "navd88M": feet * .3048, "isHourlySourcePoint": index % 4 == 1})
                wet = (cell_ids % 3 == 0) if index == 0 else ((cell_ids + index) % 4 != 0)
                if index == 1:
                    wet = np.zeros_like(wet)
                depths = np.where(wet & (cell_ids % 7 != 6), .15 + index % 7 * .04 + cell_ids % 5 * .01, 0)
                source_depths.append(depths.astype(np.float32))
            guidance = {"cycleId": cycle, "scenarios": {"mean": curve}}
            guidance_path = root / "model/state/latest_petss.json"
            write_json(guidance_path, guidance)
            config_path = root / "model/config/fixture.json"
            write_json(config_path, config)
            run = root / "model/runs" / cycle / "mean"
            hydraulic = run / "hydraulic"
            hydraulic.mkdir(parents=True)
            rows, columns = np.indices(terrain.shape)
            xs = native_transform.c + (columns + .5) * native_transform.a
            ys = native_transform.f + (rows + .5) * native_transform.e
            np.savez(hydraulic / "mesh.npz", centroid_coordinates=np.column_stack([xs.ravel(), ys.ravel()]),
                     bed_elevation_m=terrain.ravel())
            stages = (np.asarray(source_depths, dtype=np.float32) + terrain).reshape(102, -1)
            np.save(hydraulic / "stage_centroid_m.npy", stages)
            write_json(hydraulic / "frame_statistics.json", [{"modelTimeSeconds": index * 900} for index in range(102)])
            simulation = cache.simulation_identity(root, config, guidance, "mean")
            write_json(run / "run_manifest.json", {
                "status": "complete", "cycleId": cycle, "scenario": "mean", "simulationIdentity": simulation,
                "output": {"frameCount": 102, "intervalSeconds": 900}, "qualitySummary": {"maximumSpeedMps": .1},
                "domain": {"triangleCount": terrain.size, "openBoundaryEdgeCount": 1},
                "physics": {"fixture": "synthetic centroid stages; no simulation"},
                "petssSource": {"cycleUtc": "2026-11-01T00:00:00Z"},
            })
            argv = ["render_physics.py", "--config", str(config_path), "--petss", str(guidance_path)]
            with mock.patch.object(renderer, "ROOT", root), mock.patch.object(validator, "ROOT", root), \
                    mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                renderer.main()
                validation = validator.validate_scenario(config, cycle, "mean")
            manifest = json.loads((run / "public/manifest.json").read_text())
            self.assertEqual(validation["frameCount"], 102)
            self.assertEqual([day["dateLocal"] for day in manifest["dailyMaximums"]],
                             ["2026-10-31", "2026-11-01", "2026-11-02"])
            self.assertEqual(sum(validator.frame_local_date(frame["timeUtc"], renderer.ZoneInfo("America/New_York")) ==
                                 "2026-11-01" for frame in manifest["frames"]), 100)

            # Independently transform each output pixel center back to its
            # original native cell; no renderer warp helper supplies expected data.
            image = manifest["image"]
            destination = rasterio.Affine(*image["transform"])
            dst_rows, dst_columns = np.indices((image["height"], image["width"]))
            dst_x = destination.c + (dst_columns + .5) * destination.a
            dst_y = destination.f + (dst_rows + .5) * destination.e
            src_x, src_y = project("EPSG:3857", config["modelCrs"], dst_x.ravel(), dst_y.ravel())
            src_columns = np.floor((np.asarray(src_x) - native_transform.c) / native_transform.a).astype(int).reshape(dst_rows.shape)
            src_rows = np.floor((np.asarray(src_y) - native_transform.f) / native_transform.e).astype(int).reshape(dst_rows.shape)
            inside = (src_columns >= 0) & (src_columns < width) & (src_rows >= 0) & (src_rows < height)
            src_columns = src_columns.clip(0, width - 1)
            src_rows = src_rows.clip(0, height - 1)
            mapped_valid = inside & valid[src_rows, src_columns]
            arrivals = np.zeros(terrain.shape, dtype=np.uint8)
            expected_daily, expected_daily_impact = {}, {}
            rewet_minor_verified = False
            for index, frame in enumerate(manifest["frames"]):
                native_depth = np.maximum(stages[index].reshape(terrain.shape) - terrain, 0)
                native_wet = valid & (native_depth >= config["render"]["minimumWetDepthM"])
                newly_wet = native_wet & (arrivals == 0)
                arrivals[newly_wet] = 1 if index == 0 else 3
                expected_wet = mapped_valid & native_wet[src_rows, src_columns]
                expected_mm = np.where(expected_wet, np.rint(native_depth[src_rows, src_columns] * 1000), 0).astype(np.uint16)
                expected_impact = np.where(expected_wet, arrivals[src_rows, src_columns], 0).astype(np.uint8)
                public = run / "public"
                actual_mm, actual_wet = validator.decode_query(public / frame["query"]["path"])
                np.testing.assert_array_equal(actual_wet, expected_wet)
                np.testing.assert_array_equal(actual_mm, expected_mm)
                with Image.open(public / frame["impact"]["path"]) as product:
                    np.testing.assert_array_equal(np.asarray(product), expected_impact)
                if index == 2:
                    self.assertTrue(np.any(expected_wet & (expected_impact == 1)))
                    rewet_minor_verified = True
                day = validator.frame_local_date(frame["timeUtc"], renderer.ZoneInfo("America/New_York"))
                expected_daily[day] = np.maximum(expected_daily.get(day, np.zeros_like(expected_mm)), expected_mm)
                expected_daily_impact[day] = np.maximum(expected_daily_impact.get(day, np.zeros_like(expected_impact)), expected_impact)
            self.assertTrue(rewet_minor_verified)
            for record in manifest["dailyMaximums"]:
                day = record["dateLocal"]
                actual_mm, _ = validator.decode_query(run / "public" / record["query"]["path"])
                np.testing.assert_array_equal(actual_mm, expected_daily[day])
                with Image.open(run / "public" / record["impact"]["path"]) as product:
                    np.testing.assert_array_equal(np.asarray(product), expected_daily_impact[day])


if __name__ == "__main__":
    unittest.main()
