#!/usr/bin/env python3
"""Small, offline regression fixtures for archive, image, and QA generators."""
from __future__ import annotations

from argparse import Namespace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import contextlib
import csv
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import update_lewes_archive as lewes
import build_all_overlay_webp as webp
import experimental_petss_guidance as research
import simulate_north_wildwood_hydraulics as model
import preview_north_wildwood_resolution as preview

ROOT = Path(__file__).resolve().parents[1]


class ArchiveTests(unittest.TestCase):
    def test_empty_noaa_response_preserves_saved_archive(self):
        day = date(2006, 6, 1)
        no_data = {'error': {'message': 'No data was found'}}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'lewes_hourly.json'
            output.write_bytes(b'previous archive')
            args = Namespace(output=output, cache_dir=Path(temporary), start_date=day, end_date=day,
                             pause_seconds=0, six_minute_fallback=True)
            with patch.object(lewes, 'fetch_product', return_value=no_data), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'No verified Lewes water levels'):
                    lewes.build(args)
            self.assertEqual(output.read_bytes(), b'previous archive')

    def test_local_last_day_fetches_next_utc_day(self):
        requests = []
        def fetch(product, start, end, *_):
            requests.append((start, end))
            first = datetime.combine(start, datetime.min.time(), timezone.utc)
            stop = datetime.combine(end + timedelta(days=1), datetime.min.time(), timezone.utc)
            rows = []
            while first < stop:
                rows.append({'t': first.strftime('%Y-%m-%d %H:%M'), 'v': '1.23'})
                first += timedelta(hours=1)
            return {'data': rows}
        for day in (date(2007, 9, 30), date(2006, 12, 31), date(2007, 11, 4)):
            with self.subTest(day=day), patch.object(lewes, 'fetch_product', fetch), contextlib.redirect_stdout(io.StringIO()):
                hours = lewes.load_hourly_archive(day, day, Path('/unused'), 0)
                days = lewes.build_days(hours, set(), day, day)
                self.assertEqual(len(days), 1)
                self.assertTrue(all(value == 123 for value in days[0]['v']))
                self.assertEqual(len(days[0]['v']), len(lewes.expected_hour_range(day, day)))
                self.assertEqual(set(hours), set(lewes.expected_hour_range(day, day)))
        self.assertIn((date(2007, 1, 1), date(2007, 1, 1)), requests)

    def test_fallback_includes_next_utc_month(self):
        day = date(2007, 9, 30)
        hours = {stamp: 1.0 for stamp in lewes.expected_hour_range(day, day)}
        missing = list(hours)[-4:]
        for stamp in missing:
            del hours[stamp]
        self.assertEqual(lewes.months_needing_six_minute_fill(hours, day, day), [(date(2007, 10, 1), date(2007, 10, 1))])
        rows = [{'t': datetime.fromtimestamp(stamp, timezone.utc).strftime('%Y-%m-%d %H:%M'), 'v': '2.5'} for stamp in missing]
        rows.append({'t': '2007-10-01 04:00', 'v': '9.0'})  # Outside the local archive cutoff.
        with patch.object(lewes, 'fetch_product', return_value={'data': rows}), contextlib.redirect_stdout(io.StringIO()):
            filled = lewes.fill_from_six_minute(hours, day, day, Path('/unused'), 0)
        self.assertEqual(filled, set(missing))
        self.assertEqual(lewes.build_days(hours, filled, day, day)[0]['x'], [20, 21, 22, 23])

    def test_corrected_final_day_and_quality(self):
        archive = json.loads((ROOT / 'lewes_hourly.json').read_text())
        self.assertEqual(archive['days'][-1]['v'][-4:], [-148, -61, 45, 134])
        self.assertEqual(archive['quality']['validHourlyLevels'], sum(value is not None for day in archive['days'] for value in day['v']))


class ResearchGuidanceTests(unittest.TestCase):
    def test_adjusted_product_requires_raw_levels_and_applies_shift_once(self):
        source = "2026-09-26T15:00:00Z"
        display = "2026-09-26T16:00:00Z"
        mean = {"timeUtc": display, "sourceTimeUtc": source, "mllwStageFt": 7.1, "tideMllwFt": 5.1}
        low = {"timeUtc": display, "sourceTimeUtc": source, "mllwStageFt": 6.8}
        forecast = {"sourceDatum": "MLLW", "petssCycleUtc": "2026-09-25T15:00:00Z",
                    "predictionStageAdjustmentFt": 0.5, "predictionTimeShiftMinutes": 60,
                    "forecasts": {"mean": {"hours": [mean]}, "lowEnd": {"hours": [low]}}}
        result = research.build_root(forecast)[0]["hours"][0]
        self.assertEqual(result["availability"], "unavailable")
        mean["rawPetssTwlMllwFt"] = 6.6
        self.assertEqual(research.build_root(forecast)[0]["hours"][0]["availability"], "unavailable")
        low["rawPetssTwlMllwFt"] = 6.3
        result = research.build_root(forecast)[0]["hours"][0]
        self.assertEqual(result["issuedMeanMllwFt"], 7.1)
        self.assertEqual(result["issued90ExceedanceMllwFt"], 6.8)
        self.assertEqual((result["validUtc"], result["modelLeadHours"]), (display, 24.0))

    def test_research_timestamps_have_an_explicit_timezone(self):
        with self.assertRaisesRegex(ValueError, "explicit timestamp offset"):
            research.utc("2026-11-01T01:00:00")
        self.assertNotEqual(research.utc("2026-11-01T01:00:00-04:00"), research.utc("2026-11-01T01:00:00-05:00"))


class WebPTests(unittest.TestCase):
    def test_rebuild_changed_and_corrupt_companions_reuse_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / 'assets/DepthPNGs/town'
            directory.mkdir(parents=True)
            a, b, c = (directory / name for name in ('a.png', 'b.png', 'c.png'))
            for path in (a, b, c):
                Image.new('RGBA', (3, 2), (255, 0, 0, 0)).save(path)
            def run():
                with patch.object(webp, 'ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                    webp.main()
            run()
            original = a.with_suffix('.webp').stat().st_mtime_ns
            run()
            self.assertEqual(original, a.with_suffix('.webp').stat().st_mtime_ns)
            Image.new('RGBA', (3, 2), (0, 0, 255, 255)).save(a)
            b.with_suffix('.webp').write_bytes(b'broken image')
            c.with_suffix('.webp').write_bytes(c.read_bytes())
            run()
            for path in (a, b, c):
                target = path.with_suffix('.webp')
                self.assertEqual(webp.pixel_signature(path), webp.pixel_signature(target))
                with Image.open(target) as companion:
                    self.assertEqual(companion.format, 'WEBP')
            self.assertFalse(list(directory.glob('*.incomplete')))


class MaintenanceTests(unittest.TestCase):
    def make_graph(self, root):
        graph = root / 'graph'
        graph.mkdir()
        (graph / 'graph_manifest.json').write_text(json.dumps({
            'width': 10, 'height': 10, 'controlVolumeSizeFt': 25, 'connectionBinFt': 0.1,
            'cellSizeFt': 1, 'geotransform': [401465, 1, 0, 70425, 0, -1],
        }))
        with (graph / 'zones.csv').open('w') as stream:
            writer = csv.writer(stream)
            writer.writerow(['zone_id', 'connection10', 'cell_count', 'source_cells', 'grate_cells', 'hard_cells', 'developed_cells', 'hist_counts'])
            for i, (connection, elevation) in enumerate([(0, 0), (20, 10), (40, 30)]):
                histogram = [0] * model.HIST_COUNT
                histogram[elevation - model.HIST_MIN10] = 100
                writer.writerow([i, connection, 100, 100 if i == 0 else 0, 0, 0, 0, ':'.join(map(str, histogram))])
        (graph / 'edges.csv').write_text('zone_a,zone_b,crest10,width_ft\n0,1,20,1\n1,2,40,1\n')
        np.zeros((10, 10), dtype='<i2').tofile(graph / 'elevation10.raw')
        zone = np.zeros((10, 10), dtype='<i4')
        zone[:, 5:] = 1
        zone.tofile(graph / 'zone_id.raw')
        (zone == 0).astype('u1').tofile(graph / 'source_flag.raw')
        np.savez(root / 'state.npz', storage=np.array([200., 100., 0.]), surface=np.array([2., 2., 3.]))
        return graph

    def invoke(self, tool, *args):
        result = subprocess.run([sys.executable, str(ROOT / 'tools' / tool), *map(str, args)], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_actual_qa_commands_use_current_solver_and_palette(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph = self.make_graph(root)
            benchmark = self.invoke('benchmark_north_wildwood_methods.py', '--graph', graph, '--output', root / 'benchmark.json')
            self.assertTrue(benchmark['acceptance']['noDisconnectedWetZones'])
            self.assertLess(benchmark['acceptance']['maximumStorageRoundTripSurfaceErrorFt'], 1e-6)
            preview = self.invoke('preview_north_wildwood_resolution.py', '--graph', graph, '--dem', root / 'unused.tif', '--output', root / 'preview', '--maximum-stage', '2.2', '--skip-render')
            self.assertEqual(len(preview['selectedStages']), 23)
            self.assertEqual(preview['selectedStages'][-1]['wetTerrainZoneCount'], 1)
            image = self.invoke('render_north_wildwood_state_preview.py', '--graph', graph, '--state', root / 'state.npz', '--output', root / 'state.png', '--smoothing-sigma', '0')
            self.assertEqual(image['floodedPixels'], 4)
            with Image.open(root / 'state.png') as rendered:
                self.assertEqual(rendered.size, (2, 2))
                self.assertGreater(rendered.convert('RGBA').getpixel((0, 0))[3], 0)
            smoothed = self.invoke('render_north_wildwood_state_preview.py', '--graph', graph, '--state', root / 'state.npz', '--output', root / 'smoothed.png')
            self.assertEqual(smoothed['floodedPixels'], 4)

    def test_sparse_graph_audit_and_solver_and_cropped_enclaves(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph = self.make_graph(root)
            for edge_rows in ([], ['0,1,20,1']):
                with self.subTest(edges=len(edge_rows)):
                    (graph / 'edges.csv').write_text('zone_a,zone_b,crest10,width_ft\n' + ''.join(f'{row}\n' for row in edge_rows))
                    self.invoke('audit_north_wildwood_graph.py', '--graph', graph, '--output', root / 'audit.json')
                    report = json.loads((root / 'audit.json').read_text())
                    self.assertEqual(report['edgeGroupCount'], len(edge_rows))
                    method = self.invoke('benchmark_north_wildwood_methods.py', '--graph', graph, '--output', root / 'methods.json')
                    self.assertEqual(method['graphEdgeGroupCount'], len(edge_rows))
            source = np.ones((10, 10), dtype='u1')
            source[4:6, 4:6] = 0
            source.tofile(graph / 'source_flag.raw')
            enclaves = self.invoke('analyze_north_wildwood_source_enclaves.py', '--graph', graph, '--output', root / 'enclaves.json')
            self.assertEqual(enclaves['enclosedComponentCount'], 1)
            self.assertEqual(enclaves['enclosedCellCount'], 4)
            self.assertAlmostEqual(enclaves['enclosedAcres'], 4 / 43560)

    def test_legacy_contact_sheet_rejects_wrong_stage_with_correct_count(self):
        import build_north_wildwood_contact_sheets as contacts
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for family in contacts.LEGACY_FAMILIES:
                directory = root / family
                directory.mkdir()
                for code in range(0, 1001, 10):
                    (directory / f'NorthWildwoodDepthp{code:04d}.png').touch()
            self.assertEqual(contacts.collect_frames(root)['rising_slow'][-1][0], 10.0)
            directory = root / 'rising_slow'
            (directory / 'NorthWildwoodDepthp1000.png').rename(directory / 'NorthWildwoodDepthp0005.png')
            with self.assertRaisesRegex(RuntimeError, 'Missing atlas frame .*p1000'):
                contacts.collect_frames(root)

    def test_source_marker_excludes_nonfinite_and_declared_nodata(self):
        from osgeo import gdal
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dem, query, output = (root / name for name in ('dem.tif', 'zones.png', 'marker.tif'))
            elevations = np.ones((10, 10), dtype=np.float32)
            elevations[0, :3] = (-np.inf, -9999, 2.001)
            dataset = gdal.GetDriverByName('GTiff').Create(str(dem), 10, 10, 1, gdal.GDT_Float32)
            band = dataset.GetRasterBand(1)
            band.SetNoDataValue(-9999)
            band.WriteArray(elevations)
            dataset = None
            Image.new('RGB', (2, 2), (0, 0, 1)).save(query)
            result = subprocess.run([sys.executable, str(ROOT / 'tools/reconstruct_north_wildwood_source_marker.py'),
                                     '--dem', str(dem), '--zone-query', str(query), '--output', str(output)],
                                    cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            dataset = gdal.Open(str(output))
            marker = dataset.ReadAsArray()
            self.assertEqual(marker[0, :3].tolist(), [0, 0, 0])
            self.assertEqual(int(marker.sum()), 97)

    def test_saved_state_preview_rejects_invalid_depth_minimum(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for value in ('-2', 'inf', 'nan'):
                with self.subTest(value=value):
                    output = root / 'invalid.png'
                    result = subprocess.run([sys.executable, str(ROOT / 'tools/render_north_wildwood_state_preview.py'),
                                             '--graph', str(root / 'graph'), '--state', str(root / 'state.npz'),
                                             '--output', str(output), '--minimum-depth-ft', value],
                                            cwd=ROOT, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('--minimum-depth-ft must be finite and nonnegative', result.stderr)
                    self.assertFalse(output.exists())

    def test_preview_passes_current_render_api_and_restores_catalog(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            graph = self.make_graph(root)
            stages = model.STAGES_FT
            argv = ['preview', '--graph', str(graph), '--dem', str(root / 'dem.tif'), '--output', str(root / 'preview'), '--maximum-stage', '2.2']
            with patch.object(sys, 'argv', argv), patch.object(model, 'render_assets', autospec=True, return_value={'fixture': True}) as renderer, contextlib.redirect_stdout(io.StringIO()):
                preview.main()
            self.assertIs(model.STAGES_FT, stages)
            self.assertEqual(renderer.call_args.args[2], graph / 'NorthWildwoodRoadCorridor5ft.tif')
            self.assertEqual(set(renderer.call_args.args[4]), set(model.PHASE_DIRECTORIES))
            self.assertEqual(renderer.call_args.args[4]['filling'].shape, (23, 4))

    def test_default_publisher_catalog_actual_dry_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publisher = root / '.shorelysafe'
            publisher.mkdir()
            (publisher / 'publish.py').write_bytes((ROOT / '.shorelysafe/publish.py').read_bytes())
            (publisher / 'apps.json').write_text(json.dumps([{'id': 'test', 'repository': 'owner/sample', 'path': '/sample/'}]))
            source = root / 'sources/sample'
            source.mkdir(parents=True)
            (source / 'index.html').write_text('<html>fixture</html>')
            for args in (['git', 'init', '-q'], ['git', 'add', 'index.html'], ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']):
                subprocess.run(args, cwd=source, check=True, capture_output=True)
            result = subprocess.run([sys.executable, str(publisher / 'publish.py'), '--app', 'test', '--dry-run', '--sources', str(root / 'sources')], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(json.loads(result.stdout)['files'], 1)


if __name__ == '__main__':
    unittest.main()
