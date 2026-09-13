"""FastAPI app: WebSocket live broadcast + HTTP history API.

Wiring:
- IngestServer (TCP 38888) -> on_sample -> persist (throttled) + broadcast (live)
- WebSocket /ws            -> global viewer set; 0->1 viewers => 10 Hz,
                              1->0 viewers  => 0.1 Hz (downstream control)
- GET /api/v1/history      -> query power_logs (time-descending)

Every sample is broadcast to viewers at full rate, but persistence is capped
at one row per `config.db_store_interval_ms` (default 10s) regardless of the
live sampling rate - storing all of it at 10 Hz would bloat the DB for no
benefit. No special-casing a rate transition: it's a plain "enough time
elapsed since the last stored row" gate, so the interval right around a
10Hz<->0.1Hz switch is simply whatever it is.
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from starlette.responses import FileResponse
from starlette.staticfiles import StaticFiles

from . import config
from . import protocol
from .db import Database
from .tcp import IngestServer

log = logging.getLogger("power_monitor.app")

# A firmware image is at most the size of one OTA partition (~1.65 MB on the
# C3's two-slot table); reject uploads far above it outright.
_OTA_MAX_BYTES = 3 * 1024 * 1024


class App:
    def __init__(self) -> None:
        self.db = Database(config.db_path,
                           batch_size=config.db_batch_size,
                           flush_interval=config.db_flush_interval)
        self.tcp = IngestServer(config.tcp_host, config.tcp_port,
                                self._on_sample, self._on_device_info, self._on_event)
        self._viewers: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._last_db_ts: Optional[int] = None
        # OCP host-threshold edge state: `self._host_over` is "current is
        # presently over the threshold" (so a sustained overcurrent records only
        # once, on the rising edge); `self._last_host_ocr` is the wall-clock ms of
        # the last host OCP event, gating re-records after a brief dip back over
        # (chatter guard - see _on_sample).
        self._host_over = False
        self._last_host_ocr: Optional[int] = None
        # Device-reported info (running firmware version + active OTA slot),
        # sent by the ESP32 once per connection. None until first seen.
        self._device_info: Optional[dict] = None
        # OTA: the uploaded firmware image, stored as (size, mtime) so the
        # status endpoint can report it without a disk stat on every poll.
        self._ota: Optional[tuple[int, float]] = None

        @asynccontextmanager
        async def lifespan(app: FastAPI) -> AsyncIterator[None]:
            await self.db.start()
            await self.tcp.start()
            # Idle until a viewer asks for 10 Hz.
            await self.tcp.send_set_interval(config.interval_slow_ms)
            try:
                yield
            finally:
                await self.tcp.stop()
                await self.db.stop()

        self.app = FastAPI(title="dynamic-power-monitor-backend", lifespan=lifespan)
        self.app.websocket("/ws")(self._ws)
        self.app.get("/api/v1/history")(self._history)
        self.app.get("/api/v1/alerts")(self._alerts)
        self.app.get("/healthz")(self._healthz)

        # OTA firmware: upload (.bin) -> stored on disk -> served to the ESP32
        # over HTTP for over-the-air update. Registered before the "/" static
        # mount so they take precedence.
        self.app.get("/ota/firmware.bin")(self._ota_serve)
        self.app.post("/ota/upload")(self._ota_upload)
        self.app.get("/ota/status")(self._ota_status)
        self.app.post("/ota/update")(self._ota_update)

        # Built dashboard assets (python/web/), served same-origin. Mounted
        # last so it can never shadow the routes above. Skipped (not a
        # crash) if the frontend hasn't been built yet - App() is
        # constructed at import time (the module-level singleton below, and
        # a second instance in tests/e2e.py), so this must never raise.
        if config.web_dist_dir.is_dir():
            self.app.mount("/", StaticFiles(directory=config.web_dist_dir, html=True), name="web")
        else:
            log.warning(
                "web dist dir %s not found; skipping static mount "
                "(run `cd web && npm install && npm run build`)",
                config.web_dist_dir,
            )

    # -- ingest fan-out ------------------------------------------------------
    async def _on_sample(self, dev_ts: int, voltage: float, current: float, power_mw: float) -> None:
        sys_ts = int(time.time() * 1000)
        # Persist at most once per db_store_interval_ms - independent of the
        # live sampling rate. The broadcast below is never throttled.
        if self._last_db_ts is None or sys_ts - self._last_db_ts >= config.db_store_interval_ms:
            await self.db.put((sys_ts, dev_ts, voltage, current, power_mw))
            self._last_db_ts = sys_ts
        # Backend OCP threshold (one of the two detection paths; the INA226
        # ALERT pin is the other). Edge-triggered: a sustained overcurrent
        # records once on the rising edge; it re-arms when current drops back
        # below the threshold, and ocp_rearm_ms guards against chatter that
        # straddles the edge.
        if current > config.ocp_threshold_ma:
            if not self._host_over:
                self._host_over = True
                if self._last_host_ocr is None or sys_ts - self._last_host_ocr >= config.ocp_rearm_ms:
                    await self.db.put_event(sys_ts, dev_ts, "host",
                                            protocol.EVENT_TYPE_SHUNT_OCP,
                                            voltage, current, power_mw)
                    self._last_host_ocr = sys_ts
                    log.warning("OCP (host): %.0f mA > %.0f mA threshold -> event",
                                current, config.ocp_threshold_ma)
        else:
            self._host_over = False
        payload = {
            "sys_ts": sys_ts,
            "dev_ts": dev_ts,
            "voltage": voltage,
            "current": current,
            "power": power_mw,
        }
        if self._viewers:
            dead: list[WebSocket] = []
            for ws in list(self._viewers):
                try:
                    await ws.send_json(payload)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._viewers.discard(ws)

    # -- sampling control from viewer count ----------------------------------
    async def _on_device_info(self, version: str, slot: int) -> None:
        """Store the running firmware version + active slot the device reported."""
        info = {"firmware_version": version, "ota_slot": slot}
        if self._device_info != info:
            log.info("device info: v%s on slot=%d", version, slot)
            self._device_info = info

    async def _on_event(self, etype: int, dev_ts: int, voltage: float, current: float, power_mw: float) -> None:
        """Persist an overcurrent event pushed by the device (INA226 ALERT pin).

        This is the hardware detection path; the host-threshold path records in
        _on_sample. Both land in ocp_events, distinguished by `source`.
        """
        sys_ts = int(time.time() * 1000)
        await self.db.put_event(sys_ts, dev_ts, "device", etype,
                                voltage, current, power_mw)
        log.warning("OCP (device ALERT): I=%.0f mA V=%.3f P=%.1f mW -> event",
                    current, voltage, power_mw)

    async def _set_viewers(self, count: int) -> None:
        if count > 0:
            await self.tcp.send_set_interval(config.interval_fast_ms)
        else:
            await self.tcp.send_set_interval(config.interval_slow_ms)

    # -- websocket -----------------------------------------------------------
    async def _ws(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            was_empty = not self._viewers
            self._viewers.add(ws)
            new_count = len(self._viewers)
        if was_empty:
            log.info("first viewer -> 10 Hz")
            await self._set_viewers(new_count)
        try:
            while True:
                # The client only reads from us; loop on inbound frames until it leaves.
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with self._lock:
                self._viewers.discard(ws)
                new_count = len(self._viewers)
            if new_count == 0:
                log.info("last viewer left -> 0.1 Hz")
            await self._set_viewers(new_count)

    # -- history -------------------------------------------------------------
    async def _history(
        self,
        start_ts: Optional[int] = Query(None, ge=0),
        end_ts: Optional[int] = Query(None, ge=0),
        limit: int = Query(500, ge=1, le=5000),
    ):
        return await self.db.query_history(start_ts=start_ts, end_ts=end_ts, limit=limit)

    async def _alerts(
        self,
        start_ts: Optional[int] = Query(None, ge=0),
        end_ts: Optional[int] = Query(None, ge=0),
        limit: int = Query(200, ge=1, le=1000),
    ):
        """Overcurrent (OCP) events from either detection path, time-descending."""
        return await self.db.query_events(start_ts=start_ts, end_ts=end_ts, limit=limit)

    async def _healthz(self):
        return {"status": "ok", "device": self.tcp.online, "viewers": len(self._viewers)}

    # -- OTA (firmware) -------------------------------------------------------
    def _ota_bin_path(self) -> Path:
        return config.ota_dir / config.ota_bin_name

    async def _ota_serve(self):
        """Serve the uploaded image to the ESP32 (the OTA download target).

        This is the `http://<this host>:38000/ota/firmware.bin` the firmware
        GETs after it receives the start-OTA control frame.
        """
        path = self._ota_bin_path()
        if not path.is_file():
            raise HTTPException(404, "no firmware uploaded yet (POST /ota/upload)")
        return FileResponse(path, media_type="application/octet-stream",
                            filename=config.ota_bin_name)

    async def _ota_upload(self, file: UploadFile):
        """Store an uploaded .bin as the pending firmware image (overwrites)."""
        data = await file.read()
        if len(data) == 0:
            raise HTTPException(400, "empty upload")
        if len(data) > _OTA_MAX_BYTES:
            raise HTTPException(413, f"firmware too large (> {_OTA_MAX_BYTES} bytes)")
        config.ota_dir.mkdir(parents=True, exist_ok=True)
        path = self._ota_bin_path()
        path.write_bytes(data)
        self._ota = (path.stat().st_size, path.stat().st_mtime)
        log.info("OTA: stored %s (%d bytes)", path, self._ota[0])
        return {"ok": True, "size": self._ota[0], "path": str(path)}

    async def _ota_status(self):
        """Firmware image availability + device connectivity + running firmware.

        `firmware_version` / `ota_slot` are the device-reported values (running
        firmware + active slot); they are None until the device has connected and
        sent its one-time device-info frame.
        """
        path = self._ota_bin_path()
        st = path.stat() if path.is_file() else None
        available = st is not None
        # Prefer the in-memory record (set on upload); fall back to the file.
        size = self._ota[0] if (available and self._ota) else (st.st_size if st else None)
        mtime = self._ota[1] if (available and self._ota) else (st.st_mtime if st else None)
        info = self._device_info or {}
        return {
            "available": available,
            "size": size,
            "mtime": int(mtime) if mtime else None,
            "device_online": self.tcp.online,
            "firmware_version": info.get("firmware_version"),
            "ota_slot": info.get("ota_slot"),
        }

    async def _ota_update(self):
        """Push the start-OTA command to the connected device.

        The firmware then downloads /ota/firmware.bin and reboots into it.
        """
        if not self._ota_bin_path().is_file():
            raise HTTPException(409, "no firmware uploaded yet (POST /ota/upload)")
        if not self.tcp.online:
            raise HTTPException(409, "device is offline - cannot start OTA")
        if not await self.tcp.send_start_ota():
            raise HTTPException(502, "failed to send OTA command to device")
        log.info("OTA: start command sent to device")
        return {"ok": True, "message": "device will reboot into the new firmware"}


_app = App()
app = _app.app
