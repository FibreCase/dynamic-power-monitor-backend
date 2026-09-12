"""Async TCP ingest server.

Listens on the TCP port with TCP_NODELAY and keeps one long-lived connection
to the ESP32. Incoming bytes are reassembled with a sliding buffer to absorb
sticky / partial packets; complete 20-byte frames are checksum-verified and
decoded. The single open device connection also carries downstream control
packets (set sampling interval).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import socket

from . import protocol

log = logging.getLogger("power_monitor.tcp")


class IngestServer:
    def __init__(self, host: str, port: int, on_sample):
        self._host = host
        self._port = port
        self._on_sample = on_sample          # async (sys_ts, dev_ts, v, i, p) -> None
        self._server: asyncio.Server | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected = False
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_client, self._host, self._port
        )
        log.info("TCP ingest listening on %s:%s", self._host, self._port)

    async def stop(self) -> None:
        if self._writer is not None:
            with contextlib.suppress(Exception):
                self._writer.close()
                await self._writer.wait_closed()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # Keep only one device connection alive; close any previous one.
        async with self._lock:
            if self._writer is not None and self._writer is not writer:
                with contextlib.suppress(Exception):
                    self._writer.close()
            self._reader, self._writer = reader, writer
            try:
                writer.get_extra_info("socket").setsockopt(
                    socket.IPPROTO_TCP, socket.TCP_NODELAY, 1
                )
            except OSError:
                pass
            self._connected = True
        log.info("ESP32 connected (%s:%s)",
                 writer.get_extra_info("peername"))

        buf = b""
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                buf += data
                # Consume every complete sample frame in the buffer.
                while len(buf) >= protocol.SAMPLE_SIZE:
                    frame = buf[:protocol.SAMPLE_SIZE]
                    if frame[0:2] != protocol.SAMPLE_HEADER:
                        # Lost sync: drop one byte and rescan.
                        buf = buf[1:]
                        continue
                    parsed = protocol.parse_sample(frame)
                    if parsed is None:
                        # Bad checksum: resync.
                        buf = buf[1:]
                        continue
                    buf = buf[protocol.SAMPLE_SIZE:]
                    dev_ts, voltage, current, power = parsed
                    await self._on_sample(dev_ts, voltage, current, power)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        finally:
            self._connected = False
            if self._writer is writer:
                self._reader, self._writer = None, None
            log.info("ESP32 disconnected")

    async def send_control(self, frame: bytes) -> bool:
        """Send a raw 8-byte control frame to the connected device.

        False if there is no link. Callers pass a frame built in protocol
        (e.g. build_control_set_interval / build_control_start_ota).
        """
        if self._writer is None:
            return False
        try:
            self._writer.write(frame)
            await self._writer.drain()
            return True
        except (OSError, ConnectionResetError):
            return False

    async def send_set_interval(self, interval_ms: int) -> bool:
        """Send an 8-byte 'set sampling interval' control frame. False if no link."""
        return await self.send_control(protocol.build_control_set_interval(interval_ms))

    async def send_start_ota(self) -> bool:
        """Send the 8-byte 'start OTA update' control frame. False if no link.

        Triggers the firmware to download the .bin over HTTP (see app.py's
        /ota routes) and reboot into it.
        """
        return await self.send_control(protocol.build_control_start_ota())
