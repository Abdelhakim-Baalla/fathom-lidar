import asyncio
import struct

import numpy as np
import pytest
import websockets

from fathom_bridge.frame import POINT, decode_frame, encode_frame
from fathom_bridge.server import Bridge


def frame():
    return encode_frame(np.zeros(1, dtype=POINT), frame_id=1, timestamp=1)


@pytest.mark.parametrize('data', [b'', b'FTHM', frame()[:-1], frame() + b'garbage'])
def test_rejects_incomplete_and_surplus_frames(data):
    with pytest.raises(ValueError):
        decode_frame(data)


@pytest.mark.parametrize('offset,fmt,value', [(16, '<d', float('nan')), (40, '<f', float('inf')), (12, '<I', 2**32-1)])
def test_rejects_invalid_numeric_payloads(offset, fmt, value):
    data = bytearray(frame())
    struct.pack_into(fmt, data, offset, value)
    with pytest.raises(ValueError):
        decode_frame(data)


def test_relay_closes_invalid_sender_without_forwarding():
    async def run():
        bridge = Bridge(None)
        async with websockets.serve(bridge.handler, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f'ws://127.0.0.1:{port}') as sender:
                await sender.send(b'FTHM' + bytes(36))
                with pytest.raises(websockets.ConnectionClosedError) as closed:
                    await sender.recv()
                assert closed.value.rcvd.code == 1007
                assert bridge.relayed == 0
    asyncio.run(run())
