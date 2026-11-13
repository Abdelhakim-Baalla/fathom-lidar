"""Velodyne VLP-16 data packet parser (single-return mode).

Layout, from the VLP-16 user manual: a 1206-byte UDP payload holds 12 data
blocks of 100 bytes, then a 4-byte timestamp (microseconds past the hour) and
2 factory bytes. Each block is a 0xFFEE flag, an azimuth in hundredths of a
degree, and 32 returns of (distance in 2 mm units, reflectivity). The 32
returns are two firing sequences of the 16 lasers; the second sequence has no
azimuth of its own, so it is interpolated from the next block.
"""

from __future__ import annotations

import numpy as np

from .frame import POINT

PACKET_BYTES = 1206
BLOCKS = 12
BLOCK_FLAG = 0xEEFF  # 0xFF 0xEE on the wire, read little-endian
DISTANCE_UNIT = 0.002  # metres
FIRING_CYCLE_US = 55.296
LASER_SPACING_US = 2.304

# Elevation of each laser in firing order, degrees.
ELEVATION_DEG = np.array([-15, 1, -13, 3, -11, 5, -9, 7, -7, 9, -5, 11, -3, 13, -1, 15], dtype=np.float32)
# Channel index with 0 = lowest beam, as FTHM frames number rings.
RING = np.argsort(np.argsort(ELEVATION_DEG)).astype(np.uint8)

_BLOCK = np.dtype(
    [
        ("flag", "<u2"),
        ("azimuth", "<u2"),
        ("returns", [("distance", "<u2"), ("reflectivity", "u1")], 32),
    ]
)
_PACKET = np.dtype([("blocks", _BLOCK, BLOCKS), ("timestamp", "<u4"), ("factory", "u1", 2)])
assert _PACKET.itemsize == PACKET_BYTES

_COS_EL = np.cos(np.radians(ELEVATION_DEG))
_SIN_EL = np.sin(np.radians(ELEVATION_DEG))
# Time of each of the 32 firings within a block, as a fraction of the block's duration.
_FIRING_FRACTION = (
    np.repeat([0.0, FIRING_CYCLE_US], 16) + np.tile(np.arange(16) * LASER_SPACING_US, 2)
) / (2 * FIRING_CYCLE_US)


def parse_packet(payload: bytes) -> tuple[np.ndarray, int]:
    """Return (points, timestamp_us). Points with zero distance (no return) are dropped."""
    if len(payload) != PACKET_BYTES:
        raise ValueError(f"expected {PACKET_BYTES} bytes, got {len(payload)}")
    packet = np.frombuffer(payload, dtype=_PACKET)[0]
    blocks = packet["blocks"]
    if not np.all(blocks["flag"] == BLOCK_FLAG):
        raise ValueError("data block flag is not 0xFFEE")

    azimuth = blocks["azimuth"].astype(np.float32) / 100.0  # degrees, clockwise from forward
    # Rotation covered by each block; the last block reuses the previous gap.
    gap = np.empty(BLOCKS, dtype=np.float32)
    gap[:-1] = (azimuth[1:] - azimuth[:-1]) % 360.0
    gap[-1] = gap[-2]
    # Azimuth of every firing: (12, 32)
    az = (azimuth[:, None] + gap[:, None] * _FIRING_FRACTION[None, :]) % 360.0

    distance = blocks["returns"]["distance"].astype(np.float32) * DISTANCE_UNIT
    reflectivity = blocks["returns"]["reflectivity"]
    laser = np.tile(np.arange(16), 2)
    cos_el, sin_el = _COS_EL[laser][None, :], _SIN_EL[laser][None, :]

    az_rad = np.radians(az)
    planar = distance * cos_el
    valid = distance > 0

    out = np.empty(int(valid.sum()), dtype=POINT)
    # Velodyne: Y forward, X right, azimuth clockwise. FTHM: x forward, y left, azimuth counter-clockwise.
    out["x"] = (planar * np.cos(az_rad))[valid]
    out["y"] = (-planar * np.sin(az_rad))[valid]
    out["z"] = (distance * sin_el)[valid]
    out["intensity"] = reflectivity[valid]
    out["ring"] = np.broadcast_to(RING[laser][None, :], distance.shape)[valid]
    out["azimuth"] = (np.round((360.0 - az) * 100.0).astype(np.int64) % 36000).astype(np.uint16)[valid]
    return out, int(packet["timestamp"])


def build_packet(azimuths_deg: np.ndarray, distances_m: np.ndarray, reflectivity: np.ndarray, timestamp_us: int) -> bytes:
    """Assemble a data packet from 12 block azimuths and (12, 32) returns. Used by the synthetic source and tests."""
    packet = np.zeros(1, dtype=_PACKET)
    blocks = packet["blocks"][0]
    blocks["flag"] = BLOCK_FLAG
    blocks["azimuth"] = np.round(np.asarray(azimuths_deg) * 100).astype(np.int64) % 36000
    blocks["returns"]["distance"] = np.clip(np.round(distances_m / DISTANCE_UNIT), 0, 65535)
    blocks["returns"]["reflectivity"] = reflectivity
    packet["timestamp"] = timestamp_us % 3_600_000_000
    packet["factory"] = (0x37, 0x22)  # strongest return, VLP-16
    return packet.tobytes()
