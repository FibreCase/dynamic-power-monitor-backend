"""FastAPI app: WebSocket live broadcast + HTTP history API.

Wiring:
- IngestServer (TCP 8888)  -> on_sample -> persist + broadcast
- WebSocket /ws            -> global viewer set; 0->1 viewers => 10 Hz,
                              1->0 viewers  => 0.1 Hz (downstream control)
- GET /api/v1/history      -> query power_logs (time-descending)
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect

from . import config
from .db import Database
from .tcp import IngestServer

log = logging.getLogger("power_monitor.app")


class App:
    def __init__(self) -> None:
        self.db = Database(config.db_path,
                           batch_size=config.db_batch_size,
                           flush_interval=config.db_flush_interval)
        self.tcp = IngestServer(config.tcp_host, config.tcp_port, self._on_sample)
        self._viewers: set[WebSocket] = set()
        self._lock = asyncio.Lock()

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
        self.app.get("/healthz")(self._healthz)

    # -- ingest fan-out ------------------------------------------------------
    async def _on_sample(self, dev_ts: int, voltage: float, current: float, power_mw: float) -> None:
        sys_ts = int(time.time() * 1000)
        await self.db.put((sys_ts, dev_ts, voltage, current, power_mw))
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

    async def _healthz(self):
        return {"status": "ok", "device": self.tcp.connected, "viewers": len(self._viewers)}


_app = App()
app = _app.app
