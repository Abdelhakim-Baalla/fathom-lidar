"""FTHM frame encoding. Mirrors console/src/protocol/frame.ts byte for byte."""

from __future__ import annotations

import struct

import numpy as np

MAGIC = b"FTHM"
VERSION = 1
HEADER = struct.Struct("<4sHHIId3ff")  # 40 bytes
FLAG_SIMULATED = 1 << 0
FLAG_REVOLUTION_END = 1 << 1

POINT = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("intensity", "u1"),
        ("ring", "u1"),
        ("azimuth", "<u2"),
    ]
)
assert HEADER.size == 40 and POINT.itemsize == 16


def encode_frame(
    points: np.ndarray,
    *,
    frame_id: int,
    timestamp: float,
    flags: int = 0,
    position: tuple[float, float, float] = (0.0, 0.0, 0.0),
    yaw: float = 0.0,
) -> bytes:
    """Encode a structured array of dtype POINT as one FTHM frame."""
    if points.dtype != POINT:
        raise TypeError("points must use fathom_bridge.frame.POINT")
    header = HEADER.pack(
        MAGIC, VERSION, flags, frame_id & 0xFFFFFFFF, len(points), timestamp, *position, yaw
    )
    return header + points.tobytes()


def decode_frame(data: bytes) -> tuple[dict, np.ndarray]:
    """Inverse of encode_frame; used by tests and for inspecting recordings."""
    magic, version, flags, frame_id, count, timestamp, x, y, z, yaw = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ValueError("not an FTHM frame")
    if version != VERSION:
        raise ValueError(f"unsupported frame version {version}")
    points = np.frombuffer(data, dtype=POINT, count=count, offset=HEADER.size)
    header = {
        "flags": flags,
        "frame_id": frame_id,
        "timestamp": timestamp,
        "position": (x, y, z),
        "yaw": yaw,
    }
    return header, points
