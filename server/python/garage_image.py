"""Fetch a single S3 object and return it as base64 JSON.

Reads {"key": "path/to/object", "width": 240} from stdin.
  - key   (required) S3 key relative to the bucket
  - width (optional) if > 0 and Pillow is available, resize to a thumbnail

Runs locally on the Node server — no GridWeave worker involved.
Tries boto3 first (standard AWS SDK), falls back to s3fs.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _err(code: str, message: str) -> None:
    _emit({"ok": False, "error": {"code": code, "message": message}})
    sys.exit(0)


MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
}


def _fetch_bytes(bucket: str, key: str, endpoint: str, access_key: str, secret_key: str, region: str) -> bytes:
    # Try boto3 first — standard AWS SDK, more likely installed locally.
    try:
        import boto3  # type: ignore
        from botocore.config import Config as _Cfg  # type: ignore
        s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=_Cfg(connect_timeout=10, read_timeout=60, retries={"max_attempts": 1}),
        )
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except ImportError:
        pass

    # Fall back to s3fs (installed on the GridWeave worker environment).
    try:
        import s3fs  # type: ignore
        fs = s3fs.S3FileSystem(
            key=access_key,
            secret=secret_key,
            client_kwargs={"endpoint_url": endpoint, "region_name": region},
            config_kwargs={"connect_timeout": 10, "read_timeout": 60, "retries": {"max_attempts": 1}},
        )
        with fs.open(f"{bucket}/{key}", "rb") as f:
            return f.read()
    except ImportError:
        pass

    raise ImportError(
        "Neither boto3 nor s3fs is installed in the local Python environment. "
        "Run: pip install boto3"
    )


def _maybe_thumbnail(data: bytes, width: int) -> tuple[bytes, str]:
    """Resize image bytes to thumbnail. Returns (bytes, mime). Falls back to original on error."""
    try:
        import io as _io
        from PIL import Image as _Pil  # type: ignore
        img = _Pil.open(_io.BytesIO(data))
        img.thumbnail((width, width), _Pil.LANCZOS)
        out = _io.BytesIO()
        img.save(out, format="JPEG", quality=75, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception:
        return data, None  # type: ignore


def _fetch_one(
    key: str, width: int,
    bucket: str, endpoint: str, access_key: str, secret_key: str, region: str,
) -> dict:
    try:
        data = _fetch_bytes(bucket, key, endpoint, access_key, secret_key, region)
        ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
        mime = MIME.get(ext, "application/octet-stream")
        if width > 0:
            data, new_mime = _maybe_thumbnail(data, width)
            if new_mime:
                mime = new_mime
        return {"ok": True, "key": key, "mime": mime, "base64": base64.b64encode(data).decode("ascii")}
    except Exception as exc:
        return {"ok": False, "key": key, "error": str(exc)}


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

    # ── Batch mode: {"keys": [...], "width": N} ────────────────────────────
    if "keys" in request:
        keys = [str(k).strip() for k in (request.get("keys") or []) if k]
        if not keys:
            _emit({"ok": True, "results": []})
            return

        endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "")
        bucket = os.environ.get("GARAGE_BUCKET", "")
        access_key = os.environ.get("GARAGE_ACCESS_KEY", "")
        secret_key = os.environ.get("GARAGE_SECRET_KEY", "")
        region = os.environ.get("GARAGE_REGION", "garage")

        missing = [n for n, v in [("GARAGE_ENDPOINT_URL", endpoint), ("GARAGE_BUCKET", bucket),
                                   ("GARAGE_ACCESS_KEY", access_key), ("GARAGE_SECRET_KEY", secret_key)] if not v]
        if missing:
            _err("missing_env", "Missing env vars: " + ", ".join(missing))
            return

        try:
            _fetch_bytes("_probe", "_probe", endpoint, access_key, secret_key, region)
        except ImportError as exc:
            _err("sdk_missing", str(exc))
            return
        except Exception:
            pass  # expected — just verifying the SDK is importable

        from concurrent.futures import ThreadPoolExecutor, as_completed
        results: list[dict] = []
        with ThreadPoolExecutor(max_workers=min(len(keys), 10)) as pool:
            futures = {pool.submit(_fetch_one, k, width, bucket, endpoint, access_key, secret_key, region): k for k in keys}
            for fut in as_completed(futures):
                results.append(fut.result())

        _emit({"ok": True, "results": results})
        return

    # ── Single mode: {"key": "...", "width": N} ───────────────────────────
    key = str(request.get("key") or "").strip()
    if not key:
        _err("missing_key", "No object key provided.")
        return

    endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "")
    bucket = os.environ.get("GARAGE_BUCKET", "")
    access_key = os.environ.get("GARAGE_ACCESS_KEY", "")
    secret_key = os.environ.get("GARAGE_SECRET_KEY", "")
    region = os.environ.get("GARAGE_REGION", "garage")

    missing = [
        name
        for name, val in [
            ("GARAGE_ENDPOINT_URL", endpoint),
            ("GARAGE_BUCKET", bucket),
            ("GARAGE_ACCESS_KEY", access_key),
            ("GARAGE_SECRET_KEY", secret_key),
        ]
        if not val
    ]
    if missing:
        _err("missing_env", "Missing env vars: " + ", ".join(missing))
        return

    result = _fetch_one(key, width, bucket, endpoint, access_key, secret_key, region)
    if not result["ok"]:
        err_msg = result.get("error", "unknown error")
        if "boto3" in err_msg and "s3fs" in err_msg:
            _err("sdk_missing", err_msg)
        else:
            _err("s3_fetch_failed", err_msg)
        return
    _emit({"ok": True, "key": result["key"], "mime": result["mime"], "base64": result["base64"]})


if __name__ == "__main__":
    main()
