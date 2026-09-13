"""Small CLI: run the FastAPI app with uvicorn.

The HTTP listen address defaults to the PM_HTTP_HOST / PM_HTTP_PORT environment
variables (see config.py); the --host / --port flags override them when given.
"""
from __future__ import annotations

import argparse

import uvicorn

from . import config


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the power-monitor backend")
    parser.add_argument(
        "--host",
        default=config.http_host,
        help="HTTP bind address (default: $PM_HTTP_HOST, else 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=config.http_port,
        help="HTTP port (default: $PM_HTTP_PORT, else 38000)",
    )
    parser.add_argument("--reload", action="store_true", help="auto-reload (dev only)")
    args = parser.parse_args()
    uvicorn.run(
        "power_monitor.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
