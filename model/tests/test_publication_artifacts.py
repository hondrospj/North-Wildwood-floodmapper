"""Exercise publication against in-memory storage with no credentials or network."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import numpy as np
from PIL import Image

from test_generation_identity import CYCLE, cache, make_fixture, publisher, record, validator, write_json


class MemoryStorage:
    def __init__(self):
        self.objects = {}
        self.png_uploads_before_failure = None

    def upload_bytes(self, name, payload, content_type):
        if content_type == 'image/png' and self.png_uploads_before_failure is not None:
            if not self.png_uploads_before_failure:
                raise OSError('upload interrupted')
            self.png_uploads_before_failure -= 1
        self.objects[name] = payload

    def request(self, method, name):
        assert method == 'GET'
        return self.objects[name], {}

    def fetch_cdn(self, name, cache_buster):
        return self.objects[name], {'Access-Control-Allow-Origin': '*'}

    def cdn_url(self, name):
        return 'https://offline.invalid/' + name


class PublicationArtifactsTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config, self.guidance = make_fixture(self.root)
        self.config_path = self.root / 'config.json'
        write_json(self.config_path, self.config)
        self.storage = MemoryStorage()
        self.public = self.root / 'model/runs' / CYCLE / 'mean/public'
        self.manifest_path = self.public / 'manifest.json'
        self.daily = self.public / '0-daily-query.png'
        for scenario in self.config['petss']['scenarios']:
            directory = self.public.parent.parent / scenario / 'public'
            path = directory / 'manifest.json'
            manifest = json.loads(path.read_text())
            manifest['forecastStartUtc'] = manifest['frames'][0]['timeUtc']
            manifest['forecastEndUtc'] = manifest['frames'][-1]['timeUtc']
            # A real daily product is a separate, unsampled file.
            daily = manifest['dailyMaximums'][0]
            target = directory / self.daily.name
            shutil.copyfile(directory / daily['query']['path'], target)
            daily['query'] = record(directory, target)
            write_json(path, manifest)
        self.validate()

    def validate(self):
        with mock.patch.object(validator, 'ROOT', self.root), redirect_stdout(StringIO()):
            results = [validator.validate_scenario(self.config, CYCLE, s) for s in self.config['petss']['scenarios']]
        write_json(self.root / 'model/state' / f'validation_{CYCLE}.json', {
            'status': 'passed', 'cycleId': CYCLE, 'scenarios': results,
            'productIdentitySha256ByScenario': cache.product_identities(self.root, self.config, self.guidance),
        })

    def publish(self, acquire_key=None):
        argv = ['publish_bunny.py', '--config', str(self.config_path), '--workers', '1', '--skip-retention']
        with mock.patch.object(publisher, 'ROOT', self.root), mock.patch.object(sys, 'argv', argv), \
                mock.patch.object(publisher, 'BunnyStorage', return_value=self.storage), \
                mock.patch.object(publisher, 'get_access_key', side_effect=acquire_key, return_value='fixture'), \
                redirect_stdout(StringIO()):
            publisher.main()

    def test_daily_change_after_validation_stops_before_publication(self):
        Image.fromarray(np.array([[[0, 42, 1]]], dtype=np.uint8)).save(self.daily)
        with self.assertRaisesRegex(RuntimeError, 'Public asset changed since validation'):
            self.publish()
        self.assertEqual(self.storage.objects, {})

    def test_daily_change_after_preflight_stops_before_completion_marker(self):
        def change_file(*args):
            Image.fromarray(np.array([[[0, 42, 1]]], dtype=np.uint8)).save(self.daily)
            return 'fixture'
        with self.assertRaisesRegex(RuntimeError, 'Public asset changed since validation'):
            self.publish(change_file)
        self.assertFalse(any(name.endswith(self.daily.name) or '/pointers/' in name for name in self.storage.objects))

    def test_interrupted_same_cycle_retry_preserves_previously_published_bytes(self):
        self.publish()
        previous = dict(self.storage.objects)
        with Image.open(self.daily) as image:
            image.save(self.daily, compress_level=0)
        manifest = json.loads(self.manifest_path.read_text())
        manifest['dailyMaximums'][0]['query'] = record(self.public, self.daily)
        write_json(self.manifest_path, manifest)
        self.validate()
        self.storage.png_uploads_before_failure = 1
        with self.assertRaisesRegex(OSError, 'upload interrupted'):
            self.publish()
        self.assertGreater(len(self.storage.objects), len(previous), 'Retry uploaded into a separate generation')
        self.assertEqual({name: self.storage.objects[name] for name in previous}, previous)
