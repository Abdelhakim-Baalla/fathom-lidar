import asyncio
import json

import numpy as np
import websockets

from fathom_bridge.csi import csi_message, parse_csi_line
from fathom_bridge.frame import FLAG_SCAN, POINT, decode_frame, encode_frame
from fathom_bridge.server import Bridge

# One line as esp-csi's csi_recv example prints it, shortened to four subcarriers.
LINE = 'CSI_DATA,17,a4:cf:12:00:00:01,-47,11,1,7,1,0,1,1,0,1,0,-93,0,6,0,123456,0,52,0,8,1,"[0,0,3,4,-6,8,5,12]"'


def test_parses_an_esp32_line():
    rssi, amp = parse_csi_line(LINE)
    assert rssi == -47
    assert amp == [0.0, 5.0, 10.0, 13.0]


def test_ignores_other_serial_output():
    assert parse_csi_line("I (1234) wifi: connected") is None
    assert parse_csi_line('CSI_DATA,1,mac,notanumber,"[1,2]"') is None
    assert parse_csi_line('CSI_DATA,1,mac,-40,"[1,2,3]"') is None


def test_message_shape():
    m = json.loads(csi_message(-50, [1.234, 2.0]))
    assert m["type"] == "csi" and m["rssi"] == -50 and m["amp"] == [1.23, 2.0]


async def _lines():
    for _ in range(3):
        yield LINE
        await asyncio.sleep(0.01)


def test_relays_a_phone_frame_and_forwards_csi():
    async def run():
        bridge = Bridge(None, csi_lines=None)
        async with websockets.serve(bridge.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            url = f"ws://127.0.0.1:{port}"
            async with websockets.connect(url) as phone, websockets.connect(url) as desk:
                await asyncio.sleep(0.05)
                pts = np.zeros(2, dtype=POINT)
                pts["x"] = [1.0, 2.0]
                await phone.send(encode_frame(pts, frame_id=3, timestamp=1.0, flags=FLAG_SCAN))
                header, points = decode_frame(await asyncio.wait_for(desk.recv(), 2))
                assert header["flags"] & FLAG_SCAN and len(points) == 2
                # CSI goes to everyone
                bridge.csi_lines = _lines()
                task = asyncio.create_task(bridge.pump_csi())
                msg = json.loads(await asyncio.wait_for(desk.recv(), 2))
                assert msg["rssi"] == -47
                task.cancel()
    asyncio.run(run())
