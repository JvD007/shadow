"""Demo fallback that mirrors the real check's output shape.

Used when GRIDWEAVE_DEMO=1 or when the real check cannot run because the
gridweave SDK isn't installed and the user wants to preview the UI. It
generates a small set of fake objects and tiny PNG image previews so the
gallery layout still renders end-to-end.
"""

from __future__ import annotations

import base64
import datetime as _dt
import io
import json
import os
import struct
import sys
import zlib
from typing import Any


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """Build a minimal valid PNG of solid color, no external deps."""

    def _chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = bytearray()
    row_prefix = b"\x00"
    pixel = bytes(rgb)
    for _ in range(height):
        raw += row_prefix + pixel * width
    idat = zlib.compress(bytes(raw), 9)
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


def main() -> None:
    bucket = os.environ.get("GARAGE_BUCKET", "demo-bucket")
    prefix = os.environ.get("GARAGE_PREFIX", "demo/")
    endpoint = os.environ.get("GARAGE_ENDPOINT_URL", "https://garage.example.com")
    vendor = os.environ.get("GRIDWEAVE_JOB_VENDOR", "NVIDIA")
    vram = os.environ.get("GRIDWEAVE_JOB_VRAM", "2GB")
    now = _dt.datetime.utcnow()

    palette = [
        (32, 128, 141),
        (168, 75, 47),
        (27, 71, 77),
        (148, 68, 84),
        (255, 197, 83),
        (132, 132, 86),
    ]

    images: list[dict[str, str]] = []
    for i, rgb in enumerate(palette):
        png = _png(96, 96, rgb)
        images.append(
            {
                "key": f"{prefix}sample/img_{i:02d}.png",
                "mime": "image/png",
                "base64": base64.b64encode(png).decode("ascii"),
            }
        )

    objects_sample = []
    for i in range(20):
        objects_sample.append(
            {
                "key": f"{prefix}sample/obj_{i:03d}.bin",
                "size": 1024 * (i + 1),
                "last_modified": (now - _dt.timedelta(minutes=i)).isoformat() + "Z",
                "storage_class": "STANDARD",
            }
        )

    output_text = "\n".join(
        [
            "[demo mode] No real GridWeave call was made.",
            f"GridWeave vendor: {vendor}",
            f"GridWeave VRAM request: {vram}",
            "Server model: Dell Inc. PowerEdge R750",
            "CPU cores: 64",
            "Total memory GB: 512.0",
            "nvidia-smi -L:",
            "GPU 0: NVIDIA A10 (UUID: GPU-demo-0000)",
            "GPU 1: NVIDIA A10 (UUID: GPU-demo-0001)",
            "pandas version: 2.2.2",
            f"Garage endpoint: {endpoint}",
            f"Bucket: {bucket}  Prefix: {prefix!r}",
            "Total objects under prefix: 247",
            "Image-like objects found: 18",
            f"Image previews returned: {len(images)}",
        ]
    )

    payload = {
        "ok": True,
        "demo": True,
        "result": {
            "output_text": output_text,
            "objects_sample": objects_sample,
            "image_previews": images,
            "server_info": {
                "model": "Dell Inc. PowerEdge R750",
                "cpu_cores": 64,
                "memory_gb": 512.0,
            },
            "job_config": {
                "vendor": vendor,
                "vram": vram,
                "prefix": prefix,
            },
        },
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
