"""Standalone entry point used by the packaged Electron application."""

from __future__ import annotations

import argparse
import multiprocessing
import os

import uvicorn

from app.main import app as twill_app
from app.desktop_lifecycle import own_windows_process_tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Twill local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    job = own_windows_process_tree() if os.environ.get("NOTE_APP_DESKTOP") == "1" else None
    server = uvicorn.Server(uvicorn.Config(
        twill_app, host=args.host, port=args.port, log_level="info", timeout_graceful_shutdown=3,
    ))
    twill_app.state.request_shutdown = lambda: setattr(server, "should_exit", True)
    server.run()
    # Process exit closes the retained job handle and reaps Windows descendants.
    _ = job


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
