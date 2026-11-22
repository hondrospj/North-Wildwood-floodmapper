"""Verify that a five-foot pixel cannot borrow disconnected developed ground."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
from osgeo import gdal, osr
from PIL import Image

import simulate_north_wildwood_hydraulics as model
import validate_north_wildwood_render_connectivity as validator


def write_raster(path, cells, transform, projection, data_type):
    height, width = cells.shape
    raster = gdal.GetDriverByName("GTiff").Create(str(path), width, height, 1, data_type)
    raster.SetGeoTransform(transform)
    raster.SetProjection(projection)
    raster.GetRasterBand(1).WriteArray(cells)
    raster = None


def render_case(directory, low_cells):
    graph = directory / "graph"
    graph.mkdir(parents=True)
    ground = np.full((35, 35), 42, dtype="<i2")
    connection = ground.copy()
    source = np.zeros(ground.shape, dtype=np.uint8)
    developed = np.zeros(ground.shape, dtype=np.uint8)
    source[10:22, :10] = 1
    ground[source != 0] = connection[source != 0] = 0
    ground[16, 10:15] = connection[16, 10:15] = 24
    ground[16, 15:19] = connection[16, 15:19] = 31
    developed[15:20, 15:20] = 1
    for cell, crest in low_cells:
        ground[cell] = 21
        connection[cell] = crest
    zone = np.zeros(ground.shape, dtype="<i4")
    for filename, cells in (
        ("elevation10.raw", ground),
        ("connection10.raw", connection),
        ("developed_flag.raw", developed),
        ("source_flag.raw", source),
        ("zone_id.raw", zone),
    ):
        cells.tofile(graph / filename)

    srs = osr.SpatialReference()
    srs.ImportFromEPSG(6527)
    projection = srs.ExportToWkt()
    dem = directory / "dem.tif"
    roads = directory / "roads.tif"
    road_mask = np.zeros((7, 7), dtype=np.uint8)
    road_mask[0, 0] = 1
    write_raster(
        dem, ground, (401465, 1, 0, 70425, 0, -1), projection, gdal.GDT_Int16,
    )
    write_raster(
        roads, road_mask, (401465, 5, 0, 70425, 0, -5), projection, gdal.GDT_Byte,
    )
    output = directory / "atlas"
    model.render_assets(graph, dem, roads, output, {})

    by_phase = {}
    for phase, phase_dir in model.PHASE_DIRECTORIES.items():
        depth_path = (
            output / "DepthPNGs" / "North Wildwood" / phase_dir
            / "NorthWildwoodDepthp0330.png"
        )
        stage_path = (
            output / "StagePNGs" / "North Wildwood" / phase_dir
            / "NorthWildwoodStagep0330.png"
        )
        with Image.open(depth_path) as depth, Image.open(stage_path) as stage:
            code = depth.getpixel((3, 3))
            assert (1 <= code <= 11) == (1 <= stage.getpixel((3, 3)) <= 3), phase
            by_phase[phase] = code
        possible = np.zeros((7, 7), dtype=bool)
        possible[3, 3] = True
        adjusted = float(model.phase_adjusted_stage_ft(3.3, phase, True))
        admitted = validator.developed_cells_admitted(
            (ground, connection, developed), possible, 3.3, adjusted,
        )
        assert admitted[3, 3] == (1 <= code <= 11), (phase, code)
    return by_phase


if __name__ == "__main__":
    with TemporaryDirectory() as tmp, patch.multiple(
        model, WIDTH=35, HEIGHT=35, STAGES_FT=np.array([3.3]),
    ):
        root = Path(tmp)
        isolated = render_case(root / "isolated", [((19, 19), 42)])
        absent = render_case(root / "absent", [])
        connected = render_case(root / "connected", [((16, 18), 31)])
        tied = render_case(root / "tied", [((19, 19), 42), ((16, 18), 31)])
        for phase in ("filling", "slack", "draining-release-15", "draining-release-30"):
            assert isolated[phase] == absent[phase] == 12, (phase, isolated, absent)
            assert 1 <= connected[phase] <= 11, (phase, connected)
            assert tied[phase] == connected[phase], (phase, tied, connected)
        assert 1 <= isolated["draining"] <= 11, isolated
    print("Developed render verified in all five phases")
