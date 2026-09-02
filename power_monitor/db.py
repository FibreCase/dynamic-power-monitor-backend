"""SQLite persistence, decoupled from ingest by an asyncio queue.

A single background writer drains the queue and batch-commits when it has
collected `batch_size` rows OR `flush_interval` seconds have elapsed with a
partial buffer. WAL + synchronous=NORMAL give fast sequential writes. All
blocking SQLite calls run in the thread pool; a lock serializes them (the
writer and history queries may otherwise land on different worker threads).
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Optional

log = logging.getLogger("power_monitor.db")

CREATE_TABLE = (
    "CREATE TABLE IF NOT EXISTS power_logs ("
    " id      INTEGER PRIMARY KEY AUTOINCREMENT,"
    " sys_ts  INTEGER NOT NULL,"
    " dev_ts  INTEGER NOT NULL,"
    " voltage REAL    NOT NULL,"
    " current REAL    NOT NULL,"
    " power   REAL    NOT NULL)"
)
CREATE_INDEX = "CREATE INDEX IF NOT EXISTS idx_power_logs_sys_ts ON power_logs (sys_ts)"
INSERT_SQL = (
    "INSERT INTO power_logs (sys_ts, dev_ts, voltage, current, power) "
    "VALUES (?, ?, ?, ?, ?)"
)


class Database:
    def __init__(self, db_path: Path, batch_size: int = 50, flush_interval: float = 2.0):
        self._db_path = Path(db_path)
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._queue: asyncio.Queue = asyncio.Queue()
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        await asyncio.to_thread(self._init_db)
        self._task = asyncio.create_task(self._writer(), name="db-writer")

    def _init_db(self) -> None:
        with self._lock:
            self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._conn.execute(CREATE_TABLE)
            self._conn.execute(CREATE_INDEX)
            self._conn.commit()
        log.info("sqlite ready at %s (WAL, sync=NORMAL)", self._db_path)

    async def put(self, row: tuple[int, int, float, float, float]) -> None:
        """Enqueue one (sys_ts, dev_ts, voltage, current, power) sample."""
        await self._queue.put(row)

    async def _flush(self, rows: list[tuple]) -> None:
        def _do() -> None:
            with self._lock:
                assert self._conn is not None
                self._conn.executemany(INSERT_SQL, rows)
                self._conn.commit()
        await asyncio.to_thread(_do)

    async def _writer(self) -> None:
        buf: list[tuple] = []
        while True:
            if not buf:
                try:
                    buf.append(await asyncio.wait_for(self._queue.get(),
                                                      timeout=self._flush_interval))
                except asyncio.TimeoutError:
                    continue
            # Drain whatever is already queued up to the batch size.
            while len(buf) < self._batch_size:
                try:
                    buf.append(self._queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            if len(buf) >= self._batch_size:
                await self._flush(buf)
                buf = []
                continue
            # Partial buffer: wait for more rows or flush after the interval.
            try:
                buf.append(await asyncio.wait_for(self._queue.get(),
                                                  timeout=self._flush_interval))
            except asyncio.TimeoutError:
                await self._flush(buf)
                buf = []

    async def query_history(
        self,
        start_ts: Optional[int] = None,
        end_ts: Optional[int] = None,
        limit: int = 500,
    ) -> list[dict]:
        limit = max(1, min(int(limit), 5000))

        def _do() -> list[tuple]:
            sql = "SELECT sys_ts, dev_ts, voltage, current, power FROM power_logs"
            clauses: list[str] = []
            params: list = []
            if start_ts is not None:
                clauses.append("sys_ts >= ?"); params.append(int(start_ts))
            if end_ts is not None:
                clauses.append("sys_ts <= ?"); params.append(int(end_ts))
            if clauses:
                sql += " WHERE " + " AND ".join(clauses)
            sql += " ORDER BY sys_ts DESC, id DESC LIMIT ?"
            params.append(limit)
            with self._lock:
                assert self._conn is not None
                return self._conn.execute(sql, params).fetchall()

        rows = await asyncio.to_thread(_do)
        return [
            {"sys_ts": r[0], "dev_ts": r[1], "voltage": r[2], "current": r[3], "power": r[4]}
            for r in rows
        ]

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # Drain whatever is still queued (best effort) and close the connection.
        remaining: list[tuple] = []
        while not self._queue.empty():
            try:
                remaining.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if remaining:
            await self._flush(remaining)

        def _close() -> None:
            with self._lock:
                if self._conn is not None:
                    self._conn.close()
                    self._conn = None
        await asyncio.to_thread(_close)
