"""List objects and image thumbnails under a prefix, directly with boto3."""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"}
MAX_OBJECTS = 200
MAX_IMAGES = 30
THUMB_WIDTH = 240


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, default=str))
    sys.stdout.flush()


def err(code: str, message: str) -> None:
    emit({"ok": False, "objects": [], "image_previews": [], "error": {"code": code, "message": message}})
    sys.exit(0)


def is_image(key: str) -> bool:
    return os.path.splitext(key)[-1].lower() in IMAGE_EXTENSIONS


def fetch_thumbnail(s3: Any, bucket: str, key: str) -> tuple[str, str] | None:
    try:
        from PIL import Image
        import io
        obj = s3.get_object(Bucket=bucket, Key=key)
        data = obj["Body"].read()
        img = Image.open(io.BytesIO(data))
        img.thumbnail((THUMB_WIDTH, THUMB_WIDTH))
        buf = io.BytesIO()
        fmt = "PNG" if img.mode in ("RGBA", "P") else "JPEG"
        img.save(buf, format=fmt)
        mime = "image/png" if fmt == "PNG" else "image/jpeg"
        return mime, base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def main() -> None:
    endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "")
    bucket = os.environ.get("GARAGE_BUCKET", "")
    access_key = os.environ.get("GARAGE_ACCESS_KEY", "")
    secret_key = os.environ.get("GARAGE_SECRET_KEY", "")
    region = os.environ.get("GARAGE_REGION", "garage")
    prefix = os.environ.get("GARAGE_PREFIX", "")

    missing = [n for n, v in [
        ("GARAGE_ENDPOINT_URL", endpoint), ("GARAGE_BUCKET", bucket),
        ("GARAGE_ACCESS_KEY", access_key), ("GARAGE_SECRET_KEY", secret_key),
    ] if not v]
    if missing:
        err("missing_env", "Missing env vars: " + ", ".join(missing))

    try:
        import boto3
        from botocore.config import Config as _Cfg
    except ImportError as exc:
        err("sdk_missing", f"boto3 not installed: {exc!r}")
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

        objects: list[dict] = []
        image_keys: list[str] = []

        paginator = s3.get_paginator("list_objects_v2")
        page_kwargs: dict = {"Bucket": bucket, "Delimiter": "/"}
        if prefix:
            page_kwargs["Prefix"] = prefix

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
                if is_image(key):
                    image_keys.append(key)
                if len(objects) >= MAX_OBJECTS:
                    break
            if len(objects) >= MAX_OBJECTS:
                break

        image_previews: list[dict] = []
        for key in image_keys[:MAX_IMAGES]:
            result = fetch_thumbnail(s3, bucket, key)
            if result:
                mime, b64 = result
                image_previews.append({"key": key, "mime": mime, "base64": b64})
            else:
                image_previews.append({"key": key, "mime": "image/jpeg"})

        emit({
            "ok": True,
            "bucket": bucket,
            "prefix": prefix,
            "objects": objects,
            "image_previews": image_previews,
        })

    except Exception as exc:
        err("s3_list_failed", f"Could not list objects for bucket '{bucket}' prefix '{prefix}': {exc!r}")


if __name__ == "__main__":
    main()
