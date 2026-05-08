"""GridWeave + Garage S3 + GPU check.

Reads configuration from environment variables. Emits a single JSON document
on stdout with shape:

    {
      "ok": true,
      "result": {
        "output_text": "...",
        "objects_sample": [{"key", "size", "last_modified", "storage_class"}, ...],
        "image_previews": [{"key", "mime", "base64"}, ...]
      }
    }

On failure emits:

    {"ok": false, "error": {"code": "...", "message": "..."}}

Required env vars:
  GRIDWEAVE_TOKEN
  GARAGE_ACCESS_KEY
  GARAGE_SECRET_KEY

Optional env vars (with defaults applied if unset):
  GRIDWEAVE_PLATFORM_URL  default: https://platform.gridweave.ai
  GARAGE_ENDPOINT_URL     no default — required if you want a real run
  GARAGE_BUCKET           no default — required
  GARAGE_PREFIX           default: ""
  GARAGE_REGION           default: garage
"""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import traceback
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _err(code: str, message: str) -> None:
    _emit({"ok": False, "error": {"code": code, "message": message}})
    sys.exit(0)


def _read_env() -> dict[str, str]:
    cfg = {
        "token": os.environ.get("GRIDWEAVE_TOKEN", ""),
        "platform_url": os.environ.get(
            "GRIDWEAVE_PLATFORM_URL", "https://platform.gridweave.ai"
        ),
        "endpoint": os.environ.get("GARAGE_ENDPOINT_URL", ""),
        "bucket": os.environ.get("GARAGE_BUCKET", ""),
        "prefix": os.environ.get("GARAGE_PREFIX", ""),
        "access_key": os.environ.get("GARAGE_ACCESS_KEY", ""),
        "secret_key": os.environ.get("GARAGE_SECRET_KEY", ""),
        "region": os.environ.get("GARAGE_REGION", "garage"),
    }
    missing = [
        name
        for name, key in [
            ("GRIDWEAVE_TOKEN", "token"),
            ("GARAGE_ENDPOINT_URL", "endpoint"),
            ("GARAGE_BUCKET", "bucket"),
            ("GARAGE_ACCESS_KEY", "access_key"),
            ("GARAGE_SECRET_KEY", "secret_key"),
        ]
        if not cfg[key]
    ]
    if missing:
        _err(
            "missing_env",
            "Missing required environment variables: " + ", ".join(missing),
        )
    return cfg


def main() -> None:
    cfg = _read_env()

    # Import gridweave lazily so missing-SDK errors are reported as structured
    # JSON instead of crashing the worker.
    try:
        import gridweave  # type: ignore
    except Exception as exc:  # pragma: no cover - import failure path
        _err(
            "sdk_missing",
            f"gridweave SDK not available in this Python environment: {exc!r}. "
            "Install it (and ray, boto3, pandas) into the interpreter referenced "
            "by PYTHON_BIN.",
        )
        return

    try:
        gridweave.authenticate(
            token=cfg["token"], platform_url=cfg["platform_url"]
        )
    except Exception as exc:
        _err("auth_failed", f"gridweave.authenticate failed: {exc!r}")
        return

    @gridweave.remote(vram="2GB")  # type: ignore[misc]
    def multi_gpu_check() -> dict[str, Any]:  # noqa: C901
        import os as _os

        # Disable Ray progress bars for clean output.
        _os.environ["RAY_DATA_DISABLE_PROGRESS_BARS"] = "1"

        import boto3  # type: ignore
        from botocore.client import Config  # type: ignore
        import pandas as _pd  # type: ignore
        import ray  # type: ignore
        import ray.data  # type: ignore

        try:
            ray.data.DataContext.get_current().enable_progress_bars = False
        except Exception:
            pass

        log_lines: list[str] = []

        def log(msg: str) -> None:
            log_lines.append(str(msg))

        # GPU info
        try:
            smi = subprocess.run(
                ["nvidia-smi", "-L"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            log("nvidia-smi -L:")
            log(smi.stdout.strip() or "(no GPUs reported)")
            if smi.stderr:
                log("nvidia-smi stderr: " + smi.stderr.strip())
        except FileNotFoundError:
            log("nvidia-smi not found on PATH")
        except Exception as exc:
            log(f"nvidia-smi error: {exc!r}")

        log("CUDA_VISIBLE_DEVICES=" + _os.environ.get("CUDA_VISIBLE_DEVICES", ""))
        log("pandas version: " + _pd.__version__)

        # S3-compatible Garage client
        s3 = boto3.client(
            "s3",
            endpoint_url=cfg["endpoint"],
            aws_access_key_id=cfg["access_key"],
            aws_secret_access_key=cfg["secret_key"],
            region_name=cfg["region"],
            config=Config(signature_version="s3v4"),
        )

        log(f"Garage endpoint: {cfg['endpoint']}")
        log(f"Bucket: {cfg['bucket']}  Prefix: {cfg['prefix']!r}")

        # List objects under prefix (paginate)
        paginator = s3.get_paginator("list_objects_v2")
        objects: list[dict[str, Any]] = []
        for page in paginator.paginate(
            Bucket=cfg["bucket"], Prefix=cfg["prefix"]
        ):
            for entry in page.get("Contents", []) or []:
                objects.append(
                    {
                        "key": entry.get("Key", ""),
                        "size": int(entry.get("Size", 0) or 0),
                        "last_modified": (
                            entry["LastModified"].isoformat()
                            if entry.get("LastModified")
                            else None
                        ),
                        "storage_class": entry.get("StorageClass", "STANDARD"),
                    }
                )
        log(f"Total objects under prefix: {len(objects)}")

        # First 20 objects → pandas via Ray Data (small, in-memory)
        head = objects[:20]
        try:
            ds = ray.data.from_items(head)
            df = ds.to_pandas()
            objects_sample = df.to_dict(orient="records")
        except Exception as exc:
            log(f"ray.data conversion failed, falling back to plain list: {exc!r}")
            objects_sample = head

        # Image previews — first up to 6 image-like objects, base64 encoded
        IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")
        images = [o for o in objects if o["key"].lower().endswith(IMG_EXTS)]
        log(f"Image-like objects found: {len(images)}")

        previews: list[dict[str, str]] = []
        for obj in images[:6]:
            try:
                buf = io.BytesIO()
                s3.download_fileobj(cfg["bucket"], obj["key"], buf)
                data = buf.getvalue()
                ext = obj["key"].rsplit(".", 1)[-1].lower()
                mime = {
                    "jpg": "image/jpeg",
                    "jpeg": "image/jpeg",
                    "png": "image/png",
                    "gif": "image/gif",
                    "webp": "image/webp",
                    "bmp": "image/bmp",
                }.get(ext, "application/octet-stream")
                previews.append(
                    {
                        "key": obj["key"],
                        "mime": mime,
                        "base64": base64.b64encode(data).decode("ascii"),
                    }
                )
            except Exception as exc:
                log(f"Failed to download {obj['key']}: {exc!r}")

        log(f"Image previews returned: {len(previews)}")

        return {
            "output_text": "\n".join(log_lines),
            "objects_sample": objects_sample,
            "image_previews": previews,
        }

    try:
        result = multi_gpu_check.remote()  # type: ignore[attr-defined]
        # gridweave futures are typically resolved via .get() or by being
        # returned directly; support both.
        if hasattr(result, "get"):
            result = result.get()
    except Exception as exc:
        _err(
            "remote_failed",
            f"multi_gpu_check remote execution failed: {exc!r}\n"
            + traceback.format_exc(),
        )
        return

    if not isinstance(result, dict):
        _err("bad_result", f"unexpected result type: {type(result).__name__}")
        return

    _emit({"ok": True, "result": result})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - last-resort guard
        _err("unhandled", f"{exc!r}\n{traceback.format_exc()}")
