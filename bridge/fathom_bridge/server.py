"""WebSocket server: batches sensor packets into FTHM frames and broadcasts them.

It also relays: an FTHM frame sent by one client (a phone scanning a room) goes
to every other client, and CSI lines from an ESP32 go out as JSON messages.
"""

from __future__ import annotations

import asyncio
import logging
import time
import ssl
from collections.abc import AsyncIterator

import numpy as np
import websockets

from . import vlp16
from .csi import csi_message, parse_csi_line
from .frame import FLAG_REVOLUTION_END, FLAG_SIMULATED, decode_frame, encode_frame

log = logging.getLogger("fathom.bridge")


class Bridge:
    def __init__(
        self,
        packets: AsyncIterator[bytes] | None,
        *,
        batch: int = 8,
        simulated: bool = False,
        csi_lines: AsyncIterator[str] | None = None,
        origins: list[str] | None = None,
        tls: ssl.SSLContext | None = None,
    ) -> None:
        self.origins = origins
        self.tls = tls
        self.packets = packets
        self.csi_lines = csi_lines
        self.csi_sent = 0
        self.relayed = 0
        self.batch = batch
        self.base_flags = FLAG_SIMULATED if simulated else 0
        self.clients: set = set()
        self.frame_id = 0
        self.points_sent = 0

    async def handler(self, websocket) -> None:
        self.clients.add(websocket)
        log.info("console connected from %s (%d open)", websocket.remote_address, len(self.clients))
        try:
            async for message in websocket:
                # Relay frames a client sends (a phone scan) to every other client.
                if isinstance(message, bytes):
                    try:
                        decode_frame(message)
                    except ValueError:
                        await websocket.close(code=1007, reason="Invalid FTHM frame")
                        break
                    others = self.clients - {websocket}
                    if others:
                        websockets.broadcast(others, message)
                    self.relayed += 1
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            log.info("console disconnected (%d open)", len(self.clients))

    async def pump_csi(self) -> None:
        if self.csi_lines is None:
            return
        async for line in self.csi_lines:
            parsed = parse_csi_line(line)
            if parsed is None:
                continue
            self.csi_sent += 1
            if self.clients:
                websockets.broadcast(self.clients, csi_message(*parsed))

    async def pump(self) -> None:
        if self.packets is None:
            return
        pending: list[np.ndarray] = []
        last_azimuth = -1
        wrapped = False
        dropped = 0
        async for payload in self.packets:
            try:
                points, _ = vlp16.parse_packet(payload)
            except ValueError as error:
                dropped += 1
                if dropped in (1, 10, 100) or dropped % 1000 == 0:
                    log.warning("dropped %d malformed packets; latest: %s", dropped, error)
                continue
            # Raw packet azimuth runs clockwise, so a wrap shows as a drop in the first block's value.
            first = int.from_bytes(payload[2:4], "little")
            if last_azimuth >= 0 and first < last_azimuth:
                wrapped = True
            last_azimuth = first
            pending.append(points)
            if len(pending) < self.batch and not wrapped:
                continue
            merged = np.concatenate(pending)
            pending.clear()
            frame = encode_frame(
                merged,
                frame_id=self.frame_id,
                timestamp=time.time(),
                flags=self.base_flags | (FLAG_REVOLUTION_END if wrapped else 0),
            )
            wrapped = False
            self.frame_id += 1
            self.points_sent += len(merged)
            if self.clients:
                websockets.broadcast(self.clients, frame)

    async def report(self) -> None:
        while True:
            before = self.points_sent
            await asyncio.sleep(5)
            log.info(
                "%d points/s, %d CSI packets/s, %d relayed frames/s, %d console(s)",
                (self.points_sent - before) // 5, self.csi_sent // 5, self.relayed // 5, len(self.clients),
            )
            self.csi_sent = self.relayed = 0

    async def serve(self, host: str, port: int) -> None:
        async with websockets.serve(self.handler, host, port, max_size=16_000_040, origins=self.origins, ssl=self.tls, ping_interval=10, ping_timeout=10):
            log.info("listening on ws://%s:%d", host, port)
            await asyncio.gather(self.pump(), self.pump_csi(), self.report())
