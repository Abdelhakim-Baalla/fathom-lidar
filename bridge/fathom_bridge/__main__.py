"""Command line: python -m fathom_bridge --source synthetic"""

from __future__ import annotations

import argparse
import asyncio
import logging
import ssl
from pathlib import Path

from .csi import serial_lines
from .server import Bridge
from .sources import pcap_packets, synthetic_packets, udp_packets


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="fathom-bridge",
        description="Forward VLP-16 packets, ESP32 Wi-Fi CSI and phone scans to the Fathom console.",
    )
    parser.add_argument("--source", choices=["synthetic", "udp", "pcap", "relay"], default="relay",
                        help="synthetic: a generated room, no sensor needed; udp: a live sensor; pcap: a capture file; "
                             "relay: no LiDAR, only relay phone scans and CSI")
    parser.add_argument("--file", type=Path, help="capture to replay when --source pcap")
    parser.add_argument("--udp-host", default="0.0.0.0", help="address to listen on for sensor packets")
    parser.add_argument("--udp-port", type=int, default=2368, help="sensor data port")
    parser.add_argument("--ws-host", default="127.0.0.1", help="address the console connects to")
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--csi-serial", metavar="PORT", help="ESP32 running esp-csi, e.g. /dev/ttyUSB0 or COM3")
    parser.add_argument("--csi-baud", type=int, default=921600)
    parser.add_argument("--no-loop", action="store_true", help="stop at the end of a capture instead of repeating it")
    parser.add_argument("--cert", type=Path, help="TLS certificate for an HTTPS console's wss:// connection")
    parser.add_argument("--key", type=Path, help="TLS private key (required with --cert)")
    parser.add_argument("--allow-origin", action="append", help="Allowed browser origin; repeat for multiple consoles")
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key must be supplied together")
    tls = None
    if args.cert:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(args.cert, args.key)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")

    if args.source == "pcap":
        if args.file is None:
            parser.error("--source pcap needs --file")
        if not args.file.is_file():
            parser.error(f"capture not found: {args.file}")
        packets = pcap_packets(args.file, loop=not args.no_loop)
    elif args.source == "udp":
        packets = udp_packets(args.udp_host, args.udp_port)
    elif args.source == "relay":
        packets = None
    else:
        packets = synthetic_packets()

    csi = serial_lines(args.csi_serial, args.csi_baud) if args.csi_serial else None
    bridge = Bridge(packets, simulated=args.source == "synthetic", csi_lines=csi, origins=args.allow_origin, tls=tls)
    try:
        asyncio.run(bridge.serve(args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
