"""Topobathymetry acquisition replaces invalid cache entries without network."""
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import download_topobathy as acquisition


class TopobathyAcquisitionTests(unittest.TestCase):
    def test_non_tiff_cache_and_response_are_replaced_by_valid_tiff(self):
        with TemporaryDirectory() as temporary, MemoryFile() as memory:
            root = Path(temporary)
            destination = root / 'fixture.tif'
            invalid = b'<!doctype html><p>upstream error</p>' * 100
            destination.write_bytes(invalid)
            with memory.open(driver='GTiff', width=20, height=20, count=1, dtype='float32', crs='EPSG:6347',
                             transform=from_origin(515300, 4320100, 5, 5)) as dataset:
                dataset.write(np.ones((20, 20), dtype=np.float32), 1)
            valid = memory.read()
            item = {'id': 'fixture', 'url': 'https://offline.invalid/fixture.tif'}
            with mock.patch.object(acquisition, 'ROOT', root), mock.patch.object(acquisition.time, 'sleep'), \
                    mock.patch.object(acquisition.urllib.request, 'urlopen', side_effect=[BytesIO(invalid), BytesIO(valid)]) as request:
                repaired = acquisition.download_one(item, root)
                reused = acquisition.download_one(item, root)
            self.assertEqual(request.call_count, 2)
            self.assertTrue(repaired['downloaded'])
            self.assertFalse(reused['downloaded'])
            self.assertEqual(destination.read_bytes(), valid)
            with rasterio.open(destination) as dataset:
                np.testing.assert_equal(dataset.read(1), np.ones((20, 20)))
