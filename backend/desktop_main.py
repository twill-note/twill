"""Standalone entry point used by the packaged Electron application."""

from __future__ import annotations

import argparse
import multiprocessing

import uvicorn

from app.main import app as twill_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Twill local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(twill_app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
