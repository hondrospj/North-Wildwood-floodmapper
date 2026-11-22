"""Palette indices alone cannot verify the colors a browser can see."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from PIL import Image

from test_generation_identity import CYCLE, make_fixture, record, validator, write_json


class ProductTransparencyTests(unittest.TestCase):
    def test_fully_transparent_wet_depth_and_impact_are_rejected(self):
        for group, kind, expected in [('frames', 'visible', 'Visible/query wet mask mismatch'),
                                       ('dailyMaximums', 'impact', 'daily impact is not exact')]:
            with self.subTest(group=group, kind=kind), TemporaryDirectory() as temporary:
                root = Path(temporary)
                config, _ = make_fixture(root)
                public = root / 'model/runs' / CYCLE / 'mean/public'
                manifest_path = public / 'manifest.json'
                manifest = json.loads(manifest_path.read_text())
                row = manifest[group][0]
                path = public / f'fully-transparent-{kind}.png'
                with Image.open(public / row[kind]['path']) as image:
                    image.convert('P').save(path, transparency=bytes(256))
                row[kind] = record(public, path)
                write_json(manifest_path, manifest)
                with mock.patch.object(validator, 'ROOT', root), redirect_stdout(StringIO()), \
                        self.assertRaisesRegex(RuntimeError, expected):
                    validator.validate_scenario(config, CYCLE, 'mean')
