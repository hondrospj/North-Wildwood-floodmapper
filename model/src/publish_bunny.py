#!/usr/bin/env python3
"""Atomically publish completed North Wildwood physics products to Bunny Storage."""

from __future__ import annotations

import argparse
import concurrent.futures
import getpass
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model/config/north_wildwood.json"
KEYCHAIN_SERVICE_PREFIX = "shorelysafe.bunny.storage"
VERIFY_ORIGIN = "https://hondrospj.github.io"
CYCLE_PATTERN = re.compile(r"^\d{8}T\d{4}Z$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def join_remote(*parts: str) -> str:
    return "/".join(
        str(part).strip("/")
        for part in parts
        if str(part).strip("/")
    )


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class BunnyStorage:
    def __init__(
        self,
        zone: str,
        access_key: str,
        storage_host: str = "storage.bunnycdn.com",
        cdn_base_url: str = "",
    ):
        self.zone = zone
        self.access_key = access_key
        self.storage_host = storage_host
        self.cdn_base_url = cdn_base_url.rstrip("/")

    def storage_url(self, remote_path: str, directory: bool = False) -> str:
        encoded = urllib.parse.quote(remote_path.strip("/"), safe="/")
        suffix = "/" if directory else ""
        return f"https://{self.storage_host}/{self.zone}/{encoded}{suffix}"

    def cdn_url(self, remote_path: str) -> str:
        encoded = urllib.parse.quote(remote_path.strip("/"), safe="/")
        return f"{self.cdn_base_url}/{encoded}"

    def request(
        self,
        method: str,
        remote_path: str,
        payload: bytes | None = None,
        content_type: str | None = None,
        directory: bool = False,
        retries: int = 4,
    ) -> tuple[bytes, Any]:
        headers = {"AccessKey": self.access_key}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            self.storage_url(remote_path, directory=directory),
            data=payload,
            method=method,
            headers=headers,
        )
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    return response.read(), response.headers
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == retries - 1:
                    detail = error.read().decode("utf-8", errors="replace")[:500]
                    raise RuntimeError(
                        f"Bunny {method} {remote_path} returned HTTP {error.code}: {detail}"
                    ) from error
            except urllib.error.URLError:
                if attempt == retries - 1:
                    raise
            time.sleep(1.5 * (2**attempt))
        raise RuntimeError(f"Bunny {method} failed for {remote_path}")

    def upload_bytes(
        self,
        remote_path: str,
        payload: bytes,
        content_type: str,
    ) -> None:
        self.request("PUT", remote_path, payload, content_type)

    def upload_file(self, remote_path: str, local_path: Path) -> None:
        content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
        self.upload_bytes(remote_path, local_path.read_bytes(), content_type)

    def list_directory(self, remote_path: str) -> list[dict[str, Any]]:
        payload, _ = self.request("GET", remote_path, directory=True)
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, list):
            raise RuntimeError(f"Unexpected Bunny directory response for {remote_path}")
        return value

    def delete_directory(self, remote_path: str) -> None:
        self.request("DELETE", remote_path, directory=True)

    def fetch_cdn(
        self,
        remote_path: str,
        cache_buster: str,
    ) -> tuple[bytes, Any]:
        url = self.cdn_url(remote_path)
        separator = "&" if "?" in url else "?"
        request = urllib.request.Request(
            f"{url}{separator}_verify={urllib.parse.quote(cache_buster)}",
            headers={
                "Origin": VERIFY_ORIGIN,
                "User-Agent": "North-Wildwood-Physics-Publisher/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.read(), response.headers


def keychain_service(zone: str) -> str:
    return f"{KEYCHAIN_SERVICE_PREFIX}.{zone}"


def read_keychain_key(zone: str) -> str | None:
    result = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            keychain_service(zone),
            "-a",
            zone,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


def store_keychain_key(zone: str, access_key: str) -> None:
    subprocess.run(
        [
            "/usr/bin/security",
            "add-generic-password",
            "-U",
            "-s",
            keychain_service(zone),
            "-a",
            zone,
            "-w",
        ],
        input=access_key + "\n",
        text=True,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def get_access_key(zone: str, setup_key: bool) -> str:
    environment_key = os.environ.get("BUNNY_STORAGE_PASSWORD", "").strip()
    if environment_key:
        return environment_key
    stored = read_keychain_key(zone)
    if stored:
        return stored
    if setup_key:
        supplied = getpass.getpass(
            f"Bunny Storage password for zone {zone} (input hidden): "
        ).strip()
        if not supplied:
            raise RuntimeError("No Bunny Storage password was supplied")
        store_keychain_key(zone, supplied)
        return supplied
    raise RuntimeError(
        "Bunny credentials are not configured. Run this command once with "
        "--setup-key to store the zone password in macOS Keychain, or set "
        "BUNNY_STORAGE_PASSWORD for this process."
    )


def public_files(public_directory: Path) -> list[Path]:
    return sorted(
        path
        for path in public_directory.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    )


def remote_manifest_path(
    remote_root: str,
    cycle_id: str,
    scenario: str,
) -> str:
    return join_remote(remote_root, cycle_id, scenario, "manifest.json.png")


def verify_cors(headers: Any, remote_path: str) -> None:
    allow_origin = str(headers.get("Access-Control-Allow-Origin", ""))
    if allow_origin not in ("*", VERIFY_ORIGIN):
        raise RuntimeError(
            f"CDN did not return a usable CORS origin for {remote_path}: "
            f"{allow_origin or 'missing header'}"
        )


def publish_scenario(
    bunny: BunnyStorage,
    run_directory: Path,
    remote_root: str,
    cycle_id: str,
    scenario: str,
    workers: int,
) -> tuple[str, dict[str, Any]]:
    public_directory = run_directory / scenario / "public"
    manifest_path = public_directory / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Missing completed render: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("status") != "complete"
        or manifest.get("cycleId") != cycle_id
        or manifest.get("scenario") != scenario
    ):
        raise RuntimeError(f"Invalid local public manifest: {manifest_path}")

    files = public_files(public_directory)
    remote_scenario_root = join_remote(remote_root, cycle_id, scenario)
    print(
        f"Uploading {scenario}: {len(files):,} PNG files "
        f"({sum(path.stat().st_size for path in files) / 1048576:.1f} MiB)."
    )

    def upload(path: Path) -> None:
        remote_path = join_remote(
            remote_scenario_root,
            path.relative_to(public_directory).as_posix(),
        )
        bunny.upload_file(remote_path, path)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(upload, path) for path in files]
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            future.result()
            if index % 100 == 0 or index == len(futures):
                print(f"  {scenario}: uploaded {index}/{len(futures)}")

    manifest_remote_path = remote_manifest_path(
        remote_root,
        cycle_id,
        scenario,
    )
    manifest_payload = (
        json.dumps(manifest, indent=2) + "\n"
    ).encode("utf-8")
    bunny.upload_bytes(
        manifest_remote_path,
        manifest_payload,
        "application/json; charset=utf-8",
    )

    verify_token = f"{cycle_id}-{scenario}-{int(time.time())}"
    downloaded_manifest, headers = bunny.fetch_cdn(
        manifest_remote_path,
        verify_token,
    )
    verify_cors(headers, manifest_remote_path)
    if sha256_bytes(downloaded_manifest) != sha256_bytes(manifest_payload):
        raise RuntimeError(f"CDN manifest verification failed for {scenario}")

    samples = [
        manifest["frames"][0]["visible"],
        manifest["frames"][0]["impact"],
        manifest["frames"][0]["query"],
        manifest["frames"][-1]["visible"],
        manifest["frames"][-1]["impact"],
        manifest["frames"][-1]["query"],
    ]
    for sample in samples:
        remote_path = join_remote(remote_scenario_root, sample["path"])
        payload, sample_headers = bunny.fetch_cdn(remote_path, verify_token)
        verify_cors(sample_headers, remote_path)
        if len(payload) != int(sample["bytes"]) or sha256_bytes(payload) != sample["sha256"]:
            raise RuntimeError(f"CDN asset verification failed: {remote_path}")

    return bunny.cdn_url(manifest_remote_path), manifest


def discard_old_cycles(
    bunny: BunnyStorage,
    remote_root: str,
    current_cycle: str,
    retain_completed_cycles: int,
) -> list[str]:
    records = bunny.list_directory(remote_root)
    cycles = sorted(
        (
            str(record.get("ObjectName") or record.get("Path") or "").strip("/")
            for record in records
            if record.get("IsDirectory")
            and CYCLE_PATTERN.fullmatch(
                str(record.get("ObjectName") or record.get("Path") or "").strip("/")
            )
        ),
        reverse=True,
    )
    previous_cycles = [cycle for cycle in cycles if cycle != current_cycle]
    retained = set(
        [
            current_cycle,
            *previous_cycles[: max(0, retain_completed_cycles - 1)],
        ]
    )
    deleted: list[str] = []
    for cycle in cycles:
        if cycle in retained:
            continue
        bunny.delete_directory(join_remote(remote_root, cycle))
        deleted.append(cycle)
    return deleted


def write_local_pointer(path: Path, pointer: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        delete=False,
    ) as stream:
        temporary = Path(stream.name)
        json.dump(pointer, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--cycle-id")
    parser.add_argument("--setup-key", action="store_true")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--storage-host", default="storage.bunnycdn.com")
    parser.add_argument("--skip-retention", action="store_true")
    args = parser.parse_args()

    config = json.loads(args.config.resolve().read_text(encoding="utf-8"))
    bunny_config = config["bunny"]
    guidance = json.loads(
        (ROOT / "model/state/latest_petss.json").read_text(encoding="utf-8")
    )
    cycle_id = args.cycle_id or guidance["cycleId"]
    scenarios = list(config["petss"]["scenarios"])
    run_directory = ROOT / "model/runs" / cycle_id
    validation_path = ROOT / "model/state" / f"validation_{cycle_id}.json"
    if not validation_path.is_file():
        raise FileNotFoundError(
            f"Refusing to publish without completed product validation: {validation_path}"
        )
    validation = json.loads(validation_path.read_text(encoding="utf-8"))
    if (
        validation.get("status") != "passed"
        or validation.get("cycleId") != cycle_id
        or [item.get("scenario") for item in validation.get("scenarios", [])]
        != scenarios
    ):
        raise RuntimeError(f"Invalid product validation report: {validation_path}")
    access_key = get_access_key(bunny_config["storageZone"], args.setup_key)
    bunny = BunnyStorage(
        zone=bunny_config["storageZone"],
        access_key=access_key,
        storage_host=args.storage_host,
        cdn_base_url=bunny_config["cdnBaseUrl"],
    )

    manifest_urls: dict[str, str] = {}
    manifests: dict[str, dict[str, Any]] = {}
    for scenario in scenarios:
        manifest_url, manifest = publish_scenario(
            bunny,
            run_directory,
            bunny_config["remoteRoot"],
            cycle_id,
            scenario,
            max(1, args.workers),
        )
        manifest_urls[scenario] = manifest_url
        manifests[scenario] = manifest

    frame_counts = {manifest["frameCount"] for manifest in manifests.values()}
    bounds = {json.dumps(manifest["boundsWgs84"]) for manifest in manifests.values()}
    if len(frame_counts) != 1 or len(bounds) != 1:
        raise RuntimeError("Scenario products do not share frame counts and bounds")

    pointer = {
        "schema": "north-wildwood-physics-pointer-v1",
        "status": "complete",
        "town": config["town"],
        "modelId": config["modelId"],
        "cycleId": cycle_id,
        "publishedUtc": utc_now(),
        "forecastStartUtc": manifests[scenarios[0]]["forecastStartUtc"],
        "forecastEndUtc": manifests[scenarios[0]]["forecastEndUtc"],
        "scenarios": scenarios,
        "manifestUrls": manifest_urls,
    }
    pointer_payload = (json.dumps(pointer, indent=2) + "\n").encode("utf-8")
    pointer_remote_path = join_remote(
        bunny_config["remoteRoot"],
        bunny_config["currentPointerName"],
    )

    # The stable pointer is deliberately the final write: users either see the
    # old fully verified cycle or the new fully verified cycle, never a partial.
    bunny.upload_bytes(
        pointer_remote_path,
        pointer_payload,
        "application/json; charset=utf-8",
    )
    verify_token = f"{cycle_id}-pointer-{int(time.time())}"
    downloaded_pointer, headers = bunny.fetch_cdn(
        pointer_remote_path,
        verify_token,
    )
    verify_cors(headers, pointer_remote_path)
    if sha256_bytes(downloaded_pointer) != sha256_bytes(pointer_payload):
        raise RuntimeError("CDN current-pointer verification failed")
    remote_pointer = json.loads(downloaded_pointer.decode("utf-8"))
    if remote_pointer.get("cycleId") != cycle_id:
        raise RuntimeError("CDN current pointer names the wrong cycle")

    local_pointer_path = (
        ROOT / "model/state" / f"published_{cycle_id}_pointer.json"
    )
    write_local_pointer(local_pointer_path, pointer)

    deleted: list[str] = []
    if not args.skip_retention:
        deleted = discard_old_cycles(
            bunny,
            bunny_config["remoteRoot"],
            cycle_id,
            int(bunny_config["retainCompletedCycles"]),
        )

    print(f"Published and verified {cycle_id}.")
    print(f"Live pointer: {bunny.cdn_url(pointer_remote_path)}")
    if deleted:
        print(f"Discarded old cycles: {', '.join(deleted)}")


if __name__ == "__main__":
    main()
