# dynamic-power-monitor-backend

[English](README.md) | [中文](README_zh.md)

Async **TCP ingest + FastAPI** backend for the
[12V power monitor](https://github.com/FibreCase/dynamic-power-monitor), with a
bundled web dashboard. It receives fixed-size binary frames from an ESP32-C3 over
a long-lived TCP connection, persists them to SQLite, and serves them to browsers
over a WebSocket (live) and HTTP APIs (history, OTA, overcurrent alerts).

This directory is a standalone component (its own git repo, embedded as a
**submodule** in [`dynamic-power-monitor`](https://github.com/FibreCase/dynamic-power-monitor)).
The ESP32 firmware and the full hardware context live in that parent repo — see
its `README.md` / `CLAUDE.md` for the wire format and device side.

![Web dashboard — 实时监控 (live view)](assets/web.png)

## What it does

- **Ingest** — reassembles sticky/partial TCP frames into the fixed-size upstream
  frames (20-byte **sample**, 37-byte **device-info**, 25-byte **OCP event**),
  checksum-verifying each.
- **Persist** — writes samples to SQLite (WAL) through a queue-decoupled batch
  writer, so ingest never blocks on disk.
- **Broadcast** — pushes every sample to WebSocket viewers at full rate; the
  first viewer opens switches the device to 10 Hz sampling, the last viewer
  leaving drops it back to 0.1 Hz.
- **Detect overcurrent** — flags a sample whose current exceeds the configured
  threshold (the backend half of OCP; the firmware's INA226 ALERT is the other
  half) and records the event.
- **OTA** — stores an uploaded firmware `.bin` and serves it at the path the
  device downloads from; a single call triggers the device to update.
- **Serve the dashboard** — the built `web/` assets are mounted same-origin at `/`.

## Requirements

- Python ≥ 3.10, managed with [uv](https://docs.astral.sh/uv/)
- Node.js + npm, only if you want to build/develop the dashboard (`web/`)

## Quick start

```bash
uv sync
uv run power-monitor
```

- **TCP ingest** listens on port `38888` — point the firmware's
  `CFG_HOST_IP`/`CFG_HOST_PORT` at this host.
- **`ws://<host>:38000/ws`** — live sample broadcast.
- **`GET /api/v1/history?start_ts=&end_ts=&limit=`** — persisted samples,
  descending by time (`limit` default 500, max 5000).
- **`GET /api/v1/alerts?start_ts=&end_ts=&limit=`** — overcurrent events,
  descending by time (`limit` default 200, max 1000).
- **`GET /ota/status`** — `{available, size, mtime, device_online,
  firmware_version, ota_slot}`.
- **`POST /ota/upload`** (multipart `file`), **`POST /ota/update`**,
  **`GET /ota/firmware.bin`** — OTA upload / trigger / download.
- **`GET /healthz`** — `{"status", "device": <bool>, "viewers": <int>}`.
- **`GET /`** — the dashboard, once built (see below).

## Configuration

All tunables are `PM_*` environment variables (see `power_monitor/config.py`):

| Variable | Default | Meaning |
|---|---|---|
| `PM_TCP_HOST` | `0.0.0.0` | TCP ingest bind address |
| `PM_TCP_PORT` | `38888` | TCP ingest port (the ESP32 connects here) |
| `PM_HTTP_HOST` | `0.0.0.0` | Dashboard/API listen address (uvicorn) |
| `PM_HTTP_PORT` | `38000` | Dashboard/API + WebSocket + OTA port (uvicorn) |
| `PM_DB_PATH` | `data/power.db` | SQLite file path |
| `PM_INTERVAL_FAST_MS` | `100` | Sampling interval pushed when a viewer is present (10 Hz) |
| `PM_INTERVAL_SLOW_MS` | `10000` | Sampling interval pushed when idle (0.1 Hz) |
| `PM_DEVICE_LIVENESS_S` | `30` | A device is "online" only if connected *and* a frame arrived within this many seconds |
| `PM_DB_BATCH_SIZE` | `50` | Rows per batch commit |
| `PM_DB_FLUSH_INTERVAL` | `2.0` | Max seconds before a partial batch flushes |
| `PM_DB_STORE_INTERVAL_MS` | `10000` | Max SQLite sample write rate, independent of the live sampling rate (every sample is still broadcast over `/ws` at full rate) |
| `PM_OCP_THRESHOLD_MA` | `2500` | Backend overcurrent threshold (mA) — the host-side half of OCP |
| `PM_OCP_REARM_MS` | `5000` | Min gap between re-records of a sustained overcurrent (chatter guard) |
| `PM_WEB_DIST` | `web/dist` | Built dashboard assets served at `/` (skipped with a warning if missing) |
| `PM_OTA_DIR` | `ota/` | Where an uploaded firmware `.bin` is stored |
| `PM_OTA_BIN_NAME` | `firmware.bin` | Stored image filename (served at `/ota/<name>`) |

## Project layout

```
power_monitor/
├── protocol.py   # wire format: 20-byte sample, 37-byte device-info, 25-byte OCP event, 8-byte control pack
├── tcp.py        # IngestServer: asyncio TCP server, header-dispatched reassembly, liveness, keepalive
├── db.py         # SQLite (WAL): power_logs + ocp_events, queue-decoupled batch writer
├── app.py        # FastAPI: /ws, /api/v1/history, /api/v1/alerts, /ota/*, /healthz, + dashboard static mount
├── config.py     # PM_* environment variables
└── cli.py        # `power-monitor` entry point (runs uvicorn)
web/              # React + Vite + ECharts dashboard
scripts/
└── watch_ws.py   # example: tail the live /ws feed from a terminal
tests/
└── e2e.py        # fake-ESP32-over-TCP + WS viewer, no hardware needed
```

## Dashboard (`web/`)

A four-tab single-page app — **实时监控** (live, WebSocket-driven chart),
**历史查询** (history), **异常日志** (overcurrent log), and **固件更新** (OTA) —
built with React, Vite, and ECharts.

```bash
cd web
npm install
npm run build       # -> web/dist/, served by the backend at "/"
```

For hot-reload development against a running backend:

```bash
cd web
npm run dev         # http://localhost:5173, proxies /api, /ws, /healthz, /ota -> :38000
```

## Testing

```bash
uv run python -m tests.e2e
```

Spins up the real `IngestServer`/`Database`/FastAPI app, feeds it fake upstream
frames over TCP, and checks the WS broadcast, downstream interval control,
history, OTA, and both OCP detection paths (device ALERT event + host threshold,
including the edge-triggered dedup) end to end — no hardware required.

## Scripts

```bash
uv run python scripts/watch_ws.py               # tail ws://127.0.0.1:38000/ws
uv run python scripts/watch_ws.py --raw          # print raw JSON instead
uv run python scripts/watch_ws.py --url ws://<host>:38000/ws
```
