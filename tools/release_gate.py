#!/usr/bin/env python3
"""Pin production to checked application code and validated generated data.

Data-only commits inherit checks only from their nearest application-changing
first-parent ancestor. They never inherit checks across another code change.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from release_data import GENERATED_DIRECTORIES, GENERATED_FILES, validate_data


REQUIRED_WORKFLOWS = {
    "test-reliability.yml": ("contracts", "full-app-browser (chromium)", "full-app-browser (webkit)"),
    "export-regression.yml": ("export",),
    "depth-query-regression.yml": ("depth-query",),
    "hourly-replay-regression.yml": ("hourly-replay",),
}


class ReleaseError(RuntimeError):
    pass


class GitHubError(ReleaseError):
    def __init__(self, status, path):
        self.status = status
        super().__init__(f"GitHub release evidence unavailable: HTTP {status} at {path}")


@dataclass(frozen=True)
class Decision:
    status: str
    reasons: tuple
    runs: dict


def assess_checks(candidate, repository, runs_by_workflow, jobs_by_run):
    """Pure policy: no unrelated SHA, skipped matrix job, or old green retry counts."""
    pending, blocked, accepted = [], [], {}
    for workflow, required_jobs in REQUIRED_WORKFLOWS.items():
        matches = [run for run in runs_by_workflow.get(workflow, [])
                   if run.get("head_sha") == candidate
                   and (run.get("head_branch") == "main" or (
                       run.get("event") == "workflow_dispatch"
                       and run.get("head_branch") == "shorelysafe-validation-" + candidate))
                   and (run.get("head_repository") or {}).get("full_name") == repository
                   and run.get("event") in {"push", "workflow_dispatch"}]
        if not matches:
            pending.append(f"{workflow}: no run for {candidate}")
            continue
        latest = max(matches, key=lambda run: (run.get("run_number", 0), run["id"], run.get("run_attempt", 1)))
        accepted[workflow] = {"id": latest["id"], "attempt": latest.get("run_attempt", 1)}
        if latest.get("status") != "completed":
            pending.append(f"{workflow}: {latest.get('status', 'unknown')}")
        elif latest.get("conclusion") != "success":
            blocked.append(f"{workflow}: {latest.get('conclusion', 'unknown conclusion')}")
        else:
            jobs = {job["name"]: job for job in jobs_by_run.get(latest["id"], [])}
            for name in required_jobs:
                job = jobs.get(name)
                if not job or job.get("status") != "completed" or job.get("conclusion") != "success":
                    blocked.append(f"{workflow}: required job {name!r} did not pass")
    if blocked:
        return Decision("blocked", tuple(blocked + pending), accepted)
    return Decision("pending" if pending else "ready", tuple(pending), accepted)


def git(source, *args):
    return subprocess.check_output(["git", *args], cwd=source, text=True).strip()


def changed_files(source, older, newer):
    return git(source, "diff", "--name-only", "--no-renames", older, newer).splitlines()


def application_ancestor(source, candidate):
    """Find identical application code without assuming the immediately prior SHA passed."""
    # Let Git walk changed paths instead of spawning a process for each hourly
    # forecast commit. There is no arbitrary age limit on a stable application.
    paths = [":(exclude,literal)" + path for path in sorted(GENERATED_FILES)]
    paths.extend(":(exclude,glob)" + prefix + "**/*.json" for prefix in GENERATED_DIRECTORIES)
    commit = git(source, "log", "--first-parent", "--format=%H", "-1", candidate, "--", ".", *paths)
    if not commit:
        raise ReleaseError("No application ancestor found; refusing to infer test coverage")
    return commit


class GitHub:
    def __init__(self, repository, token):
        self.repository = repository
        self.token = token

    def get(self, path, parameters=None):
        return self.request("GET", path, parameters=parameters)

    def post(self, path, data):
        return self.request("POST", path, data=data)

    def request(self, method, path, parameters=None, data=None):
        query = "?" + urllib.parse.urlencode(parameters) if parameters else ""
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}/{path}{query}",
            data=json.dumps(data).encode() if data is not None else None,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
                     "User-Agent": "north-wildwood-release-gate"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return {} if response.status == 204 else json.load(response)
        except urllib.error.HTTPError as error:
            raise GitHubError(error.code, path) from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise ReleaseError(f"GitHub release evidence unavailable at {path}") from None

    def main_head(self):
        return self.get("git/ref/heads/main")["object"]["sha"]

    def workflow_runs(self, workflow, candidate):
        # GitHub filters head_sha server-side; the policy also checks it locally.
        return self.get(f"actions/workflows/{workflow}/runs", {
            "head_sha": candidate, "per_page": 100,
        })["workflow_runs"]

    def jobs(self, run_id):
        result, page = [], 1
        while True:
            data = self.get(f"actions/runs/{run_id}/jobs", {"filter": "latest", "per_page": 100, "page": page})
            result.extend(data["jobs"])
            if len(result) >= data["total_count"]:
                return result
            page += 1


def assert_current(api, candidate):
    if api.main_head() != candidate:
        raise ReleaseError("Selected release has been superseded on main; refusing to activate older files")


def wait_for_checks(api, candidate, timeout, interval=20, release_candidate=None):
    deadline, previous, jobs_cache = time.monotonic() + timeout, None, {}
    while True:
        if release_candidate is not None:
            assert_current(api, release_candidate)
        all_runs = {workflow: api.workflow_runs(workflow, candidate) for workflow in REQUIRED_WORKFLOWS}
        all_jobs = {}
        for runs in all_runs.values():
            for run in runs:
                if run.get("head_sha") == candidate and run.get("status") == "completed" and run.get("conclusion") == "success":
                    key = (run["id"], run.get("run_attempt", 1))
                    if key not in jobs_cache:
                        jobs_cache[key] = api.jobs(run["id"])
                    all_jobs[run["id"]] = jobs_cache[key]
        decision = assess_checks(candidate, api.repository, all_runs, all_jobs)
        if decision.status == "ready":
            return decision.runs
        if decision.reasons != previous:
            print("Release checks: " + "; ".join(decision.reasons), flush=True)
            previous = decision.reasons
        if decision.status == "blocked":
            raise ReleaseError("Required regression checks failed or were skipped; deployment is blocked")
        if time.monotonic() >= deadline:
            raise ReleaseError("Timed out waiting for exact-commit regression checks; deployment is blocked")
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=2100)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.candidate) or not args.repository:
        parser.error("A full immutable commit SHA and repository are required")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        parser.error("A read-only GitHub Actions token is required")
    api = GitHub(args.repository, token)
    if git(args.source, "rev-parse", "HEAD") != args.candidate:
        raise ReleaseError("Checkout does not match the selected immutable release")
    if api.main_head() != args.candidate:
        print("Release superseded on main; no files will be published.")
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as handle:
                handle.write("publish=false\n")
        return
    anchor = application_ancestor(args.source, args.candidate)
    data_changes = changed_files(args.source, anchor, args.candidate)
    data = validate_data(args.source, data_changes)
    checks = wait_for_checks(api, anchor, args.timeout, release_candidate=args.candidate)
    assert_current(api, args.candidate)
    receipt = {"releaseSha": args.candidate, "applicationSha": anchor, "repository": args.repository,
               "checks": checks, "data": data, "validatedUtc": datetime.now(timezone.utc).isoformat()}
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as handle:
            handle.write("publish=true\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
