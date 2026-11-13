import asyncio
import struct

import numpy as np
import pytest

from fathom_bridge import vlp16
from fathom_bridge.frame import FLAG_REVOLUTION_END, POINT, decode_frame, encode_frame
from fathom_bridge.sources import read_pcap, synthetic_packets


def make_packet(distance=10.0, start_az=0.0, step=0.4):
    az = start_az + step * np.arange(12)
    dist = np.full((12, 32), distance, dtype=np.float32)
    refl = np.full((12, 32), 64, dtype=np.uint8)
    return vlp16.build_packet(az, dist, refl, 123456)


def test_frame_layout_matches_the_console():
    pts = np.zeros(2, dtype=POINT)
    pts[0] = (1.5, -2.25, 0.5, 87, 3, 12345)
    data = encode_frame(pts, frame_id=42, timestamp=1234.5, flags=FLAG_REVOLUTION_END, position=(1, 2, 3), yaw=0.5)
    assert len(data) == 40 + 32
    assert data[:4] == b"FTHM"
    assert struct.unpack_from("<HHII", data, 4) == (1, FLAG_REVOLUTION_END, 42, 2)
    assert struct.unpack_from("<fffBBH", data, 40) == (1.5, -2.25, 0.5, 87, 3, 12345)
    header, back = decode_frame(data)
    assert header["frame_id"] == 42 and header["yaw"] == 0.5
    assert np.array_equal(back, pts)


def test_packet_roundtrip_geometry():
    points, stamp = vlp16.parse_packet(make_packet(distance=10.0))
    assert stamp == 123456
    assert len(points) == 12 * 32
    ranges = np.sqrt(points["x"] ** 2 + points["y"] ** 2 + points["z"] ** 2)
    assert np.allclose(ranges, 10.0, atol=0.002)
    # The first firing is laser 0 at azimuth 0: straight ahead, 15° down, lowest ring.
    first = points[0]
    assert first["ring"] == 0
    assert first["x"] == pytest.approx(10 * np.cos(np.radians(15)), abs=0.01)
    assert first["y"] == pytest.approx(0, abs=0.01)
    assert first["z"] == pytest.approx(-10 * np.sin(np.radians(15)), abs=0.01)
    assert set(points["ring"]) == set(range(16))


def test_clockwise_azimuth_becomes_counter_clockwise():
    points, _ = vlp16.parse_packet(make_packet(start_az=90.0))
    # 90° clockwise from forward is the sensor's right: negative y.
    assert points[0]["y"] < -9
    assert points[0]["azimuth"] == 27000


def test_zero_distance_means_no_return():
    az = 0.4 * np.arange(12)
    dist = np.zeros((12, 32), dtype=np.float32)
    dist[0, :4] = 5.0
    packet = vlp16.build_packet(az, dist, np.zeros((12, 32), dtype=np.uint8), 0)
    points, _ = vlp16.parse_packet(packet)
    assert len(points) == 4


def test_rejects_wrong_size_and_bad_flags():
    with pytest.raises(ValueError, match="expected 1206"):
        vlp16.parse_packet(b"\x00" * 100)
    with pytest.raises(ValueError, match="0xFFEE"):
        vlp16.parse_packet(b"\x00" * 1206)


def test_synthetic_source_stays_inside_its_room():
    async def take(n):
        out = []
        async for payload in synthetic_packets():
            out.append(payload)
            if len(out) == n:
                return out

    for payload in asyncio.run(take(5)):
        points, _ = vlp16.parse_packet(payload)
        assert len(points) > 300
        assert np.all(np.abs(points["x"]) < 6.2) and np.all(np.abs(points["y"]) < 4.2)


def test_reads_a_pcap(tmp_path):
    payload = make_packet()
    udp = struct.pack(">HHHH", 2368, 2368, 8 + len(payload), 0) + payload
    ip = bytes([0x45, 0]) + struct.pack(">H", 20 + len(udp)) + bytes(5) + bytes([17]) + bytes(10)
    eth = bytes(12) + b"\x08\x00" + ip + udp
    record = struct.pack("<IIII", 10, 500000, len(eth), len(eth)) + eth
    path = tmp_path / "one.pcap"
    path.write_bytes(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1) + record + record)
    packets = read_pcap(path)
    assert len(packets) == 2
    assert packets[0][0] == pytest.approx(10.5)
    assert packets[0][1] == payload
