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
