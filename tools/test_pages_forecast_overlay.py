import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from pages_forecast_overlay import FORECAST_PATHS, OBSERVED_INDEXES, generated_paths, stage_pages_data
from release_data import V41_FORECAST_FILES, utc_time


REPO = Path(__file__).resolve().parents[1]


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
        self.observation_shards = {}
        for index, directory in OBSERVED_INDEXES.items():
            current = json.loads((REPO / index).read_text(encoding="utf-8"))
            self.observation_shards[index] = f"{directory}/{current['archiveEndDate'][:4]}.json"
        self.changed_paths = (*FORECAST_PATHS, *(path for pair in self.observation_shards.items() for path in pair))
        for relative in generated_paths(REPO):
            if relative in V41_FORECAST_FILES:
                continue  # Each V41 test supplies independent fixture bytes.
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
        self.assertEqual(receipt["verifiedPaths"], list(self.changed_paths))
        for index, shard in self.observation_shards.items():
            self.assertEqual(receipt["observations"][index]["shard"], shard)
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
        for shard in self.observation_shards.values():
            with self.subTest(shard=shard):
                (self.source / shard).unlink()
                with self.assertRaisesRegex(ValueError, "missing indexed observation shards"):
                    stage_pages_data(self.source, self.site, now=self.now)
                self.assert_original_data()
                link_or_copy(REPO / shard, self.source / shard)

    def write_v41_run(self, issue_utc="2026-11-10T12:00:00Z", **overrides):
        directory = self.source / "data/v41"
        directory.mkdir()
        payload = {
            "status": "passed",
            "issue_utc": issue_utc,
            "forecast_hours": 360,
            "weather_paths": 103,
            "proxy_label": "Stone Harbor levels in North Wildwood MLLW",
            "chart_url": "latest.png",
            "csv_url": "latest.csv",
            **overrides,
        }
        paths = directory / "latest.json", directory / "latest.png", directory / "latest.csv"
        paths[0].write_text(json.dumps(payload), encoding="utf-8")
        paths[1].write_bytes(b"\x89PNG\r\n\x1a\n")
        paths[2].write_text("time_utc,expected_ft_mllw\n", encoding="utf-8")
        return paths

    def test_stages_only_v41_data_artifacts(self):
        paths = self.write_v41_run()
        (paths[0].parent / "index.html").write_text("unapproved experimental UI", encoding="utf-8")
        site_viewer = self.site / "data/v41/index.html"
        site_viewer.parent.mkdir(parents=True)
        site_viewer.write_text("approved experimental UI", encoding="utf-8")
        receipt = stage_pages_data(self.source, self.site, now=self.now)
        self.assertEqual(receipt["v41"]["weatherPaths"], 103)
        for path in paths:
            self.assertEqual(path.read_bytes(), (self.site / path.relative_to(self.source)).read_bytes())
        self.assertEqual(site_viewer.read_text(encoding="utf-8"), "approved experimental UI")

    def test_rejects_v41_horizon_unavailable_for_issue_cycle(self):
        self.write_v41_run(issue_utc="2026-11-10T06:00:00Z")
        with self.assertRaisesRegex(ValueError, "V41 forecast horizon"):
            stage_pages_data(self.source, self.site, now=self.now)
        self.assert_original_data()

    def test_rejects_v41_offsite_url(self):
        self.write_v41_run(chart_url="https://example.invalid/latest.png")
        with self.assertRaisesRegex(ValueError, "same-directory"):
            stage_pages_data(self.source, self.site, now=self.now)
        self.assert_original_data()

    def assert_original_data(self):
        for relative in self.changed_paths:
            self.assertEqual((self.site / relative).read_text(encoding="utf-8"), "previous data")


if __name__ == "__main__":
    unittest.main()
