import json
from pathlib import Path
import shutil
import tempfile
import unittest

from pages_forecast_overlay import FORECAST_PATHS, stage_forecast
from release_data import utc_time


REPO = Path(__file__).resolve().parents[1]


class PagesForecastOverlayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source = Path(directory.name) / "source"
        self.site = Path(directory.name) / "site"
        for folder in (self.source, self.site):
            (folder / "data").mkdir(parents=True)
        for relative in FORECAST_PATHS:
            shutil.copyfile(REPO / relative, self.source / relative)
            (self.site / relative).write_text("previous guidance", encoding="utf-8")
        (self.source / "index.html").write_text("unreleased UI", encoding="utf-8")
        (self.site / "index.html").write_text("approved UI", encoding="utf-8")
        research = json.loads((self.source / FORECAST_PATHS[1]).read_text(encoding="utf-8"))
        self.now = utc_time(research["generatedUtc"], "fixture generation time")

    def test_stages_only_validated_forecast_pair(self):
        receipt = stage_forecast(self.source, self.site, now=self.now)
        self.assertGreater(receipt["hours"], 0)
        for relative in FORECAST_PATHS:
            self.assertEqual((self.source / relative).read_bytes(), (self.site / relative).read_bytes())
        self.assertEqual((self.site / "index.html").read_text(encoding="utf-8"), "approved UI")

    def test_rejects_invalid_pair_before_writing_either_file(self):
        (self.source / FORECAST_PATHS[1]).write_text("{}", encoding="utf-8")
        with self.assertRaises(ValueError):
            stage_forecast(self.source, self.site, now=self.now)
        for relative in FORECAST_PATHS:
            self.assertEqual((self.site / relative).read_text(encoding="utf-8"), "previous guidance")


if __name__ == "__main__":
    unittest.main()
