"""WebSocket server: batches sensor packets into FTHM frames and broadcasts them."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator

import numpy as np
import websockets

from . import vlp16
from .frame import FLAG_REVOLUTION_END, FLAG_SIMULATED, encode_frame

log = logging.getLogger("fathom.bridge")


class Bridge:
    def __init__(self, packets: AsyncIterator[bytes], *, batch: int = 8, simulated: bool = False) -> None:
        self.packets = packets
        self.batch = batch
        self.base_flags = FLAG_SIMULATED if simulated else 0
        self.clients: set = set()
        self.frame_id = 0
        self.points_sent = 0

    async def handler(self, websocket) -> None:
        self.clients.add(websocket)
        log.info("console connected from %s (%d open)", websocket.remote_address, len(self.clients))
        try:
            await websocket.wait_closed()
        finally:
            self.clients.discard(websocket)
            log.info("console disconnected (%d open)", len(self.clients))

    async def pump(self) -> None:
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
            log.info("%d points/s to %d console(s)", (self.points_sent - before) // 5, len(self.clients))

    async def serve(self, host: str, port: int) -> None:
        async with websockets.serve(self.handler, host, port, max_size=None):
            log.info("listening on ws://%s:%d", host, port)
            await asyncio.gather(self.pump(), self.report())
