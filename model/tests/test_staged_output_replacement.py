"""Use scratch run trees to exercise preflight and promotion failures."""
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from test_generation_identity import CYCLE, make_fixture, write_json
import output_replacement as replacement
import render_physics as renderer
import run_anuga as solver


class StagedOutputTests(unittest.TestCase):
    def test_missing_optional_solver_keeps_existing_forced_run(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, _ = make_fixture(root)
            config_path = root / 'config.json'
            write_json(config_path, config)
            run = root / 'model/runs' / CYCLE / 'mean'
            manifest = (run / 'run_manifest.json').read_bytes()
            argv = ['run_anuga.py', '--config', str(config_path), '--petss', str(root / 'model/state/latest_petss.json'), '--force']
            with mock.patch.object(solver, 'ROOT', root), mock.patch.object(solver, 'anuga', None), \
                    mock.patch.object(sys, 'argv', argv), self.assertRaisesRegex(RuntimeError, 'Install the model ANUGA'):
                solver.main()
            self.assertEqual((run / 'run_manifest.json').read_bytes(), manifest)
            self.assertTrue((run / 'public/manifest.json').is_file())

    def test_missing_pruned_mesh_keeps_existing_forced_render(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, _ = make_fixture(root)
            config_path = root / 'config.json'
            write_json(config_path, config)
            run = root / 'model/runs' / CYCLE / 'mean'
            public = run / 'public'
            previous = {path.name: path.read_bytes() for path in public.iterdir()}
            shutil.rmtree(run / 'hydraulic')
            argv = ['render_physics.py', '--config', str(config_path), '--petss', str(root / 'model/state/latest_petss.json'), '--force']
            with mock.patch.object(renderer, 'ROOT', root), mock.patch.object(sys, 'argv', argv), self.assertRaises(FileNotFoundError):
                renderer.main()
            self.assertEqual({path.name: path.read_bytes() for path in public.iterdir()}, previous)

    def test_failed_promotion_restores_prior_directory_and_recovery_is_reusable(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / 'complete'
            destination.mkdir()
            (destination / 'value').write_text('previous')
            staged = root / 'stage'
            staged.mkdir()
            (staged / 'value').write_text('replacement')
            real_replace = replacement.os.replace

            def fail_final_move(source, target):
                if source == staged:
                    raise OSError('controlled rename failure')
                return real_replace(source, target)

            with mock.patch.object(replacement.os, 'replace', side_effect=fail_final_move), \
                    self.assertRaisesRegex(OSError, 'controlled rename failure'):
                replacement.promote_directory(staged, destination)
            self.assertEqual((destination / 'value').read_text(), 'previous')
            self.assertTrue(staged.exists())
            real_replace(destination, replacement.previous_directory(destination))
            replacement.recover_directory(destination)
            self.assertEqual((destination / 'value').read_text(), 'previous')
            replacement.promote_directory(staged, destination)
            self.assertEqual((destination / 'value').read_text(), 'replacement')
            self.assertFalse(replacement.previous_directory(destination).exists())
