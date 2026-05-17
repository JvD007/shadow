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
  GRIDWEAVE_JOB_VENDOR    default: NVIDIA
  GRIDWEAVE_JOB_VRAM      default: 2GB
"""

from __future__ import annotations

import base64
import json
import os
import re
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


def _parse_vram_gb(vram: str) -> float:
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(GB|MB)\s*$", vram, re.I)
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = match.group(2).upper()
    return value / 1024 if unit == "MB" else value


def _friendly_remote_error(exc: Exception, cfg: dict[str, str]) -> tuple[str, str] | None:
    msg = str(exc)
    capacity = re.search(
        r"No GPU capacity for\s+([\d.]+)GB VRAM matching vendor=([A-Za-z0-9_-]+).*?"
        r"Largest single GPU free:\s+([\d.]+)GB, total cluster free:\s+([\d.]+)GB",
        msg,
        re.I,
    )
    if capacity:
        requested_gb = float(capacity.group(1))
        vendor = capacity.group(2)
        largest_single_gb = float(capacity.group(3))
        total_free_gb = float(capacity.group(4))
        configured_gb = _parse_vram_gb(cfg.get("job_vram", ""))
        effective_request_gb = configured_gb or requested_gb

        if effective_request_gb <= total_free_gb:
            return (
                "vendor_unavailable",
                f"Vendor {vendor} is not available on the cluster right now. "
                "Select another accelerator vendor and run the check again.",
            )

        return (
            "vram_unavailable",
            f"Requested VRAM {cfg.get('job_vram', f'{requested_gb:g}GB')} is not available for vendor {vendor}. "
            f"Largest single GPU currently free is {largest_single_gb:g}GB "
            f"and total cluster free memory is {total_free_gb:g}GB.",
        )

    if "No GPU capacity" in msg:
        vendor_match = re.search(r"vendor=([A-Za-z0-9_-]+)", msg, re.I)
        if vendor_match:
            vendor = vendor_match.group(1)
            return (
                "vendor_unavailable",
                f"Vendor {vendor} is not available on the cluster right now. "
                "Select another accelerator vendor and run the check again.",
            )
        return (
            "gpu_capacity_unavailable",
            "No matching accelerator capacity is available for the selected vendor and VRAM request. "
            "Try a different vendor or a smaller VRAM value.",
        )

    return None


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
        "job_vendor": os.environ.get("GRIDWEAVE_JOB_VENDOR", "NVIDIA"),
        "job_vram": os.environ.get("GRIDWEAVE_JOB_VRAM", "2GB"),
        "image_preview_limit": os.environ.get("GARAGE_IMAGE_PREVIEW_LIMIT", "20"),
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
            "Install it (and ray, s3fs, pandas) into the interpreter referenced "
            "by PYTHON_BIN.",
        )
        return

    try:
        auth_fn = getattr(gridweave, "auth", None) or getattr(
            gridweave, "authenticate", None
        )
        if auth_fn is None:
            _err(
                "auth_failed",
                "gridweave SDK has neither auth() nor authenticate(); "
                f"available attributes include: {', '.join(sorted(dir(gridweave))[:40])}",
            )
            return
        auth_fn(cfg["token"], platform_url=cfg["platform_url"])
    except Exception as exc:
        _err("auth_failed", f"gridweave authentication failed: {exc!r}")
        return

    remote_kwargs = {"vram": cfg["job_vram"], "vendor": cfg["job_vendor"]}

    def _multi_gpu_check() -> dict[str, Any]:  # noqa: C901
        import os as _os

        # Disable Ray progress bars for clean output.
        _os.environ["RAY_DATA_DISABLE_PROGRESS_BARS"] = "1"

        import s3fs  # type: ignore
        import pandas as _pd  # type: ignore
        log_lines: list[str] = []

        def log(msg: str) -> None:
            log_lines.append(str(msg))

        def read_first(path: str) -> str:
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    return f.read().strip()
            except Exception:
                return ""

        def get_server_info() -> dict[str, Any]:
            vendor = read_first("/sys/class/dmi/id/sys_vendor")
            product = read_first("/sys/class/dmi/id/product_name")
            version = read_first("/sys/class/dmi/id/product_version")
            model_parts = [p for p in [vendor, product, version] if p and p.lower() not in {"none", "not specified"}]
            model = " ".join(model_parts) if model_parts else _os.uname().nodename

            mem_gb = 0.0
            try:
                with open("/proc/meminfo", "r", encoding="utf-8") as f:
                    for line in f:
                        if line.startswith("MemTotal:"):
                            kb = int(line.split()[1])
                            mem_gb = round(kb / 1024 / 1024, 1)
                            break
            except Exception:
                pass

            return {
                "model": model,
                "cpu_cores": int(_os.cpu_count() or 0),
                "memory_gb": mem_gb,
            }

        server_info = get_server_info()
        log(f"GridWeave vendor: {cfg['job_vendor']}")
        log(f"GridWeave VRAM request: {cfg['job_vram']}")
        log(f"Server model: {server_info['model']}")
        log(f"CPU cores: {server_info['cpu_cores']}")
        log(f"Total memory GB: {server_info['memory_gb']}")

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

        log("pandas version: " + _pd.__version__)

        # S3-compatible Garage client — explicit timeouts so a stalled
        # connection fails fast instead of hanging the whole request.
        # config_kwargs is merged by s3fs into its internal AioConfig;
        # do NOT put "config" inside client_kwargs or aiobotocore raises
        # "got multiple values for keyword argument 'config'".
        fs = s3fs.S3FileSystem(
            key=cfg["access_key"],
            secret=cfg["secret_key"],
            client_kwargs={
                "endpoint_url": cfg["endpoint"],
                "region_name": cfg["region"],
            },
            config_kwargs={
                "connect_timeout": 10,
                "read_timeout": 60,
                "retries": {"max_attempts": 1},
            },
        )

        log(f"Garage endpoint: {cfg['endpoint']}")
        log(f"Bucket: {cfg['bucket']}  Prefix: {cfg['prefix']!r}")

        # List all objects under prefix recursively
        bucket_path = cfg["bucket"]
        if cfg["prefix"]:
            bucket_path += "/" + cfg["prefix"].rstrip("/")
        raw = fs.find(bucket_path, detail=True)
        entries: dict[str, Any] = raw if isinstance(raw, dict) else {e["name"]: e for e in raw}

        objects: list[dict[str, Any]] = []
        for full_path, info in entries.items():
            if info.get("type") == "directory":
                continue
            key = full_path[len(cfg["bucket"]) + 1:]
            last_mod = info.get("LastModified")
            objects.append(
                {
                    "key": key,
                    "size": int(info.get("size", 0) or 0),
                    "last_modified": (
                        last_mod.isoformat()
                        if hasattr(last_mod, "isoformat")
                        else (str(last_mod) if last_mod else None)
                    ),
                    "storage_class": info.get("StorageClass", "STANDARD"),
                }
            )
        log(f"Total objects under prefix: {len(objects)}")

        # First 20 objects are already normalized dictionaries. Keep this as a
        # plain list to avoid Ray Data logger/progress output leaking into the
        # JSON envelope that the Node API parses.
        objects_sample = objects[:20]

        # Image previews — all image-like objects by default, base64 encoded.
        # Set GARAGE_IMAGE_PREVIEW_LIMIT to a positive integer to cap the list.
        IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")
        images = [o for o in objects if o["key"].lower().endswith(IMG_EXTS)]
        log(f"Image-like objects found: {len(images)}")
        try:
            preview_limit = int(cfg.get("image_preview_limit", "0") or "0")
        except ValueError:
            preview_limit = 0
        preview_images = images[:preview_limit] if preview_limit > 0 else images

        # Return only keys — the UI fetches images on demand via /api/garage-image
        # so the worker never downloads image bytes.
        _MIME = {
            "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "bmp": "image/bmp",
        }
        previews: list[dict[str, str]] = []
        for obj in preview_images:
            ext = obj["key"].rsplit(".", 1)[-1].lower() if "." in obj["key"] else ""
            previews.append({"key": obj["key"], "mime": _MIME.get(ext, "image/jpeg")})

        log(f"Image previews returned: {len(previews)}")
        if preview_limit > 0 and len(images) > preview_limit:
            log(f"Image preview limit applied: {preview_limit}")

        return {
            "output_text": "\n".join(log_lines),
            "objects_sample": objects_sample,
            "image_previews": previews,
            "server_info": server_info,
            "job_config": {
                "vendor": cfg["job_vendor"],
                "vram": cfg["job_vram"],
                "prefix": cfg["prefix"],
            },
        }

    try:
        multi_gpu_check = gridweave.remote(**remote_kwargs)(_multi_gpu_check)  # type: ignore[misc]

        if hasattr(gridweave, "run"):
            result = gridweave.run(multi_gpu_check)
        elif hasattr(multi_gpu_check, "remote"):
            result = multi_gpu_check.remote()  # type: ignore[attr-defined]
        else:
            result = multi_gpu_check()

        # Some runtimes return futures; support those as well. Do not call
        # dict.get() here; gridweave.run() may already return the final dict.
        if not isinstance(result, dict) and hasattr(result, "get"):
            result = result.get()
    except Exception as exc:
        friendly = _friendly_remote_error(exc, cfg)
        if friendly:
            _err(*friendly)
            return
        _err(
            "remote_failed",
            f"multi_gpu_check execution failed: {exc!r}",
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
