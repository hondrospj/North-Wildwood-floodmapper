"""Supported subminute solver output must preserve unique frame paths."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from render_physics import compact_timestamp


class RenderTimestampTests(unittest.TestCase):
    def test_same_minute_frames_have_unique_names_and_preserve_minute_aligned_names(self):
        timestamps = ['2026-10-26T04:00:00Z', '2026-10-26T04:00:30Z', '2026-10-26T04:01:00Z']
        self.assertEqual([compact_timestamp(value) for value in timestamps],
                         ['20261026T0400Z', '20261026T040030Z', '20261026T0401Z'])
