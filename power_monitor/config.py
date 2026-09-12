"""Runtime configuration. Values can be overridden with environment variables."""
from __future__ import annotations

import os
from pathlib import Path

# Where the SQLite file lives (defaults to <package parent>/data/).
_BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = _BASE_DIR / "data" / "power.db"

def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)

def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))

tcp_host: str = _env("PM_TCP_HOST", "0.0.0.0")
tcp_port: int = _env_int("PM_TCP_PORT", 8888)

db_path: Path = Path(_env("PM_DB_PATH", str(DEFAULT_DB_PATH)))

# Sampling intervals pushed to the ESP32 (ms).
interval_fast_ms: int = _env_int("PM_INTERVAL_FAST_MS", 100)    # 10 Hz
interval_slow_ms: int = _env_int("PM_INTERVAL_SLOW_MS", 10000)  # 0.1 Hz

# Persistence tuning.
db_batch_size: int = _env_int("PM_DB_BATCH_SIZE", 50)
db_flush_interval: float = float(_env("PM_DB_FLUSH_INTERVAL", "2.0"))

# Max rate at which samples are written to SQLite, regardless of the live
# sampling rate (10 Hz active / 0.1 Hz idle) - the WS broadcast to viewers is
# never throttled, only persistence. No smoothing across a rate change: this
# is a simple "has enough time passed since the last stored row" gate.
db_store_interval_ms: int = _env_int("PM_DB_STORE_INTERVAL_MS", 10000)

# Web dashboard (built frontend assets, served statically by app.py).
web_dist_dir: Path = Path(_env("PM_WEB_DIST", str(_BASE_DIR / "web" / "dist")))

# OTA firmware storage. An uploaded .bin is written here and served back to the
# ESP32 for over-the-air updates (see app.py /ota/*). Keep it on a path the
# ESP32 can reach over the LAN (default: <package parent>/ota/).
ota_dir: Path = Path(_env("PM_OTA_DIR", str(_BASE_DIR / "ota")))
ota_bin_name: str = _env("PM_OTA_BIN_NAME", "firmware.bin")
