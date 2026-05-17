"""List folder-like prefixes from Garage/S3 directly with boto3.

Runs locally on the Node server — no GridWeave worker involved.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def err(code: str, message: str, bucket: str = "") -> None:
    emit({"ok": False, "prefixes": [], "bucket": bucket, "error": {"code": code, "message": message}})
    sys.exit(0)


def main() -> None:
    endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "")
    bucket = os.environ.get("GARAGE_BUCKET", "")
    access_key = os.environ.get("GARAGE_ACCESS_KEY", "")
    secret_key = os.environ.get("GARAGE_SECRET_KEY", "")
    region = os.environ.get("GARAGE_REGION", "garage")
    configured_prefix = os.environ.get("GARAGE_PREFIX", "")

    missing = [n for n, v in [
        ("GARAGE_ENDPOINT_URL", endpoint), ("GARAGE_BUCKET", bucket),
        ("GARAGE_ACCESS_KEY", access_key), ("GARAGE_SECRET_KEY", secret_key),
    ] if not v]
    if missing:
        err("missing_env", "Missing env vars: " + ", ".join(missing), bucket)

    try:
        import boto3
        from botocore.config import Config as _Cfg
    except ImportError as exc:
        err("sdk_missing", f"boto3 not installed: {exc!r}", bucket)
        return

    try:
        s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=_Cfg(connect_timeout=10, read_timeout=30, retries={"max_attempts": 1}),
        )

        prefixes: set[str] = {""}
        if configured_prefix:
            prefixes.add(configured_prefix)

        paginator = s3.get_paginator("list_objects_v2")
        kwargs: dict = {"Bucket": bucket, "Delimiter": "/"}
        if configured_prefix:
            kwargs["Prefix"] = configured_prefix

        for page in paginator.paginate(**kwargs):
            for cp in page.get("CommonPrefixes") or []:
                if cp.get("Prefix"):
                    prefixes.add(cp["Prefix"])

        emit({
            "ok": True,
            "bucket": bucket,
            "listing_prefix": configured_prefix,
            "prefixes": sorted(prefixes, key=lambda p: ("" if p == "" else p.lower(), p == "")),
        })
    except Exception as exc:
        err("s3_list_failed", f"Could not list prefixes for bucket {bucket}: {exc!r}", bucket)


if __name__ == "__main__":
    main()
