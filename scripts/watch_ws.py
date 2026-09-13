"""Example: connect to the live WebSocket feed and print each sample.

Opening this connection is itself the viewer-count signal that drives the
device's sampling rate (see app.py _set_viewers): the first viewer bumps the
ESP32 to 10 Hz, and the last one leaving drops it back to 0.1 Hz.

Run (with the backend already up, e.g. `uv run power-monitor`):
    cd python && uv run python scripts/watch_ws.py
    cd python && uv run python scripts/watch_ws.py --url ws://192.168.1.50:38000/ws
    cd python && uv run python scripts/watch_ws.py --raw   # print raw JSON lines
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json

import websockets

DEFAULT_URL = "ws://127.0.0.1:38000/ws"


def fmt_ts(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).strftime("%H:%M:%S.%f")[:-3]


async def watch(url: str, raw: bool) -> None:
    print(f"connecting to {url} ...", flush=True)
    async for ws in websockets.connect(url):
        print("connected, waiting for samples (Ctrl+C to quit)", flush=True)
        try:
            async for message in ws:
                if raw:
                    print(message, flush=True)
                    continue
                sample = json.loads(message)
                print(
                    f"{fmt_ts(sample['sys_ts'])}  "
                    f"{sample['voltage']:6.3f} V  "
                    f"{sample['current']:8.2f} mA  "
                    f"{sample['power']:9.2f} mW  "
                    f"(dev_ts={sample['dev_ts']})",
                    flush=True,
                )
        except websockets.ConnectionClosed:
            print("connection closed, reconnecting ...", flush=True)
            continue


def main() -> None:
    parser = argparse.ArgumentParser(description="Print live samples from the power-monitor WebSocket feed")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"WebSocket URL (default: {DEFAULT_URL})")
    parser.add_argument("--raw", action="store_true", help="print raw JSON instead of a formatted line")
    args = parser.parse_args()
    try:
        asyncio.run(watch(args.url, args.raw))
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
