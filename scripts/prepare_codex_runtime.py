"""Download and verify the latest official Codex runtime for desktop packaging."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.plugins.codex_assistant.codex_cli import download_latest_codex_runtime, _read_version, CodexInstallation  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "frontend" / "build" / "codex-runtime",
    )
    parser.add_argument('--reuse-existing', action='store_true', help='Validate and reuse the existing runtime for an offline build')
    args = parser.parse_args()
    if args.reuse_existing:
        binary = args.output / 'bin' / ('codex.exe' if os.name == 'nt' else 'codex')
        version = _read_version(binary)
        if not version:
            raise RuntimeError('No working Codex runtime is available for this platform.')
        installation = CodexInstallation(str(binary.resolve()), version, 'bundled')
        print('[codex] Reusing the existing runtime for an offline build.')
    else:
        installation = download_latest_codex_runtime(args.output)
    print(f"[codex] Bundled Codex CLI {installation.version}: {installation.binary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
