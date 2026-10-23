#!/usr/bin/env python3
"""Validate real generated archives and reject corrupt inherited data releases."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from release_data import validate_data, validate_forecast
from release_schemas import validate_generated
from test_release_gate import forecast, TEST_NOW

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = (
    "data/experimental_petss_guidance.json", "observed.json", "observed15min.json",
    "stone_harbor_observed15min.json", "toptides.json", "observed_archive_index.json",
    "lewes_archive_index.json", "lewes_hourly.json", "observed_archive/stone-harbor/2026.json",
    "observed_archive/lewes/1962.json", "city-gauge/data/index.json", "city-gauge/data/2026.json",
    "city-gauge/comparison/index.json", "city-gauge/comparison/2026.json",
)


def committed_payload(path):
    local = ROOT / path
    raw = local.read_bytes() if local.exists() else subprocess.check_output(["git", "show", "HEAD:" + path], cwd=ROOT)
    return json.loads(raw)


def small_sample(path):
    payload = committed_payload(path)
    if "days" in payload:
        payload["days"] = payload["days"][:1]
        key = "date" if path == "observed.json" else "d"
        for bound in ("archiveStartDate", "archiveEndDate"):
            if bound in payload:
                payload[bound] = payload["days"][0][key]
    return payload


class ArtifactSchemaTests(unittest.TestCase):
    def test_all_current_committed_artifact_types_pass_consumed_schemas(self):
        for path in ARTIFACTS:
            with self.subTest(path=path):
                validate_generated(path, committed_payload(path))

    def test_every_artifact_rejects_a_nonempty_but_wrong_object(self):
        for path in ARTIFACTS:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    validate_generated(path, {"broken": True})

    def test_original_toptides_release_bypass_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "forecast.json").write_text(json.dumps(forecast()))
            (source / "toptides.json").write_text('{"broken":true}')
            with self.assertRaisesRegex(ValueError, "schema"):
                validate_data(source, ["toptides.json"], now=TEST_NOW)

    def test_empty_archives_indexes_and_crest_lists_are_rejected(self):
        for path, key in (("observed.json", "days"), ("observed15min.json", "days"),
                          ("observed_archive_index.json", "days"), ("toptides.json", "toptides")):
            with self.subTest(path=path):
                payload = small_sample(path)
                payload[key] = []
                with self.assertRaises(ValueError):
                    validate_generated(path, payload)

    def test_index_station_template_category_and_dates_are_checked(self):
        for mutation in (
            lambda data: data.update(stationId="wrong-gauge"),
            lambda data: data.update(shardPathTemplate="https://example.invalid/{year}.json"),
            lambda data: data["days"][0].update(p="9.9"),
            lambda data: data["days"][0].update(c="major"),
            lambda data: data["days"][0].update(d="not-a-date"),
        ):
            payload = small_sample("observed_archive_index.json")
            mutation(payload)
            with self.assertRaises(ValueError):
                validate_generated("observed_archive_index.json", payload)

    def test_compact_sample_alignment_peak_and_source_metadata_are_checked(self):
        for mutation in (
            lambda data: data["days"][0].update(p=9999),
            lambda data: data["days"][0].update(q="M"),
            lambda data: data["days"][0].update(v=[]),
            lambda data: data.update(datum="MLLW"),
        ):
            payload = small_sample("observed15min.json")
            mutation(payload)
            with self.assertRaises(ValueError):
                validate_generated("observed15min.json", payload)
        payload = small_sample("observed_archive/lewes/1962.json")
        payload["year"] = 1963
        with self.assertRaises(ValueError):
            validate_generated("observed_archive/lewes/1962.json", payload)

    def test_hourly_replay_timestamps_levels_and_peaks_are_checked(self):
        for mutation in (
            lambda data: data["days"][0]["hours"][0].update(timeUtc="2026-10-23T00:00:00Z"),
            lambda data: data["days"][0]["hours"][0].update(mllwStageFt=99),
            lambda data: data["days"][0].update(peakNAVD88=99),
        ):
            payload = small_sample("observed.json")
            mutation(payload)
            with self.assertRaises(ValueError):
                validate_generated("observed.json", payload)

    def test_crest_heights_and_datums_are_checked(self):
        payload = small_sample("toptides.json")
        payload["toptides"][0]["height_ft"] = "7.5"
        with self.assertRaises(ValueError):
            validate_generated("toptides.json", payload)
        payload["toptides"][0].update(height_ft=7.5, datum="MLLW")
        with self.assertRaises(ValueError):
            validate_generated("toptides.json", payload)

    def test_city_readings_sensor_counts_and_index_paths_are_checked(self):
        for path, mutate in (
            ("city-gauge/data/2026.json", lambda data: data["readings"][0].append(99)),
            ("city-gauge/data/2026.json", lambda data: data.update(recordCount=1)),
            ("city-gauge/data/2026.json", lambda data: data["sensor"].update(datum="NAVD88")),
            ("city-gauge/data/index.json", lambda data: data["years"][0].update(path="../other.json")),
            ("city-gauge/data/index.json", lambda data: data["annualFlooding"]["years"][0].update(total=999)),
        ):
            payload = small_sample(path)
            mutate(payload)
            with self.assertRaises(ValueError):
                validate_generated(path, payload)

    def test_comparison_pair_counts_rows_and_source_identities_are_checked(self):
        for path, mutate in (
            ("city-gauge/comparison/2026.json", lambda data: data["points"][0].pop()),
            ("city-gauge/comparison/2026.json", lambda data: data["stats"].update(pairCount=1)),
            ("city-gauge/comparison/2026.json", lambda data: data["sources"]["stoneHarbor"].update(stationId="wrong")),
            ("city-gauge/comparison/index.json", lambda data: data["years"][0].update(path="../other.json")),
        ):
            payload = small_sample(path)
            mutate(payload)
            with self.assertRaises(ValueError):
                validate_generated(path, payload)

    def test_research_guidance_cannot_become_operational_or_lose_hours(self):
        payload = small_sample("data/experimental_petss_guidance.json")
        payload["model"]["useForMapsOrAlerts"] = True
        with self.assertRaises(ValueError):
            validate_generated("data/experimental_petss_guidance.json", payload)
        payload["model"]["useForMapsOrAlerts"] = False
        payload["zones"][0]["hours"] = []
        with self.assertRaises(ValueError):
            validate_generated("data/experimental_petss_guidance.json", payload)

    def test_unknown_json_under_a_generated_directory_has_no_schema_bypass(self):
        with self.assertRaisesRegex(ValueError, "No generated-data schema"):
            validate_generated("observed_archive/unknown.json", {"broken": True})


class ForecastFreshnessTests(unittest.TestCase):
    def test_expired_guidance_is_rejected_using_valid_time_coverage(self):
        with self.assertRaisesRegex(ValueError, "expired"):
            validate_forecast(forecast(), now=TEST_NOW + timedelta(hours=2))

    def test_current_build_timestamp_cannot_hide_an_old_source_cycle(self):
        payload = forecast()
        payload["petssCycleUtc"] = (TEST_NOW - timedelta(hours=73)).isoformat()
        with self.assertRaisesRegex(ValueError, "72-hour"):
            validate_forecast(payload, now=TEST_NOW)

    def test_source_outage_is_tolerated_within_72_hours_and_future_coverage(self):
        payload = forecast()
        payload["petssCycleUtc"] = (TEST_NOW - timedelta(hours=71)).isoformat()
        result = validate_forecast(payload, now=TEST_NOW)
        self.assertEqual(result["sourceAgeHours"], 71)
        self.assertEqual(result["remainingCoverageHours"], 1)

    def test_real_release_default_uses_the_current_utc_clock(self):
        with patch("release_data.datetime", wraps=datetime) as clock:
            clock.now.return_value = TEST_NOW + timedelta(hours=2)
            with self.assertRaisesRegex(ValueError, "expired"):
                validate_forecast(forecast())
            clock.now.assert_called_once_with(timezone.utc)

    def test_future_build_and_naive_validation_clocks_are_rejected(self):
        payload = forecast()
        payload.update(issuedUtc=(TEST_NOW + timedelta(hours=2)).isoformat(),
                       forecastEndUtc=(TEST_NOW + timedelta(hours=3)).isoformat())
        with self.assertRaisesRegex(ValueError, "future"):
            validate_forecast(payload, now=TEST_NOW)
        with self.assertRaisesRegex(ValueError, "clock must identify UTC"):
            validate_forecast(forecast(), now=TEST_NOW.replace(tzinfo=None))

    def test_current_committed_forecast_has_consistent_future_coverage_at_issuance(self):
        payload = committed_payload("forecast.json")
        issued = datetime.fromisoformat(payload["issuedUtc"].replace("Z", "+00:00"))
        self.assertGreater(validate_forecast(payload, now=issued)["remainingCoverageHours"], 0)


if __name__ == "__main__":
    unittest.main()
