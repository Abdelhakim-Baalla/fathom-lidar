"""Command line: python -m fathom_bridge --source synthetic"""

from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

from .server import Bridge
from .sources import pcap_packets, synthetic_packets, udp_packets


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="fathom-bridge",
        description="Forward VLP-16 data packets to the Fathom console as FTHM frames.",
    )
    parser.add_argument("--source", choices=["synthetic", "udp", "pcap"], default="synthetic",
                        help="synthetic: a generated room, no sensor needed; udp: a live sensor; pcap: a capture file")
    parser.add_argument("--file", type=Path, help="capture to replay when --source pcap")
    parser.add_argument("--udp-host", default="0.0.0.0", help="address to listen on for sensor packets")
    parser.add_argument("--udp-port", type=int, default=2368, help="sensor data port")
    parser.add_argument("--ws-host", default="127.0.0.1", help="address the console connects to")
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--no-loop", action="store_true", help="stop at the end of a capture instead of repeating it")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")

    if args.source == "pcap":
        if args.file is None:
            parser.error("--source pcap needs --file")
        if not args.file.is_file():
            parser.error(f"capture not found: {args.file}")
        packets = pcap_packets(args.file, loop=not args.no_loop)
    elif args.source == "udp":
        packets = udp_packets(args.udp_host, args.udp_port)
    else:
        packets = synthetic_packets()

    bridge = Bridge(packets, simulated=args.source == "synthetic")
    try:
        asyncio.run(bridge.serve(args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
