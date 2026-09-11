# dynamic-power-monitor-backend

Async TCP ingest + FastAPI WebSocket/HTTP backend for a 12V power monitor,
plus a bundled web dashboard. Receives 20-byte binary samples from an
ESP32-C3 over a long-lived TCP connection, persists them to SQLite, and
serves them to browsers over a WebSocket (live) and an HTTP history API.

This directory is a standalone component (its own git repo, embedded as a
submodule in [dynamic-power-monitor](https://github.com/FibreCase/dynamic-power-monitor)).
The full protocol spec and firmware side live there — see that repo's
`TASK.md` and `CLAUDE.md` if you need the wire-format details or are working
on the ESP32 firmware.

## Requirements

- Python >= 3.10, managed with [uv](https://docs.astral.sh/uv/)
- Node.js + npm, only if you want to build/develop the dashboard (`web/`)

## Quick start

```bash
uv sync
uv run uvicorn power_monitor.app:app --host 0.0.0.0 --port 8000
# or: uv run power-monitor
```

- TCP ingest listens on port `8888` — point the ESP32 firmware's
  `CFG_HOST_IP`/`CFG_HOST_PORT` at this host.
- `ws://<host>:8000/ws` — live sample broadcast. Opening the first viewer
  connection bumps the device to 10 Hz sampling; the last viewer leaving
  drops it back to 0.1 Hz.
- `GET /api/v1/history?start_ts=&end_ts=&limit=` — persisted samples,
  descending by time (`limit` default 500, max 5000).
- `GET /healthz` — `{"status", "device": <bool>, "viewers": <int>}`.
- `GET /` — the dashboard, once built (see below).

## Configuration

All tunables are `PM_*` environment variables (see `power_monitor/config.py`):

| Variable | Default | Meaning |
|---|---|---|
| `PM_TCP_HOST` | `0.0.0.0` | TCP ingest bind address |
| `PM_TCP_PORT` | `8888` | TCP ingest port (the ESP32 connects here) |
| `PM_DB_PATH` | `data/power.db` | SQLite file path |
| `PM_INTERVAL_FAST_MS` | `100` | Sampling interval pushed when a viewer is present (10 Hz) |
| `PM_INTERVAL_SLOW_MS` | `10000` | Sampling interval pushed when idle (0.1 Hz) |
| `PM_DB_BATCH_SIZE` | `50` | Rows per batch commit |
| `PM_DB_FLUSH_INTERVAL` | `2.0` | Max seconds before a partial batch flushes |
| `PM_DB_STORE_INTERVAL_MS` | `10000` | Max SQLite write rate, independent of the live sampling rate (every sample is still broadcast over `/ws` at full rate) |
| `PM_WEB_DIST` | `web/dist` | Built dashboard assets served at `/` (skipped with a warning if missing) |

## Project layout

```
power_monitor/
├── protocol.py   # wire format: 20-byte sample decode, 8-byte control pack, checksum
├── tcp.py        # IngestServer: asyncio TCP server, sticky/partial-frame reassembly
├── db.py         # SQLite persistence (WAL), queue-decoupled batch writer
├── app.py        # FastAPI: /ws, /api/v1/history, /healthz, + dashboard static mount
├── config.py     # PM_* environment variables
└── cli.py        # `power-monitor` entry point (runs uvicorn)
web/              # React + Vite + ECharts dashboard (see web/'s own build steps below)
scripts/
└── watch_ws.py   # example: tail the live /ws feed from a terminal
tests/
└── e2e.py        # fake-ESP32-over-TCP + WS viewer, no hardware needed
```

## Dashboard (`web/`)

A two-tab single-page app — **实时监控** (live, WebSocket-driven chart) and
**历史查询** (history, queries `/api/v1/history`) — built with React, Vite,
and ECharts.

```bash
cd web
npm install
npm run build       # -> web/dist/, served by the backend at "/"
```

For hot-reload development against a running backend:

```bash
cd web
npm run dev          # http://localhost:5173, proxies /api, /ws, /healthz -> :8000
```

## Testing

```bash
uv run python -m tests.e2e
```

Spins up the real `IngestServer`/`Database`/FastAPI app, feeds it fake
20-byte sample frames over TCP, and checks the WS broadcast, downstream
interval control, and history API end to end — no hardware required.

## Scripts

```bash
uv run python scripts/watch_ws.py               # tail ws://127.0.0.1:8000/ws
uv run python scripts/watch_ws.py --raw          # print raw JSON instead
uv run python scripts/watch_ws.py --url ws://<host>:8000/ws
```
