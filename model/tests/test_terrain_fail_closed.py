"""Exercise missing and known-ocean cells using real tiny GeoTIFFs."""
from contextlib import redirect_stdout
from copy import deepcopy
from io import StringIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

import numpy as np
import rasterio
from rasterio.transform import from_origin

from test_generation_identity import ORIGINAL, write_json
import prepare_terrain as terrain
from run_anuga import RasterSampler


class TerrainCoverageTests(unittest.TestCase):
    def prepare(self, root, edge_value):
        config = deepcopy(ORIGINAL)
        domain = config['domain']
        domain['xmax'] = domain['xmin'] + 100
        domain['ymin'] = domain['ymax'] - 100
        paths = config['terrain']
        transform = from_origin(domain['xmin'], domain['ymax'], 5, 5)

        def write(path, values):
            path.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(path, 'w', driver='GTiff', height=20, width=20, count=1,
                               dtype='float32', nodata=-9999, crs=config['modelCrs'], transform=transform) as dataset:
                dataset.write(values.astype(np.float32), 1)

        seamless = np.full((20, 20), -.5)
        seamless[0, 1:3] = edge_value
        write(root / paths['seamlessLandFallback'], seamless)
        local = np.full_like(seamless, -9999.)
        local[10, 10] = -.5 * 3937 / 1200
        write(root / paths['localDem'], local)
        write(root / paths['localBulkheadMask'], np.zeros_like(seamless))
        topo = np.full_like(seamless, -9999.)
        topo[10, 11] = -.5
        tile = root / paths['topobathyDirectory'] / 'fixture.tif'
        write(tile, topo)
        write_json(tile.parent / 'acquisition_manifest.json', {'tiles': [{'path': str(tile.relative_to(root))}]})
        config_path = root / 'config.json'
        write_json(config_path, config)
        with mock.patch.object(terrain, 'ROOT', root), mock.patch.object(sys, 'argv', ['prepare_terrain.py', '--config', str(config_path)]), redirect_stdout(StringIO()):
            terrain.main()
        return RasterSampler(root / paths['computationalDem'])

    def test_unknown_edge_is_never_an_open_ocean_source(self):
        with TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(RuntimeError, 'missing at 2 cells'):
                self.prepare(Path(temporary), -9999)
            self.assertFalse((Path(temporary) / ORIGINAL['terrain']['computationalDem']).exists())

    def test_explicit_noaa_ocean_placeholder_retains_the_offshore_bed(self):
        with TemporaryDirectory() as temporary:
            terrain = self.prepare(Path(temporary), -20)
            np.testing.assert_equal(terrain.array[0, 1:3], [-8., -8.])
            self.assertEqual(int(terrain.initial_connected_water(.4, -1).sum()), 400)
