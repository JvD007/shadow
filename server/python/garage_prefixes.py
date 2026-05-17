"""List folder-like prefixes from Garage/S3 through a GridWeave worker.

The local app process does not query S3. It only authenticates to GridWeave,
submits this remote task, and prints the worker result as JSON.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def err(code: str, message: str, bucket: str = "") -> None:
    emit(
        {
            "ok": False,
            "prefixes": [],
            "bucket": bucket,
            "error": {"code": code, "message": message},
        }
    )
    sys.exit(0)


def parse_vram_gb(vram: str) -> float:
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(GB|MB)\s*$", vram, re.I)
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = match.group(2).upper()
    return value / 1024 if unit == "MB" else value


def friendly_remote_error(exc: Exception, vendor: str, vram: str) -> tuple[str, str] | None:
    msg = str(exc)
    capacity = re.search(
        r"No GPU capacity for\s+([\d.]+)GB VRAM matching vendor=([A-Za-z0-9_-]+).*?"
        r"Largest single GPU free:\s+([\d.]+)GB, total cluster free:\s+([\d.]+)GB",
        msg,
        re.I,
    )
    if capacity:
        requested_gb = float(capacity.group(1))
        error_vendor = capacity.group(2)
        largest_single_gb = float(capacity.group(3))
        total_free_gb = float(capacity.group(4))
        configured_gb = parse_vram_gb(vram)
        effective_request_gb = configured_gb or requested_gb

        if effective_request_gb <= total_free_gb:
            return (
                "vendor_unavailable",
                f"Vendor {error_vendor} is not available on the cluster right now. "
                "Select another accelerator vendor and try loading folders again.",
            )

        return (
            "vram_unavailable",
            f"Requested VRAM {vram} is not available for vendor {error_vendor}. "
            f"Largest single GPU currently free is {largest_single_gb:g}GB "
            f"and total cluster free memory is {total_free_gb:g}GB.",
        )

    if "No GPU capacity" in msg:
        vendor_match = re.search(r"vendor=([A-Za-z0-9_-]+)", msg, re.I)
        error_vendor = vendor_match.group(1) if vendor_match else vendor
        return (
            "vendor_unavailable",
            f"Vendor {error_vendor} is not available on the cluster right now. "
            "Select another accelerator vendor and try loading folders again.",
        )

    return None


def main() -> None:
    token = os.environ.get("GRIDWEAVE_TOKEN", "")
    platform_url = os.environ.get("GRIDWEAVE_PLATFORM_URL", "https://platform.gridweave.ai")
    endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "")
    bucket = os.environ.get("GARAGE_BUCKET", "")
    access_key = os.environ.get("GARAGE_ACCESS_KEY", "")
    secret_key = os.environ.get("GARAGE_SECRET_KEY", "")
    region = os.environ.get("GARAGE_REGION", "garage")
    configured_prefix = os.environ.get("GARAGE_PREFIX", "")
    vendor = os.environ.get("GRIDWEAVE_JOB_VENDOR", "NVIDIA")
    vram = os.environ.get("GRIDWEAVE_JOB_VRAM", "2GB")

    missing = [
        name
        for name, value in [
            ("GRIDWEAVE_TOKEN", token),
            ("GARAGE_ENDPOINT_URL", endpoint),
            ("GARAGE_BUCKET", bucket),
            ("GARAGE_ACCESS_KEY", access_key),
            ("GARAGE_SECRET_KEY", secret_key),
        ]
        if not value
    ]
    if missing:
        err("missing_env", "Missing required environment variables: " + ", ".join(missing), bucket)

    try:
        import gridweave  # type: ignore
    except Exception as exc:
        err(
            "sdk_missing",
            f"gridweave SDK not available in this Python environment: {exc!r}",
            bucket,
        )

    try:
        auth_fn = getattr(gridweave, "auth", None) or getattr(gridweave, "authenticate", None)
        if auth_fn is None:
            err("auth_failed", "gridweave SDK has neither auth() nor authenticate()", bucket)
        auth_fn(token, platform_url=platform_url)
    except Exception as exc:
        err("auth_failed", f"gridweave authentication failed: {exc!r}", bucket)

    def list_prefixes_remote() -> dict[str, Any]:
        try:
            import s3fs  # type: ignore
        except Exception as exc:
            return {
                "ok": False,
                "prefixes": [],
                "bucket": bucket,
                "error": {
                    "code": "sdk_missing",
                    "message": f"s3fs not available on the worker: {exc!r}",
                },
            }

        try:
            fs = s3fs.S3FileSystem(
                key=access_key,
                secret=secret_key,
                client_kwargs={
                    "endpoint_url": endpoint,
                    "region_name": region,
                },
                config_kwargs={
                    "connect_timeout": 10,
                    "read_timeout": 30,
                    "retries": {"max_attempts": 1},
                },
            )

            prefixes: set[str] = set()
            items = fs.ls(bucket, detail=True)
            for item in items:
                if item.get("type") == "directory":
                    prefix_name = item["name"][len(bucket) + 1:]
                    if prefix_name and not prefix_name.endswith("/"):
                        prefix_name += "/"
                    prefixes.add(prefix_name)
                else:
                    prefixes.add("")

            if configured_prefix:
                prefixes.add(configured_prefix)

            return {
                "ok": True,
                "bucket": bucket,
                "prefixes": sorted(prefixes, key=lambda p: (p == "", p.lower())),
                "worker": True,
                "job_config": {"vendor": vendor, "vram": vram},
            }
        except Exception as exc:
            return {
                "ok": False,
                "prefixes": [],
                "bucket": bucket,
                "error": {
                    "code": "s3_list_failed",
                    "message": f"Worker could not list prefixes for bucket {bucket}: {exc!r}",
                },
            }

    try:
        remote_fn = gridweave.remote(vram=vram, vendor=vendor)(list_prefixes_remote)
        result = gridweave.run(remote_fn) if hasattr(gridweave, "run") else remote_fn()
        if not isinstance(result, dict) and hasattr(result, "get"):
            result = result.get()
    except Exception as exc:
        friendly = friendly_remote_error(exc, vendor, vram)
        if friendly:
            code, message = friendly
            err(code, message, bucket)
        err("remote_failed", f"Prefix discovery worker failed: {exc!r}", bucket)

    if not isinstance(result, dict):
        err("bad_result", f"Unexpected prefix result type: {type(result).__name__}", bucket)

    emit(result)


if __name__ == "__main__":
    main()
