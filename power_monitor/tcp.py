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
import time

from . import config
from . import protocol

log = logging.getLogger("power_monitor.tcp")


class IngestServer:
    def __init__(self, host: str, port: int, on_sample, on_device_info=None, on_event=None):
        self._host = host
        self._port = port
        self._on_sample = on_sample              # async (dev_ts, v, i, p) -> None
        self._on_device_info = on_device_info    # async (version, slot) -> None (optional)
        self._on_event = on_event                # async (type, dev_ts, v, i, p) -> None (optional)
        self._server: asyncio.Server | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected = False
        self._last_rx: float = 0.0               # monotonic time of the last frame seen
        self._liveness_s = config.device_liveness_s
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    @property
    def connected(self) -> bool:
        """True if a device TCP socket is currently open.

        This is the raw "socket exists" flag. Use :pyattr:`online` for the
        user-facing liveness state (connected AND recently receiving frames).
        """
        return self._connected

    @property
    def online(self) -> bool:
        """Liveness: the link is open AND a frame arrived within the liveness window.

        Catches the two cases `connected` alone misses: a half-open socket that
        never closed (powered-off / dropped device), and a connected device that
        has stopped sending. A healthy idle device still sends a sample every
        10 s, well inside the default 30 s window, so it never reads offline.
        """
        if not self._connected:
            return False
        return (time.monotonic() - self._last_rx) <= self._liveness_s

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
                s = writer.get_extra_info("socket")
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                # Reap half-open connections: if the device loses power / WiFi /
                # the LAN partitions, no FIN ever arrives. Without keepalive
                # reader.read() would block for the OS retransmit timeout
                # (minutes). Idle 20s then probe every 5s x4 => dead peer ~40s.
                s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 20)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 5)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 4)
            except OSError:
                pass
            self._connected = True
            self._last_rx = time.monotonic()
        log.info("ESP32 connected (%s:%s)",
                 writer.get_extra_info("peername"))

        buf = b""
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                buf += data
                # Consume every complete frame (sample / device-info / OCP event)
                # in the buffer. The header byte pair selects the frame type and
                # its size; a bad header or checksum drops one byte and rescans so
                # we resync through any garbage without losing the stream.
                while len(buf) >= 2:
                    hdr = buf[0:2]
                    if hdr == protocol.SAMPLE_HEADER:
                        size = protocol.SAMPLE_SIZE
                    elif hdr == protocol.INFO_HEADER:
                        size = protocol.INFO_SIZE
                    elif hdr == protocol.EVENT_HEADER:
                        size = protocol.EVENT_SIZE
                    else:
                        # Lost sync: drop one byte and rescan.
                        buf = buf[1:]
                        continue
                    if len(buf) < size:
                        break  # partial frame: wait for more bytes
                    frame = buf[:size]
                    self._last_rx = time.monotonic()
                    if hdr == protocol.SAMPLE_HEADER:
                        parsed = protocol.parse_sample(frame)
                        if parsed is None:
                            buf = buf[1:]
                            continue
                        buf = buf[size:]
                        dev_ts, voltage, current, power = parsed
                        await self._on_sample(dev_ts, voltage, current, power)
                    elif hdr == protocol.INFO_HEADER:
                        parsed = protocol.parse_device_info(frame)
                        if parsed is None:
                            buf = buf[1:]
                            continue
                        buf = buf[size:]
                        if self._on_device_info is not None:
                            version, slot = parsed
                            await self._on_device_info(version, slot)
                    else:  # EVENT_HEADER
                        parsed = protocol.parse_event(frame)
                        if parsed is None:
                            buf = buf[1:]
                            continue
                        buf = buf[size:]
                        if self._on_event is not None:
                            etype, dev_ts, voltage, current, power = parsed
                            await self._on_event(etype, dev_ts, voltage, current, power)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        finally:
            # Clear state only if we still own the current connection. The device
            # reconnects frequently (every 2 s on any blip); the *old* handler is
            # woken by the new one closing its socket and runs this finally AFTER
            # the new handler has already set _connected=True. Clearing
            # unconditionally there clobbers the fresh connection -> the UI showed
            # offline while the device was actually streaming.
            if self._writer is writer:
                self._reader, self._writer = None, None
                self._connected = False
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
