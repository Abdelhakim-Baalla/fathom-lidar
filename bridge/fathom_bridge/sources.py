"""Where packets come from: a live UDP socket, a pcap capture, or a synthetic room."""

from __future__ import annotations

import asyncio
import struct
import time
from collections.abc import AsyncIterator
from pathlib import Path

import numpy as np

from . import vlp16


async def udp_packets(host: str, port: int) -> AsyncIterator[bytes]:
    """Yield data packets arriving on a UDP port (the sensor's default is 2368)."""
    queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=4096)

    class Receiver(asyncio.DatagramProtocol):
        def datagram_received(self, data: bytes, addr) -> None:
            if len(data) == vlp16.PACKET_BYTES and not queue.full():
                queue.put_nowait(data)

    transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
        Receiver, local_addr=(host, port)
    )
    try:
        while True:
            yield await queue.get()
    finally:
        transport.close()


def read_pcap(path: Path) -> list[tuple[float, bytes]]:
    """Read (capture time, UDP payload) for every sensor data packet in a classic pcap file."""
    data = path.read_bytes()
    magic = data[:4]
    if magic == b"\xd4\xc3\xb2\xa1":
        endian, scale = "<", 1e-6
    elif magic == b"\xa1\xb2\xc3\xd4":
        endian, scale = ">", 1e-6
    elif magic == b"\x4d\x3c\xb2\xa1":
        endian, scale = "<", 1e-9
    else:
        raise ValueError(f"{path} is not a classic pcap file (pcapng is not supported)")
    linktype = struct.unpack_from(endian + "I", data, 20)[0]
    if linktype != 1:
        raise ValueError(f"unsupported pcap link type {linktype}; expected Ethernet")
    packets: list[tuple[float, bytes]] = []
    offset = 24
    while offset + 16 <= len(data):
        sec, frac, caplen, _ = struct.unpack_from(endian + "IIII", data, offset)
        offset += 16
        frame = data[offset : offset + caplen]
        offset += caplen
        # Ethernet (14) + IPv4 (variable) + UDP (8)
        if len(frame) < 42 or frame[12:14] != b"\x08\x00" or frame[23] != 17:
            continue
        ip_header = (frame[14] & 0x0F) * 4
        payload = frame[14 + ip_header + 8 :]
        if len(payload) == vlp16.PACKET_BYTES:
            packets.append((sec + frac * scale, payload))
    return packets


async def pcap_packets(path: Path, loop: bool = True) -> AsyncIterator[bytes]:
    """Replay a capture at its recorded pace."""
    packets = read_pcap(path)
    if not packets:
        raise ValueError(f"{path} holds no {vlp16.PACKET_BYTES}-byte sensor packets")
    while True:
        start, first = time.monotonic(), packets[0][0]
        for stamp, payload in packets:
            delay = (stamp - first) - (time.monotonic() - start)
            if delay > 0:
                await asyncio.sleep(delay)
            yield payload
        if not loop:
            return


def _room_distance(az_rad: np.ndarray, el_rad: np.ndarray, t: float) -> tuple[np.ndarray, np.ndarray]:
    """Range and reflectivity to a 12 m × 8 m room with a pillar that orbits the sensor."""
    half_x, half_y, floor, ceiling = 6.0, 4.0, -1.2, 1.6
    dx, dy = np.cos(el_rad) * np.cos(az_rad), np.cos(el_rad) * np.sin(az_rad)
    dz = np.sin(el_rad)
    with np.errstate(divide="ignore"):
        tx = np.where(dx > 0, half_x / dx, np.where(dx < 0, -half_x / dx, np.inf))
        ty = np.where(dy > 0, half_y / dy, np.where(dy < 0, -half_y / dy, np.inf))
        tz = np.where(dz > 0, ceiling / dz, np.where(dz < 0, floor / dz, np.inf))
    dist = np.minimum(np.minimum(tx, ty), tz)
    refl = np.where(dist == tz, 30, 55).astype(np.uint8)
    # Pillar: vertical cylinder of radius 0.3 m on a 2.5 m orbit.
    px, py, radius = 2.5 * np.cos(t * 0.6), 2.5 * np.sin(t * 0.6), 0.3
    hx, hy = np.cos(az_rad), np.sin(az_rad)
    b = px * hx + py * hy
    disc = b * b - (px * px + py * py - radius * radius)
    planar = b - np.sqrt(np.maximum(disc, 0))
    pillar = np.where((disc > 0) & (planar > 0), planar / np.cos(el_rad), np.inf)
    hit = pillar < dist
    return np.where(hit, pillar, dist), np.where(hit, 90, refl).astype(np.uint8)


async def synthetic_packets(rate_hz: float = 10.0) -> AsyncIterator[bytes]:
    """Real VLP-16 packets describing a synthetic room, for testing without a sensor."""
    rng = np.random.default_rng(3)
    block_us = 2 * vlp16.FIRING_CYCLE_US
    deg_per_block = 360.0 * rate_hz * block_us * 1e-6
    packet_seconds = vlp16.BLOCKS * block_us * 1e-6
    laser = np.tile(np.arange(16), 2)
    el = np.radians(vlp16.ELEVATION_DEG[laser])[None, :]
    azimuth, stamp_us, started = 0.0, 0, time.monotonic()
    sent = 0
    while True:
        block_az = (azimuth + deg_per_block * np.arange(vlp16.BLOCKS)) % 360.0
        firing_az = block_az[:, None] + deg_per_block * vlp16._FIRING_FRACTION[None, :]
        # Velodyne azimuth runs clockwise; the room maths is counter-clockwise.
        dist, refl = _room_distance(np.radians(-firing_az), el, stamp_us * 1e-6)
        dist = dist + rng.normal(0, 0.01, dist.shape)
        yield vlp16.build_packet(block_az, dist, refl, stamp_us)
        azimuth = (azimuth + deg_per_block * vlp16.BLOCKS) % 360.0
        stamp_us += int(vlp16.BLOCKS * block_us)
        sent += 1
        ahead = sent * packet_seconds - (time.monotonic() - started)
        if ahead > 0.005:
            await asyncio.sleep(ahead)
