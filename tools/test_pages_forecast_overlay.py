import json
from pathlib import Path
import shutil
import tempfile
import unittest

from pages_forecast_overlay import FORECAST_PATHS, stage_data
from release_data import GENERATED_DIRECTORIES, GENERATED_FILES, utc_time


REPO = Path(__file__).resolve().parents[1]


class PagesForecastOverlayTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source = Path(directory.name) / "source"
        self.site = Path(directory.name) / "site"
        for folder in (self.source, self.site):
            (folder / "data").mkdir(parents=True)
        paths = GENERATED_FILES | {
            p.relative_to(REPO).as_posix()
            for directory in GENERATED_DIRECTORIES
            for p in (REPO / directory).rglob("*.json")
        }
        for relative in paths:
            (self.source / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, self.source / relative)
        for relative in (*FORECAST_PATHS, "observed_archive_index.json", "observed15min.json"):
            (self.site / relative).write_text("previous guidance", encoding="utf-8")
        (self.source / "index.html").write_text("unreleased UI", encoding="utf-8")
        (self.site / "index.html").write_text("approved UI", encoding="utf-8")
        research = json.loads((self.source / FORECAST_PATHS[1]).read_text(encoding="utf-8"))
        self.now = utc_time(research["generatedUtc"], "fixture generation time")

    def test_stages_forecast_and_observations_with_pinned_ui(self):
        receipt = stage_data(self.source, self.site, now=self.now)
        self.assertGreater(receipt["forecast"]["hours"], 0)
        self.assertIn("observed_archive_index.json", receipt["verifiedPaths"])
        self.assertTrue(any(path.startswith("observed_archive/stone-harbor/") for path in receipt["verifiedPaths"]))
        for relative in (*receipt["verifiedPaths"], "observed15min.json", "city-gauge/data/index.json"):
            self.assertEqual((self.source / relative).read_bytes(), (self.site / relative).read_bytes())
        self.assertEqual((self.site / "index.html").read_text(encoding="utf-8"), "approved UI")

    def test_rejects_invalid_pair_before_writing_either_file(self):
        (self.source / FORECAST_PATHS[1]).write_text("{}", encoding="utf-8")
        with self.assertRaises(ValueError):
            stage_data(self.source, self.site, now=self.now)
        for relative in FORECAST_PATHS:
            self.assertEqual((self.site / relative).read_text(encoding="utf-8"), "previous guidance")

    def test_rejects_missing_shard_before_staging_the_index_or_forecast(self):
        index_path = "observed_archive_index.json"
        index = json.loads((self.source / index_path).read_text(encoding="utf-8"))
        latest = index["shardPathTemplate"].format(year=index["archiveEndDate"][:4])
        (self.source / latest).unlink()
        with self.assertRaisesRegex(ValueError, "references missing shard"):
            stage_data(self.source, self.site, now=self.now)
        for relative in (index_path, *FORECAST_PATHS):
            self.assertEqual((self.site / relative).read_text(encoding="utf-8"), "previous guidance")


if __name__ == "__main__":
    unittest.main()
