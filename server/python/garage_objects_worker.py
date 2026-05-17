"""List objects and image thumbnails under a prefix via a GridWeave worker.

The app server authenticates with GridWeave and dispatches the S3 listing
(including Pillow thumbnail generation) to a remote worker.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, default=str))
    sys.stdout.flush()


def _err(code: str, message: str) -> None:
    _emit({"ok": False, "objects": [], "image_previews": [], "error": {"code": code, "message": message}})
    sys.exit(0)


def _read_env() -> dict[str, str]:
    cfg = {
        "token": os.environ.get("GRIDWEAVE_TOKEN", ""),
        "platform_url": os.environ.get("GRIDWEAVE_PLATFORM_URL", "https://platform.gridweave.ai"),
        "endpoint": os.environ.get("GARAGE_ENDPOINT_URL", ""),
        "bucket": os.environ.get("GARAGE_BUCKET", ""),
        "prefix": os.environ.get("GARAGE_PREFIX", ""),
        "access_key": os.environ.get("GARAGE_ACCESS_KEY", ""),
        "secret_key": os.environ.get("GARAGE_SECRET_KEY", ""),
        "region": os.environ.get("GARAGE_REGION", "garage"),
        "job_vendor": os.environ.get("GRIDWEAVE_JOB_VENDOR", "NVIDIA"),
        "job_vram": os.environ.get("GRIDWEAVE_JOB_VRAM", "2GB"),
    }
    missing = [name for name, key in [
        ("GRIDWEAVE_TOKEN", "token"),
        ("GARAGE_ENDPOINT_URL", "endpoint"),
        ("GARAGE_BUCKET", "bucket"),
        ("GARAGE_ACCESS_KEY", "access_key"),
        ("GARAGE_SECRET_KEY", "secret_key"),
    ] if not cfg[key]]
    if missing:
        _err("missing_env", "Missing required environment variables: " + ", ".join(missing))
    return cfg


def _friendly_remote_error(exc: Exception) -> tuple[str, str] | None:
    msg = str(exc)
    capacity = re.search(
        r"No GPU capacity for\s+([\d.]+)GB VRAM matching vendor=([A-Za-z0-9_-]+).*?"
        r"Largest single GPU free:\s+([\d.]+)GB, total cluster free:\s+([\d.]+)GB",
        msg, re.I,
    )
    if capacity:
        vendor = capacity.group(2)
        largest_gb = float(capacity.group(3))
        total_gb = float(capacity.group(4))
        requested_gb = float(capacity.group(1))
        if requested_gb <= total_gb:
            return ("vendor_unavailable", f"Vendor {vendor} is not available right now. Select another accelerator vendor.")
        return ("vram_unavailable", f"Requested VRAM is not available for vendor {vendor}. Largest single GPU free: {largest_gb:g}GB, cluster free: {total_gb:g}GB.")
    if "No GPU capacity" in msg:
        m = re.search(r"vendor=([A-Za-z0-9_-]+)", msg, re.I)
        return ("vendor_unavailable", f"Vendor {m.group(1) if m else 'unknown'} is not available right now.")
    return None


def main() -> None:
    t_start = time.perf_counter()
    cfg = _read_env()

    try:
        import gridweave  # type: ignore
    except Exception as exc:
        _err("sdk_missing", f"gridweave SDK not available: {exc!r}")
        return

    try:
        auth_fn = getattr(gridweave, "auth", None) or getattr(gridweave, "authenticate", None)
        if auth_fn is None:
            _err("auth_failed", "gridweave SDK has neither auth() nor authenticate().")
            return
        t_auth = time.perf_counter()
        auth_fn(cfg["token"], platform_url=cfg["platform_url"])
        auth_ms = round((time.perf_counter() - t_auth) * 1000)
    except Exception as exc:
        _err("auth_failed", f"gridweave authentication failed: {exc!r}")
        return

    def _list_objects() -> dict[str, Any]:
        import os as _os
        import time as _t

        import boto3  # type: ignore
        from botocore.config import Config as _Cfg  # type: ignore

        _image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"}
        _max_objects = 200
        _max_images = 30

        s3 = boto3.client(
            "s3",
            endpoint_url=cfg["endpoint"],
            aws_access_key_id=cfg["access_key"],
            aws_secret_access_key=cfg["secret_key"],
            region_name=cfg["region"],
            config=_Cfg(connect_timeout=10, read_timeout=30, retries={"max_attempts": 1}),
        )

        prefix = cfg["prefix"]
        objects: list[dict] = []
        image_keys: list[str] = []

        paginator = s3.get_paginator("list_objects_v2")
        page_kwargs: dict = {"Bucket": cfg["bucket"], "Delimiter": "/"}
        if prefix:
            page_kwargs["Prefix"] = prefix

        t_s3 = _t.perf_counter()
        for page in paginator.paginate(**page_kwargs):
            for obj in page.get("Contents") or []:
                key = obj.get("Key", "")
                if key.endswith("/"):
                    continue
                lm = obj.get("LastModified")
                objects.append({
                    "key": key,
                    "size": obj.get("Size", 0),
                    "last_modified": lm.isoformat() if lm else None,
                    "storage_class": obj.get("StorageClass", "STANDARD"),
                })
                if _os.path.splitext(key)[-1].lower() in _image_exts:
                    image_keys.append(key)
                if len(objects) >= _max_objects:
                    break
            if len(objects) >= _max_objects:
                break
        s3_ms = round((_t.perf_counter() - t_s3) * 1000)

        # Return image keys without base64 — thumbnails are fetched separately
        # by the UI via /api/garage-images to keep listing fast.
        image_previews = [{"key": k, "mime": "image/jpeg"} for k in image_keys[:_max_images]]

        return {
            "ok": True,
            "bucket": cfg["bucket"],
            "prefix": prefix,
            "objects": objects,
            "image_previews": image_previews,
            "_s3_ms": s3_ms,
        }

    try:
        remote_fn = gridweave.remote(vram=cfg["job_vram"], vendor=cfg["job_vendor"])(_list_objects)
        t_job = time.perf_counter()
        if hasattr(gridweave, "run"):
            result = gridweave.run(remote_fn)
        elif hasattr(remote_fn, "remote"):
            result = remote_fn.remote()  # type: ignore
        else:
            result = remote_fn()
        if not isinstance(result, dict) and hasattr(result, "get"):
            result = result.get()
        job_ms = round((time.perf_counter() - t_job) * 1000)
    except Exception as exc:
        friendly = _friendly_remote_error(exc)
        if friendly:
            _err(friendly[0], friendly[1])
            return
        _err("remote_failed", f"Worker object listing failed: {exc!r}")
        return

    s3_ms = result.pop("_s3_ms", None)
    total_ms = round((time.perf_counter() - t_start) * 1000)
    result["timings"] = {
        "auth_ms": auth_ms,
        "job_ms": job_ms,
        "s3_ms": s3_ms,
        "total_ms": total_ms,
    }
    _emit(result)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        _err("unhandled", f"{exc!r}\n{traceback.format_exc()}")
