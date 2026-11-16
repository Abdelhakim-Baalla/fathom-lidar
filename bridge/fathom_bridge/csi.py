"""Wi-Fi channel state information from an ESP32.

Espressif's esp-csi examples (``csi_recv``, ``get-started``) print one line per
received packet on the serial port:

    CSI_DATA,<seq>,<mac>,<rssi>,<rate>,...,<len>,<first_word>,"[i0,r0,i1,r1,...]"

The bracketed list holds one signed byte pair per subcarrier, imaginary part
first. The bridge turns each line into amplitudes and forwards them to the
console as a small JSON message; the console runs the motion detector.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections.abc import AsyncIterator

log = logging.getLogger("fathom.csi")


def parse_csi_line(line: str) -> tuple[int, list[float]] | None:
    """Return (rssi in dBm, amplitude per subcarrier), or None for any other line."""
    line = line.strip()
    if not line.startswith("CSI_DATA"):
        return None
    open_at = line.find("[")
    close_at = line.rfind("]")
    if open_at < 0 or close_at < open_at:
        return None
    fields = line[:open_at].split(",")
    try:
        rssi = int(fields[3])
        raw = [int(v) for v in line[open_at + 1 : close_at].replace(" ", "").split(",") if v]
    except (IndexError, ValueError):
        return None
    if len(raw) < 2 or len(raw) % 2:
        return None
    amp = [math.hypot(raw[k], raw[k + 1]) for k in range(0, len(raw), 2)]
    return rssi, amp


def csi_message(rssi: int, amp: list[float]) -> str:
    return json.dumps({"type": "csi", "t": time.time(), "rssi": rssi, "amp": [round(a, 2) for a in amp]},
                      separators=(",", ":"))


async def serial_lines(port: str, baud: int) -> AsyncIterator[str]:
    """Lines from a serial port, read on a thread so the event loop never blocks."""
    try:
        import serial  # pyserial, an optional dependency
    except ImportError as error:
        raise SystemExit("Reading an ESP32 needs pyserial: uv sync --extra csi") from error

    # Opening and reading off the event loop propagates device errors to the
    # bridge instead of silently killing a detached reader thread.
    dev = await asyncio.to_thread(serial.Serial, port, baud, timeout=1)
    log.info("reading CSI from %s at %d baud", port, baud)
    try:
        while True:
            raw = await asyncio.to_thread(dev.readline)
            if raw:
                yield raw.decode("ascii", errors="replace")
    finally:
        await asyncio.to_thread(dev.close)
