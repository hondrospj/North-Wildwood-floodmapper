#!/usr/bin/env python3
"""Regression tests for immutable application releases and validated data updates."""
from copy import deepcopy
from contextlib import redirect_stdout
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import Mock, patch

from release_data import GENERATED_DIRECTORIES, GENERATED_FILES, is_generated_data, read_json, validate_data, validate_forecast
from release_gate import REQUIRED_WORKFLOWS, GitHubError, ReleaseError, application_ancestor, assess_checks, assert_current, wait_for_checks
from release_dispatch import dispatch_checks

ROOT = Path(__file__).resolve().parents[1]
SHA, OTHER_SHA, REPOSITORY = "a" * 40, "b" * 40, "example/North-Wildwood-floodmapper"
TEST_NOW = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
SPEC = importlib.util.spec_from_file_location("shorelysafe_publish", ROOT / ".shorelysafe/publish.py")
PUBLISHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLISHER)


def evidence():
    runs, jobs = {}, {}
    for run_id, (workflow, names) in enumerate(REQUIRED_WORKFLOWS.items(), 1):
        runs[workflow] = [{"id": run_id, "run_number": run_id, "run_attempt": 1,
                           "head_sha": SHA, "head_branch": "main", "head_repository": {"full_name": REPOSITORY},
                           "event": "push", "status": "completed", "conclusion": "success"}]
        jobs[run_id] = [{"name": name, "status": "completed", "conclusion": "success"} for name in names]
    return runs, jobs


def forecast():
    hours = [{"timeUtc": time, "navd88StageFt": 1.0, "mllwStageFt": 3.75}
             for time in ("2026-10-23T12:00:00Z", "2026-10-23T13:00:00Z")]
    return {"sourceDatum": "MLLW", "mapDatum": "NAVD88", "navd88OffsetFromMllwFt": -2.75,
            "issuedUtc": "2026-10-23T12:00:00Z", "petssCycleUtc": "2026-10-23T06:00:00Z",
            "forecastStartUtc": hours[0]["timeUtc"], "forecastEndUtc": hours[-1]["timeUtc"],
            "scenarioForecasts": {name: {"hours": deepcopy(hours)} for name in ("mean", "lowEnd", "highEnd")},
            "hours": deepcopy(hours)}


class CheckPolicyTests(unittest.TestCase):
    def test_all_required_jobs_must_pass_for_exact_commit(self):
        runs, jobs = evidence()
        decision = assess_checks(SHA, REPOSITORY, runs, jobs)
        self.assertEqual(decision.status, "ready")
        self.assertEqual(set(decision.runs), set(REQUIRED_WORKFLOWS))

    def test_missing_workflow_waits_instead_of_authorizing_release(self):
        runs, jobs = evidence()
        del runs["depth-query-regression.yml"]
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_pending_workflow_waits(self):
        runs, jobs = evidence()
        runs["export-regression.yml"][0].update(status="in_progress", conclusion=None)
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_failed_canceled_skipped_and_timed_out_runs_block(self):
        for conclusion in ("failure", "cancelled", "skipped", "timed_out", "neutral", None):
            with self.subTest(conclusion=conclusion):
                runs, jobs = evidence()
                runs["export-regression.yml"][0]["conclusion"] = conclusion
                self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "blocked")

    def test_wrong_sha_repo_branch_or_event_is_not_evidence(self):
        for changes in ({"head_sha": OTHER_SHA}, {"head_repository": {"full_name": "attacker/fork"}},
                        {"head_branch": "feature"}, {"event": "pull_request"}):
            with self.subTest(changes=changes):
                runs, jobs = evidence()
                runs["export-regression.yml"][0].update(changes)
                self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_missing_or_skipped_webkit_does_not_pass_a_green_workflow(self):
        for kind in ("missing", "skipped", "failure"):
            with self.subTest(kind=kind):
                runs, jobs = evidence()
                if kind == "missing":
                    jobs[1] = jobs[1][:-1]
                else:
                    jobs[1][-1]["conclusion"] = kind
                self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "blocked")

    def test_latest_failed_run_overrides_an_older_success(self):
        runs, jobs = evidence()
        retry = dict(runs["export-regression.yml"][0], id=100, run_number=100, conclusion="failure")
        runs["export-regression.yml"].append(retry)
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "blocked")

    def test_latest_pending_run_overrides_an_older_success(self):
        runs, jobs = evidence()
        runs["export-regression.yml"].append(dict(runs["export-regression.yml"][0],
            id=100, run_number=100, status="queued", conclusion=None))
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_an_older_successful_workflow_event_cannot_authorize_new_application_code(self):
        runs, jobs = evidence()
        # A completion can select newer main, but its older successful run is
        # never evidence for that newer application's SHA.
        decision = assess_checks(OTHER_SHA, REPOSITORY, runs, jobs)
        self.assertEqual(decision.status, "pending")
        self.assertEqual(len(decision.reasons), len(REQUIRED_WORKFLOWS))
        self.assertEqual(decision.runs, {})

    def test_generated_asset_dispatch_requires_its_exact_sha_derived_validation_tag(self):
        runs, jobs = evidence()
        for entries in runs.values():
            entries[0].update(event="workflow_dispatch", head_branch="shorelysafe-validation-" + SHA)
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "ready")
        runs["export-regression.yml"][0]["head_branch"] = "shorelysafe-validation-" + OTHER_SHA
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_a_push_from_a_validation_named_branch_is_not_trusted(self):
        runs, jobs = evidence()
        runs["export-regression.yml"][0]["head_branch"] = "shorelysafe-validation-" + SHA
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).status, "pending")

    def test_retry_attempt_is_recorded_in_release_receipt(self):
        runs, jobs = evidence()
        runs["export-regression.yml"][0]["run_attempt"] = 3
        self.assertEqual(assess_checks(SHA, REPOSITORY, runs, jobs).runs["export-regression.yml"]["attempt"], 3)

    def test_missing_checks_time_out_without_publishing(self):
        api = Mock(repository=REPOSITORY)
        api.workflow_runs.return_value = []
        with self.assertRaisesRegex(ReleaseError, "Timed out"):
            wait_for_checks(api, SHA, timeout=0)

    def test_main_movement_aborts_before_or_during_checks(self):
        api = Mock(repository=REPOSITORY)
        api.main_head.return_value = OTHER_SHA
        with self.assertRaisesRegex(ReleaseError, "superseded"):
            assert_current(api, SHA)
        with self.assertRaisesRegex(ReleaseError, "superseded"):
            wait_for_checks(api, SHA, timeout=0, release_candidate=SHA)
        api.workflow_runs.assert_not_called()


class WorkflowSelectionTests(unittest.TestCase):
    def select(self, event, selected=OTHER_SHA):
        workflow = (ROOT / ".github/workflows/publish-cupajoe.yml").read_text()
        block = workflow.split("          python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        code = compile(textwrap.dedent(block), "publish-cupajoe/select-candidate", "exec")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            environment = {"GITHUB_EVENT_NAME": event, "GITHUB_SHA": SHA, "GITHUB_OUTPUT": str(output),
                           "GITHUB_REPOSITORY": REPOSITORY, "GH_TOKEN": "test-token"}
            response = io.BytesIO(json.dumps({"object": {"sha": selected}}).encode())
            with patch.dict(os.environ, environment, clear=True), patch("urllib.request.urlopen", return_value=response) as request:
                with redirect_stdout(io.StringIO()):
                    exec(code, {})
                return output.read_text().strip(), request.call_count

    def test_workflow_completion_coalesces_to_one_immutable_current_main_sha(self):
        self.assertEqual(self.select("workflow_run"), ("sha=" + OTHER_SHA, 1))

    def test_push_and_manual_releases_pin_their_event_sha(self):
        for event in ("push", "workflow_dispatch"):
            with self.subTest(event=event):
                self.assertEqual(self.select(event), ("sha=" + SHA, 0))

    def test_invalid_main_response_cannot_inject_a_ref_or_workflow_output(self):
        with self.assertRaisesRegex(SystemExit, "full commit SHA"):
            self.select("workflow_run", "main\npublish=true")


class GeneratedAssetDispatchTests(unittest.TestCase):
    def api(self):
        api = Mock()
        api.get.side_effect = [{"status": "identical", "base_commit": {"sha": SHA}}, {"object": {"sha": SHA}}]
        return api

    def test_every_required_suite_receives_the_same_immutable_tag(self):
        api = self.api()
        result = dispatch_checks(api, SHA)
        calls = api.post.call_args_list
        self.assertEqual(calls[0].args, ("git/refs", {"ref": "refs/tags/shorelysafe-validation-" + SHA, "sha": SHA}))
        self.assertEqual([call.args[0] for call in calls[1:]],
                         [f"actions/workflows/{name}/dispatches" for name in REQUIRED_WORKFLOWS])
        self.assertTrue(all(call.args[1] == {"ref": "shorelysafe-validation-" + SHA} for call in calls[1:]))
        self.assertEqual(result["applicationSha"], SHA)

    def test_existing_tag_is_reused_without_moving_it(self):
        api = self.api()
        def post(path, data):
            if path == "git/refs":
                raise GitHubError(422, path)
        api.post.side_effect = post
        self.assertEqual(dispatch_checks(api, SHA)["applicationSha"], SHA)

    def test_wrong_tag_target_and_unrelated_commit_cannot_dispatch_checks(self):
        api = self.api()
        api.get.side_effect = [{"status": "ahead", "base_commit": {"sha": SHA}}, {"object": {"sha": OTHER_SHA}}]
        with self.assertRaisesRegex(ReleaseError, "Validation tag"):
            dispatch_checks(api, SHA)
        self.assertEqual(api.post.call_count, 1)
        for status in ("behind", "diverged"):
            api = Mock()
            api.get.return_value = {"status": status, "base_commit": {"sha": SHA}}
            with self.assertRaisesRegex(ReleaseError, "ancestor"):
                dispatch_checks(api, SHA)
            api.post.assert_not_called()

    def test_converter_explicitly_dispatches_checks_and_wakes_publisher(self):
        converter = (ROOT / ".github/workflows/convert-overlay-webp.yml").read_text()
        publisher = (ROOT / ".github/workflows/publish-cupajoe.yml").read_text()
        self.assertIn("actions: write", converter)
        self.assertIn('tools/release_dispatch.py --candidate "$GENERATED_SHA"', converter)
        self.assertIn("- Build lossless flood overlay WebP", publisher)


class DataPolicyTests(unittest.TestCase):
    def test_only_explicit_generated_json_uses_the_data_path(self):
        for path in ("forecast.json", "observed_archive/lewes/1962.json", "city-gauge/data/2026.json"):
            self.assertTrue(is_generated_data(path))
        for path in ("index.html", "assets/app/main.js", "data/config.json", "observed_archive/helper.js",
                     "tools/release_gate.py", ".shorelysafe/publish.py", "forecast.json.js"):
            self.assertFalse(is_generated_data(path))

    def test_all_regression_triggers_match_the_data_policy(self):
        expected = set(GENERATED_FILES) | {prefix + "**/*.json" for prefix in GENERATED_DIRECTORIES}
        for workflow in REQUIRED_WORKFLOWS:
            text = (ROOT / ".github/workflows" / workflow).read_text()
            before_jobs = text.split("permissions:")[0]
            for block in before_jobs.split("paths-ignore:\n")[1:]:
                entries = set()
                for line in block.splitlines():
                    if not line.startswith("      - "):
                        break
                    entries.add(line.removeprefix("      - "))
                self.assertEqual(entries, expected, workflow)
            self.assertEqual(before_jobs.count("paths-ignore:"), 2, workflow)

    def test_forecast_contract_accepts_current_operational_shape(self):
        self.assertEqual(validate_forecast(forecast(), now=TEST_NOW)["hours"], 2)

    def test_bad_datums_cycle_times_order_and_missing_scenarios_fail(self):
        modifications = [
            lambda data: data.update(mapDatum="MLLW"),
            lambda data: data.update(petssCycleUtc="2026-10-24T00:00:00Z"),
            lambda data: data.update(forecastEndUtc="2026-10-23T11:00:00Z"),
            lambda data: data["scenarioForecasts"].pop("lowEnd"),
            lambda data: data["scenarioForecasts"]["mean"]["hours"][0].update(navd88StageFt=99),
            lambda data: data["scenarioForecasts"]["mean"]["hours"].reverse(),
            lambda data: data["scenarioForecasts"]["highEnd"]["hours"][0].update(timeUtc="2026-10-23T12:30:00Z"),
            lambda data: data["scenarioForecasts"]["mean"]["hours"][0].update(navd88StageFt=True),
            lambda data: data.update(hours=[]),
        ]
        for modify in modifications:
            with self.subTest(modify=modify):
                data = forecast()
                modify(data)
                with self.assertRaises(ValueError):
                    validate_forecast(data, now=TEST_NOW)

    def test_crossed_scenario_envelope_is_rejected_even_with_valid_datums(self):
        data = forecast()
        data["scenarioForecasts"]["lowEnd"]["hours"][0].update(navd88StageFt=2, mllwStageFt=4.75)
        with self.assertRaisesRegex(ValueError, "out of order"):
            validate_forecast(data, now=TEST_NOW)

    def test_invalid_json_nonfinite_numbers_duplicate_keys_and_empty_data_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "forecast.json"
            for value in ('{"v":NaN}', '{"v":1e999}', '{"v":1,"v":2}', '{}', '[]', 'false', '{bad'):
                with self.subTest(value=value):
                    path.write_text(value)
                    with self.assertRaises(ValueError):
                        read_json(path)

    def test_deleted_generated_data_and_application_files_cannot_be_published_as_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "forecast.json").write_text(json.dumps(forecast()))
            with self.assertRaises(FileNotFoundError):
                validate_data(root, ["observed.json"], now=TEST_NOW)
            with self.assertRaisesRegex(ValueError, "Application file"):
                validate_data(root, ["index.html"], now=TEST_NOW)
            self.assertEqual(validate_data(root, ["forecast.json"], now=TEST_NOW)["validatedGeneratedFiles"], 1)

    def test_observation_updates_require_the_existing_provenance_validator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "forecast.json").write_text(json.dumps(forecast()))
            (root / "observed.json").write_text('{"days":[1]}')
            with patch("release_data.validate_generated"), patch("validate_observed_contract.validate", side_effect=ValueError("bad provenance")) as validate:
                with self.assertRaisesRegex(ValueError, "bad provenance"):
                    validate_data(root, ["observed.json"], now=TEST_NOW)
                validate.assert_called_once_with(root / "observed15min.json")


class AncestorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.git("init", "--quiet")
        self.git("config", "user.email", "release-test@example.invalid")
        self.git("config", "user.name", "Release tests")

    def tearDown(self):
        self.directory.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True).strip()

    def commit(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        self.git("add", path)
        self.git("commit", "--quiet", "-m", path)
        return self.git("rev-parse", "HEAD")

    def test_data_only_chain_inherits_only_its_nearest_application_commit(self):
        initial = self.commit("index.html", "original UI")
        forecast_sha = self.commit("forecast.json", "{}")
        observed_sha = self.commit("observed.json", "{}")
        self.assertEqual(application_ancestor(self.root, forecast_sha), initial)
        self.assertEqual(application_ancestor(self.root, observed_sha), initial)
        new_code = self.commit("assets/app/main.js", "untested application code")
        newer_data = self.commit("forecast.json", '{"updated":true}')
        self.assertEqual(application_ancestor(self.root, newer_data), new_code)
        self.assertNotEqual(application_ancestor(self.root, newer_data), initial)

    def test_repository_without_application_history_fails_closed(self):
        data = self.commit("forecast.json", "{}")
        with self.assertRaisesRegex(ReleaseError, "No application ancestor"):
            application_ancestor(self.root, data)

    def test_hidden_publisher_changes_and_arbitrary_json_are_application_changes(self):
        self.commit("index.html", "code")
        for path in (".shorelysafe/publish.py", "data/settings.json", "observed_archive/helper.js"):
            commit = self.commit(path, "code")
            data = self.commit("forecast.json", json.dumps({"update": path}))
            self.assertEqual(application_ancestor(self.root, data), commit)

    def test_merge_importing_application_code_does_not_inherit_old_checks(self):
        original = self.commit("index.html", "code")
        self.git("checkout", "--quiet", "-b", "feature")
        self.commit("assets/app/runtime.js", "new code")
        self.git("checkout", "--quiet", "-")
        self.commit("forecast.json", "{}")
        self.git("merge", "--no-ff", "--quiet", "feature", "-m", "merge code")
        merged = self.git("rev-parse", "HEAD")
        self.assertNotEqual(merged, original)
        self.assertEqual(application_ancestor(self.root, merged), merged)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.app = {"id": "floodmapper--north-wildwood"}
        self.connection = {"site": "https://example.invalid", "tokens": {self.app["id"]: "test-token"}}
        self.manifest = {"commit": SHA, "files": [{"path": "index.html", "sha256": "test", "size": 1}]}
        self.git_status = patch.object(PUBLISHER.subprocess, "check_output", return_value="").start()
        self.addCleanup(patch.stopall)

    def test_mismatched_checkout_never_calls_publishing_api(self):
        with patch.object(PUBLISHER, "prepare", return_value=(self.manifest, {})), patch.object(PUBLISHER, "api") as api:
            with self.assertRaisesRegex(ValueError, "validated release"):
                PUBLISHER.publish(self.app, ROOT, [], self.connection, expected_commit=OTHER_SHA)
            api.assert_not_called()

    def test_dirty_checkout_never_calls_publishing_api(self):
        self.git_status.return_value = " M index.html\n"
        with patch.object(PUBLISHER, "prepare", return_value=(self.manifest, {})), patch.object(PUBLISHER, "api") as api:
            with self.assertRaisesRegex(ValueError, "modified tracked files"):
                PUBLISHER.publish(self.app, ROOT, [], self.connection, expected_commit=SHA)
            api.assert_not_called()

    def test_superseded_release_never_activates_uploaded_files(self):
        with patch.object(PUBLISHER, "prepare", return_value=(self.manifest, {})), patch.object(PUBLISHER, "api") as api:
            api.return_value = {"deployment": "test-plan", "missing": []}
            guard = Mock(side_effect=ReleaseError("superseded"))
            with self.assertRaisesRegex(ReleaseError, "superseded"):
                PUBLISHER.publish(self.app, ROOT, [], self.connection, expected_commit=SHA, before_commit=guard)
            self.assertEqual([call.args[3] for call in api.call_args_list], ["plan"])
            guard.assert_called_once_with()

    def test_validated_release_checks_freshness_immediately_before_commit(self):
        order = []
        def api(*args, **kwargs):
            order.append(args[3])
            return {"deployment": "test-plan", "missing": []} if args[3] == "plan" else {"ok": True}
        with patch.object(PUBLISHER, "prepare", return_value=(self.manifest, {})), patch.object(PUBLISHER, "api", side_effect=api):
            result = PUBLISHER.publish(self.app, ROOT, [], self.connection, expected_commit=SHA,
                                       before_commit=lambda: order.append("freshness"))
        self.assertEqual(order, ["plan", "freshness", "commit"])
        self.assertEqual(result["commit"], SHA)


if __name__ == "__main__":
    unittest.main()
