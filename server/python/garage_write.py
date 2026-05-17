"""Worker-only Garage/S3 write operations for GridWeave Inspector.

The local Node server passes an action request on stdin, but never talks to
Garage/S3 directly. This helper authenticates to GridWeave, submits a remote
worker job, and the remote worker performs the actual s3fs put operations.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import traceback
from typing import Any


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _err(code: str, message: str, action: str | None = None) -> None:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if action:
        payload["action"] = action
    _emit(payload)
    sys.exit(0)


def _read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        _err("missing_request", "No write request was provided.")
    try:
        value = json.loads(raw)
    except Exception as exc:
        _err("bad_request", f"Could not parse write request JSON: {exc!r}")
    if not isinstance(value, dict):
        _err("bad_request", "Write request must be a JSON object.")
    return value


def _parse_vram_gb(vram: str) -> float:
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(GB|MB)\s*$", vram, re.I)
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = match.group(2).upper()
    return value / 1024 if unit == "MB" else value


def _friendly_remote_error(exc: Exception, cfg: dict[str, str], action: str) -> tuple[str, str] | None:
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
                "Select another accelerator vendor and try the storage action again.",
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
                "Select another accelerator vendor and try the storage action again.",
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
        _err("missing_env", "Missing required environment variables: " + ", ".join(missing))
    return cfg


def _clean_prefix(prefix: str) -> str:
    value = str(prefix or "").strip().lstrip("/")
    return value if not value or value.endswith("/") else value + "/"


def _clean_name(name: str) -> str:
    value = str(name or "").strip().replace("\\", "/").lstrip("/")
    parts = [part for part in value.split("/") if part not in {"", ".", ".."}]
    return "/".join(parts)


def main() -> None:
    request = _read_stdin_json()
    action = str(request.get("action") or "")
    if action not in {"create_folder", "upload_files"}:
        _err("bad_action", "Action must be create_folder or upload_files.", action or None)

    cfg = _read_env()
    base_prefix = _clean_prefix(str(request.get("prefix", cfg["prefix"])))

    if action == "create_folder":
        folder_name = _clean_name(str(request.get("folder_name") or ""))
        if not folder_name:
            _err("bad_folder_name", "Folder name is required.", action)
        folder_key = _clean_prefix(base_prefix + folder_name)
        write_request: dict[str, Any] = {
            "action": action,
            "prefix": base_prefix,
            "objects": [
                {
                    "key": folder_key,
                    "content_type": "application/x-directory",
                    "base64": "",
                }
            ],
        }
    else:
        files = request.get("files")
        if not isinstance(files, list) or not files:
            _err("bad_files", "Select at least one file to upload.", action)
        if len(files) > 10:
            _err("too_many_files", "Upload up to 10 files per worker job.", action)

        objects: list[dict[str, Any]] = []
        for item in files:
            if not isinstance(item, dict):
                _err("bad_files", "Every upload item must be an object.", action)
            name = _clean_name(str(item.get("name") or ""))
            if not name:
                _err("bad_file_name", "Every file must have a valid name.", action)
            data = str(item.get("base64") or "")
            if not data:
                _err("bad_file_data", f"File {name} did not include base64 data.", action)
            declared_size = int(item.get("size") or 0)
            if declared_size > 25 * 1024 * 1024:
                _err("file_too_large", f"File {name} is larger than the 25 MB UI limit.", action)
            objects.append(
                {
                    "key": base_prefix + name,
                    "content_type": str(item.get("mime") or "application/octet-stream"),
                    "base64": data,
                }
            )

        write_request = {"action": action, "prefix": base_prefix, "objects": objects}

    try:
        import gridweave  # type: ignore
    except Exception as exc:
        _err(
            "sdk_missing",
            f"gridweave SDK not available in this Python environment: {exc!r}.",
            action,
        )
        return

    try:
        auth_fn = getattr(gridweave, "auth", None) or getattr(gridweave, "authenticate", None)
        if auth_fn is None:
            _err("auth_failed", "gridweave SDK has neither auth() nor authenticate().", action)
            return
        auth_fn(cfg["token"], platform_url=cfg["platform_url"])
    except Exception as exc:
        _err("auth_failed", f"gridweave authentication failed: {exc!r}", action)
        return

    remote_kwargs = {"vram": cfg["job_vram"], "vendor": cfg["job_vendor"]}

    def _write_to_garage() -> dict[str, Any]:
        import base64 as _base64

        import s3fs  # type: ignore

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

        written: list[dict[str, Any]] = []
        for obj in write_request["objects"]:
            body = _base64.b64decode(obj["base64"]) if obj["base64"] else b""
            full_path = f"{cfg['bucket']}/{obj['key']}"
            fs.pipe(full_path, body, ContentType=obj["content_type"])
            written.append(
                {
                    "key": obj["key"],
                    "size": len(body),
                    "content_type": obj["content_type"],
                    "etag": "",
                }
            )

        return {
            "ok": True,
            "action": write_request["action"],
            "bucket": cfg["bucket"],
            "prefix": write_request["prefix"],
            "objects": written,
            "message": (
                f"Created folder {written[0]['key']}"
                if write_request["action"] == "create_folder"
                else f"Uploaded {len(written)} file{'s' if len(written) != 1 else ''}"
            ),
        }

    try:
        remote_fn = gridweave.remote(**remote_kwargs)(_write_to_garage)  # type: ignore[misc]
        if hasattr(gridweave, "run"):
            result = gridweave.run(remote_fn)
        elif hasattr(remote_fn, "remote"):
            result = remote_fn.remote()  # type: ignore[attr-defined]
        else:
            result = remote_fn()

        if not isinstance(result, dict) and hasattr(result, "get"):
            result = result.get()
    except Exception as exc:
        friendly = _friendly_remote_error(exc, cfg, action)
        if friendly:
            _err(friendly[0], friendly[1], action)
            return
        _err("remote_failed", f"Garage write worker failed: {exc!r}", action)
        return

    if not isinstance(result, dict):
        _err("bad_result", f"Unexpected result type: {type(result).__name__}", action)
    _emit(result)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        _err("unhandled", f"{exc!r}\n{traceback.format_exc()}")
