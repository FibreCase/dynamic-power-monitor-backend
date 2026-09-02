"""End-to-end test (no hardware): fake ESP32 over TCP + a WebSocket viewer.

Verifies, against the real IngestServer / Database / FastAPI app:
  1. 20-byte sample frames are reassembled (a frame split across two writes,
     and one prefixed with garbage) and persisted to SQLite.
  2. The WebSocket viewer receives the broadcast JSON.
  3. First viewer -> 10 Hz downstream control (interval=100);
     last viewer leaves -> 0.1 Hz (interval=10000).
  4. GET /api/v1/history returns the persisted samples in descending order.

Run:  cd python && uv run python -m tests.e2e
"""
from __future__ import annotations

import asyncio
import json
import struct
import tempfile
from pathlib import Path

import httpx
import uvicorn
import websockets

from power_monitor import config
from power_monitor.app import App
from power_monitor import protocol

INGEST_PORT = 18888
WEB_PORT = 18000


def make_sample(dev_ts: int, voltage: float, current_ma: float) -> bytes:
    """Build a valid 20-byte upstream frame (mirrors the firmware)."""
    body = struct.pack("<2sQff", protocol.SAMPLE_HEADER, dev_ts, voltage, current_ma)
    return body + struct.pack("<H", sum(body) & 0xFFFF)


async def read_control(reader) -> int | None:
    """Read up to one complete 8-byte downstream control frame; return interval_ms."""
    buf = b""
    for _ in range(40):
        chunk = await asyncio.wait_for(reader.read(8 - len(buf)), timeout=2.0)
        if not chunk:
            return None
        buf += chunk
        if len(buf) < 8:
            continue
        if buf[0:2] != protocol.CONTROL_HEADER:
            buf = buf[1:]
            continue
        interval = struct.unpack("<H", buf[4:6])[0]
        if (sum(buf[:6]) & 0xFFFF) != struct.unpack("<H", buf[6:8])[0]:
            buf = buf[1:]
            continue
        return interval
    return None


async def run() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="pm_e2e_"))
    config.db_path = tmp / "power.db"
    config.db_batch_size = 100_000        # force time-based flush (0.2s)
    config.db_flush_interval = 0.2
    config.tcp_host = "127.0.0.1"
    config.tcp_port = INGEST_PORT

    app = App()
    cfg = uvicorn.Config(app.app, host="127.0.0.1", port=WEB_PORT, log_level="warning")
    server = uvicorn.Server(cfg)
    serve_task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)

    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    dev_reader = dev_writer = None
    try:
        # 1) Fake device connects FIRST so the control frames have a link.
        dev_reader, dev_writer = await asyncio.open_connection("127.0.0.1", INGEST_PORT)
        await asyncio.sleep(0.1)

        # 2) Viewer connects -> 0->1 -> server sends interval=100 to the device.
        ws_url = f"ws://127.0.0.1:{WEB_PORT}/ws"
        async with websockets.connect(ws_url) as ws:
            ctrl = await read_control(dev_reader)
            check("first viewer -> 10Hz control (interval=100)", ctrl == 100, f"got {ctrl}")

            # 3) Send two good frames; f1 prefixed with garbage, f2 split in half.
            f1 = make_sample(1_000, 12.045, 512.3)
            f2 = make_sample(2_000, 12.100, 480.0)
            dev_writer.write(b"\x00\x13\x37" + f1)
            await dev_writer.drain()
            await asyncio.sleep(0.1)
            dev_writer.write(f2[:6])
            await dev_writer.drain()
            await asyncio.sleep(0.05)
            dev_writer.write(f2[6:])
            await dev_writer.drain()

            # 4) Viewer receives two broadcasts.
            got = []
            try:
                for _ in range(2):
                    got.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0)))
            except asyncio.TimeoutError:
                pass
            check("viewer received 2 broadcasts", len(got) == 2, f"got {len(got)}")
            if got:
                g = got[0]
                check("broadcast has all fields",
                      all(k in g for k in ("sys_ts", "dev_ts", "voltage", "current", "power")))
                check("broadcast dev_ts is one of the sent values",
                      g.get("dev_ts") in (1000, 2000), str(g))
                check("broadcast power == voltage*current (mW)",
                      abs(g["voltage"] * g["current"] - g["power"]) < 1.0,
                      f"v={g['voltage']} i={g['current']} p={g['power']}")

        # 5) Last viewer left -> 1->0 -> server sends interval=10000.
        ctrl2 = await read_control(dev_reader)
        check("last viewer left -> 0.1Hz control (interval=10000)", ctrl2 == 10000, f"got {ctrl2}")

        # 6) History returns the persisted samples (allow the flush interval).
        await asyncio.sleep(0.4)
        async with httpx.AsyncClient() as client:
            rows = (await client.get(f"http://127.0.0.1:{WEB_PORT}/api/v1/history",
                                     params={"limit": 100})).json()
            check("history returned 2 rows", len(rows) == 2, f"got {len(rows)}")
            if len(rows) == 2:
                check("history sorted descending by sys_ts",
                      rows[0]["sys_ts"] >= rows[1]["sys_ts"])
                check("history contains both dev_ts",
                      {r_["dev_ts"] for r_ in rows} == {1000, 2000}, str(rows))
            empty = (await client.get(f"http://127.0.0.1:{WEB_PORT}/api/v1/history",
                                      params={"start_ts": 0, "end_ts": 0})).json()
            check("history range filter (empty range) returns 0", len(empty) == 0)

        dev_writer.close()
        await dev_writer.wait_closed()
    finally:
        if dev_writer:
            dev_writer.close()
        server.should_exit = True
        try:
            await asyncio.wait_for(serve_task, timeout=5.0)
        except Exception:
            pass
        await app.tcp.stop()
        await app.db.stop()

    print()
    if failures:
        print(f"E2E FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("E2E OK: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
