import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from pages_forecast_overlay import generated_paths, stage_pages_data
from release_data import utc_time


REPO = Path(__file__).resolve().parents[1]
FORECAST_PATHS = ("forecast.json", "data/experimental_petss_guidance.json")


def link_or_copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


class PagesForecastOverlayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source = Path(directory.name) / "source"
        self.site = Path(directory.name) / "site"
        current = json.loads((REPO / "observed_archive_index.json").read_text(encoding="utf-8"))
        self.observed_paths = (
            "observed_archive_index.json",
            f"observed_archive/stone-harbor/{current['archiveEndDate'][:4]}.json",
        )
        self.changed_paths = (*FORECAST_PATHS, *self.observed_paths)
        for relative in generated_paths(REPO):
            link_or_copy(REPO / relative, self.source / relative)
            if relative in self.changed_paths:
                (self.site / relative).parent.mkdir(parents=True, exist_ok=True)
                (self.site / relative).write_text("previous data", encoding="utf-8")
            else:
                link_or_copy(REPO / relative, self.site / relative)
        (self.source / "index.html").write_text("unreleased UI", encoding="utf-8")
        (self.site / "index.html").write_text("approved UI", encoding="utf-8")
        research = json.loads((self.source / FORECAST_PATHS[1]).read_text(encoding="utf-8"))
        self.now = utc_time(research["generatedUtc"], "fixture generation time")

    def test_stages_validated_forecast_and_observations_over_pinned_ui(self):
        receipt = stage_pages_data(self.source, self.site, now=self.now)
        self.assertGreater(receipt["forecast"]["hours"], 0)
        self.assertEqual(receipt["observations"][self.observed_paths[0]]["shard"], self.observed_paths[1])
        for relative in self.changed_paths:
            self.assertEqual((self.source / relative).read_bytes(), (self.site / relative).read_bytes())
        self.assertEqual((self.site / "index.html").read_text(encoding="utf-8"), "approved UI")

    def test_rejects_invalid_forecast_before_writing_data(self):
        path = self.source / FORECAST_PATHS[1]
        path.unlink()
        path.write_text("{}", encoding="utf-8")
        with self.assertRaises(ValueError):
            stage_pages_data(self.source, self.site, now=self.now)
        self.assert_original_data()

    def test_rejects_incomplete_observation_snapshot_before_writing_data(self):
        (self.source / self.observed_paths[1]).unlink()
        with self.assertRaisesRegex(ValueError, "missing indexed observation shards"):
            stage_pages_data(self.source, self.site, now=self.now)
        self.assert_original_data()

    def assert_original_data(self):
        for relative in self.changed_paths:
            self.assertEqual((self.site / relative).read_text(encoding="utf-8"), "previous data")


if __name__ == "__main__":
    unittest.main()
