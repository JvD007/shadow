"""Fetch S3 objects and return them as base64 JSON via a GridWeave worker.

Reads JSON from stdin:
  - Single mode: {"key": "path/to/object", "width": 240}
  - Batch mode:  {"keys": ["path1", "path2"], "width": 240}
"""

from __future__ import annotations

import json
import os
import re
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
        "platform_url": os.environ.get("GRIDWEAVE_PLATFORM_URL", "https://platform.gridweave.ai"),
        "endpoint": os.environ.get("GARAGE_ENDPOINT_URL", ""),
        "bucket": os.environ.get("GARAGE_BUCKET", ""),
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
        _err("missing_env", "Missing env vars: " + ", ".join(missing))
    return cfg


def _friendly_remote_error(exc: Exception) -> tuple[str, str] | None:
    msg = str(exc)
    if "No GPU capacity" in msg:
        m = re.search(r"vendor=([A-Za-z0-9_-]+)", msg, re.I)
        return ("vendor_unavailable", f"Vendor {m.group(1) if m else 'unknown'} is not available right now.")
    return None


MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "png": "image/png", "gif": "image/gif",
    "webp": "image/webp", "bmp": "image/bmp",
}


def main() -> None:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except Exception as exc:
        _err("bad_request", f"Invalid JSON: {exc!r}")
        return

    try:
        width = int(request.get("width") or 0)
    except (TypeError, ValueError):
        width = 0

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
        auth_fn(cfg["token"], platform_url=cfg["platform_url"])
    except Exception as exc:
        _err("auth_failed", f"gridweave authentication failed: {exc!r}")
        return

    # ── Batch mode: {"keys": [...], "width": N} ────────────────────────────
    if "keys" in request:
        keys = [str(k).strip() for k in (request.get("keys") or []) if k]
        if not keys:
            _emit({"ok": True, "results": []})
            return

        _keys = keys
        _width = width

        def _fetch_batch() -> dict[str, Any]:
            import base64 as _b64
            import io

            import boto3  # type: ignore
            from botocore.config import Config as _Cfg  # type: ignore

            _mime_map = {
                "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "png": "image/png", "gif": "image/gif",
                "webp": "image/webp", "bmp": "image/bmp",
            }

            s3 = boto3.client(
                "s3",
                endpoint_url=cfg["endpoint"],
                aws_access_key_id=cfg["access_key"],
                aws_secret_access_key=cfg["secret_key"],
                region_name=cfg["region"],
                config=_Cfg(connect_timeout=10, read_timeout=60, retries={"max_attempts": 1}),
            )

            results: list[dict] = []
            for key in _keys:
                try:
                    data = s3.get_object(Bucket=cfg["bucket"], Key=key)["Body"].read()
                    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
                    mime = _mime_map.get(ext, "application/octet-stream")
                    if _width > 0:
                        try:
                            from PIL import Image as _Img  # type: ignore
                            img = _Img.open(io.BytesIO(data))
                            img.thumbnail((_width, _width), _Img.LANCZOS)
                            out = io.BytesIO()
                            img.save(out, format="JPEG", quality=75, optimize=True)
                            data = out.getvalue()
                            mime = "image/jpeg"
                        except Exception:
                            pass
                    results.append({
                        "ok": True,
                        "key": key,
                        "mime": mime,
                        "base64": _b64.b64encode(data).decode("ascii"),
                    })
                except Exception as exc:
                    results.append({"ok": False, "key": key, "error": str(exc)})

            return {"ok": True, "results": results}

        try:
            remote_fn = gridweave.remote(vram=cfg["job_vram"], vendor=cfg["job_vendor"])(_fetch_batch)
            if hasattr(gridweave, "run"):
                result = gridweave.run(remote_fn)
            elif hasattr(remote_fn, "remote"):
                result = remote_fn.remote()  # type: ignore
            else:
                result = remote_fn()
            if not isinstance(result, dict) and hasattr(result, "get"):
                result = result.get()
        except Exception as exc:
            friendly = _friendly_remote_error(exc)
            if friendly:
                _err(friendly[0], friendly[1])
                return
            _err("remote_failed", f"Worker image fetch failed: {exc!r}")
            return

        _emit(result)
        return

    # ── Single mode: {"key": "...", "width": N} ────────────────────────────
    key = str(request.get("key") or "").strip()
    if not key:
        _err("missing_key", "No object key provided.")
        return

    _key = key
    _width = width

    def _fetch_single() -> dict[str, Any]:
        import base64 as _b64
        import io

        import boto3  # type: ignore
        from botocore.config import Config as _Cfg  # type: ignore

        _mime_map = {
            "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png", "gif": "image/gif",
            "webp": "image/webp", "bmp": "image/bmp",
        }

        s3 = boto3.client(
            "s3",
            endpoint_url=cfg["endpoint"],
            aws_access_key_id=cfg["access_key"],
            aws_secret_access_key=cfg["secret_key"],
            region_name=cfg["region"],
            config=_Cfg(connect_timeout=10, read_timeout=60, retries={"max_attempts": 1}),
        )

        data = s3.get_object(Bucket=cfg["bucket"], Key=_key)["Body"].read()
        ext = _key.rsplit(".", 1)[-1].lower() if "." in _key else ""
        mime = _mime_map.get(ext, "application/octet-stream")

        if _width > 0:
            try:
                from PIL import Image as _Img  # type: ignore
                img = _Img.open(io.BytesIO(data))
                img.thumbnail((_width, _width), _Img.LANCZOS)
                out = io.BytesIO()
                img.save(out, format="JPEG", quality=75, optimize=True)
                data = out.getvalue()
                mime = "image/jpeg"
            except Exception:
                pass

        return {
            "ok": True,
            "key": _key,
            "mime": mime,
            "base64": _b64.b64encode(data).decode("ascii"),
        }

    try:
        remote_fn = gridweave.remote(vram=cfg["job_vram"], vendor=cfg["job_vendor"])(_fetch_single)
        if hasattr(gridweave, "run"):
            result = gridweave.run(remote_fn)
        elif hasattr(remote_fn, "remote"):
            result = remote_fn.remote()  # type: ignore
        else:
            result = remote_fn()
        if not isinstance(result, dict) and hasattr(result, "get"):
            result = result.get()
    except Exception as exc:
        friendly = _friendly_remote_error(exc)
        if friendly:
            _err(friendly[0], friendly[1])
            return
        _err("remote_failed", f"Worker image fetch failed: {exc!r}")
        return

    _emit(result)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        _err("unhandled", f"{exc!r}\n{traceback.format_exc()}")
