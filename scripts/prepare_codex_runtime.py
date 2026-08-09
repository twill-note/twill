"""Download and verify the latest official Codex runtime for desktop packaging."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.plugins.codex_assistant.codex_cli import download_latest_codex_runtime  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "frontend" / "build" / "codex-runtime",
    )
    args = parser.parse_args()
    installation = download_latest_codex_runtime(args.output)
    print(f"[codex] Bundled Codex CLI {installation.version}: {installation.binary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
