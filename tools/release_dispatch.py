#!/usr/bin/env python3
"""Run required checks for a GITHUB_TOKEN-generated application asset commit.

GitHub workflow dispatch accepts a branch or tag. A SHA-derived validation tag
pins all four dispatches even if hourly data updates advance main between them.
"""
import argparse
import os
import re

from release_gate import GitHub, GitHubError, REQUIRED_WORKFLOWS, ReleaseError


def dispatch_checks(api, candidate):
    if not re.fullmatch(r"[0-9a-f]{40}", candidate):
        raise ReleaseError("An immutable full commit SHA is required for generated-asset checks")
    comparison = api.get(f"compare/{candidate}...main")
    if comparison.get("status") not in {"identical", "ahead"} or comparison.get("base_commit", {}).get("sha") != candidate:
        raise ReleaseError("Generated application commit must be an ancestor of current main")
    tag = "shorelysafe-validation-" + candidate
    try:
        api.post("git/refs", {"ref": "refs/tags/" + tag, "sha": candidate})
    except GitHubError as error:
        if error.status != 422:
            raise
        # An idempotent retry may find the already-created tag. Never move it.
    existing = api.get("git/ref/tags/" + tag)
    if existing.get("object", {}).get("sha") != candidate:
        raise ReleaseError("Validation tag does not point to the generated application commit")
    for workflow in REQUIRED_WORKFLOWS:
        api.post(f"actions/workflows/{workflow}/dispatches", {"ref": tag})
    return {"applicationSha": candidate, "validationTag": tag, "workflows": list(REQUIRED_WORKFLOWS)}


def main():
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN")
    if not token or not args.repository:
        parser.error("GH_TOKEN and repository are required")
    print(json.dumps(dispatch_checks(GitHub(args.repository, token), args.candidate)))


if __name__ == "__main__":
    try:
        main()
    except ReleaseError as error:
        raise SystemExit(str(error)) from None
