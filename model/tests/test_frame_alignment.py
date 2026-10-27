#!/usr/bin/env python3
"""Test renderer time alignment without loading the optional GIS runtime."""
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'model/src'))
from frame_alignment import load_guidance_frames as align


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.source = [{'secondsFromModelStart': second, 'timeUtc': f'2026-10-26T{hour:02d}:{minute:02d}:00Z', 'navd88M': second / 900, 'navd88Ft': second / 900 / .3048, 'isHourlySourcePoint': second % 3600 == 0}
                       for second, hour, minute in [(0, 23, 0), (900, 23, 15), (1800, 23, 30), (2700, 23, 45), (3600, 0, 0)]]
        self.source[-1]['timeUtc'] = '2026-10-27T00:00:00Z'
        self.guidance = {'scenarios': {'mean': self.source}}

    def frames(self, times, **kwargs):
        return align(self.guidance, 'mean', [{'modelTimeSeconds': second} for second in times], **kwargs)

    def test_default_interval_metadata_is_unchanged(self):
        self.assertEqual(self.frames([0, 900, 1800, 2700, 3600]), self.source)

    def test_larger_interval_selects_actual_solver_times(self):
        frames = self.frames([0, 1800, 3600])
        self.assertEqual(frames, self.source[::2])
        self.assertEqual(frames[-1]['timeUtc'], '2026-10-27T00:00:00Z')

    def test_nonmultiple_interval_interpolates_forcing(self):
        frame = self.frames([450])[0]
        self.assertEqual(frame['secondsFromModelStart'], 450)
        self.assertEqual(frame['timeUtc'], '2026-10-26T23:07:30Z')
        self.assertEqual(frame['navd88M'], .5)
        self.assertFalse(frame['isHourlySourcePoint'])

    def test_invalid_solver_times_fail_closed(self):
        for times in ([0, 4000], [0, float('nan')], [900, 0], [0, 0], [-1, 0]):
            with self.subTest(times=times), self.assertRaises(RuntimeError):
                self.frames(times)

    def test_constant_stage_override_metadata_matches_solver(self):
        frame = self.frames([450], constant_stage_m=2)[0]
        self.assertEqual(frame['navd88M'], 2)
        self.assertAlmostEqual(frame['navd88Ft'], 2 / .3048)
        self.assertEqual(self.source[0]['navd88M'], 0)


if __name__ == '__main__':
    unittest.main()
