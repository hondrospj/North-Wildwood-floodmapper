#!/usr/bin/env python3
"""Small CLI fixtures: limit rendering without mixing hydraulic state generations."""
from contextlib import ExitStack, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import simulate_north_wildwood_hydraulics as model


class DrainingCliTests(unittest.TestCase):
    def run_cli(self, reuse=False, existing=False):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory).resolve()
            graph, output = root / 'graph', root / 'output'
            graph.mkdir()
            (graph / 'graph_manifest.json').write_text(json.dumps({'zoneCount': 1}))
            state_path = output / 'COGs/North Wildwood/NorthWildwoodHydraulicStates.json.png'
            if existing:
                state_path.parent.mkdir(parents=True)
                state_path.write_bytes(b'fixture read by the complete-state loader')
            args = ['simulate', '--graph', str(graph), '--dem', str(root / 'unused.tif'),
                    '--output', str(output), '--draining-only', '--skip-query-cog']
            if reuse:
                args.append('--reuse-complete-state')
            stack.enter_context(patch('sys.argv', args))
            # Native raster dependencies and outputs are irrelevant to CLI routing.
            for dependency in ['gdal', 'Image', 'binary_dilation', 'gaussian_filter', 'ndimage_label']:
                stack.enter_context(patch.object(model, dependency, object()))
            stack.enter_context(patch.object(model, 'load_zones', return_value={'connection10': [1]}))
            solver = stack.enter_context(patch.object(model, 'HydraulicSolver')).return_value
            solver.zone_count = 1
            solver.equilibrium.return_value = (np.array([0.]), np.array([0.]))
            solver.encode_surface.return_value = np.array([model.DRY_SENTINEL, model.DRY_SENTINEL])
            solve = stack.enter_context(patch.object(model, 'simulate', wraps=model.simulate))
            complete = {phase: np.ones((len(model.STAGES_FT), 2), dtype='<i2')
                        for phase in ['filling', 'slack', 'draining']}
            load = stack.enter_context(patch.object(model, 'load_complete_state', return_value=(complete, {})))
            write = stack.enter_context(patch.object(model, 'write_state_asset'))
            stack.enter_context(patch.object(model, 'build_render_cell_summaries', return_value={}))
            stack.enter_context(patch.object(model, 'build_source_distance_grid', return_value=(None, None)))
            render = stack.enter_context(patch.object(model, 'render_assets', return_value={'phases': {'draining': {}}}))
            for name in ['build_packed_query_png', 'build_developed_query_png']:
                stack.enter_context(patch.object(model, name, return_value={}))
            with redirect_stdout(io.StringIO()):
                model.main()
            self.assertEqual(render.call_args.kwargs['phase_names'], ('draining',))
            self.assertEqual(set(write.call_args.args[1]), {'filling', 'slack', 'draining'})
            self.assertIs(render.call_args.args[4], write.call_args.args[1])
            if reuse:
                solve.assert_not_called()
                load.assert_called_once_with(state_path, 2)
                self.assertIs(write.call_args.args[1], complete)
            else:
                load.assert_not_called()
                self.assertEqual(solver.equilibrium.call_count, len(model.STAGES_FT))

    def test_draining_only_solves_coherent_state_without_existing_package(self):
        self.run_cli()

    def test_draining_only_does_not_partially_reuse_existing_state(self):
        self.run_cli(existing=True)

    def test_explicit_complete_reuse_skips_solver(self):
        self.run_cli(reuse=True, existing=True)

    def test_explicit_reuse_still_requires_a_package(self):
        with self.assertRaisesRegex(FileNotFoundError, 'State reuse requires'):
            self.run_cli(reuse=True)

    def test_simulate_still_rejects_partial_state_reuse(self):
        with self.assertRaisesRegex(ValueError, 'Partial phase reuse is incompatible'):
            model.simulate(object(), Path('stale-state.png'))


if __name__ == '__main__':
    unittest.main()
