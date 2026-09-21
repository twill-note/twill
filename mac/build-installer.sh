#!/usr/bin/env bash
# Build a self-contained macOS DMG. Run this script on the target Mac architecture.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_PYTHON="$BACKEND_DIR/.venv/bin/python"
BACKEND_OUTPUT="$FRONTEND_DIR/build/backend"

echo "[package] Preparing development dependencies..."
"$SCRIPT_DIR/setup.sh"

echo "[package] Installing the backend packager..."
"$VENV_PYTHON" -m pip install 'pyinstaller==6.16.0'

echo "[package] Downloading the latest official Codex CLI runtime..."
"$VENV_PYTHON" "$ROOT_DIR/scripts/prepare_codex_runtime.py"

echo "[package] Building the frontend..."
(cd "$FRONTEND_DIR" && npm run build)

echo "[package] Building the standalone backend..."
rm -rf "$BACKEND_OUTPUT"
"$VENV_PYTHON" -m PyInstaller \
  --noconfirm \
  --clean \
  --onedir \
  --name twill-backend \
  --distpath "$BACKEND_OUTPUT" \
  --workpath "$BACKEND_DIR/build/pyinstaller" \
  --specpath "$BACKEND_DIR/build" \
  --paths "$BACKEND_DIR" \
  --collect-submodules app \
  --add-data "$ROOT_DIR/skillbook:skillbook" \
  --add-data "$BACKEND_DIR/app/system_manual:backend/app/system_manual" \
  "$BACKEND_DIR/desktop_main.py"

echo "[package] Building the macOS disk image..."
(cd "$FRONTEND_DIR" && npm run dist:mac)

DMG="$(find "$FRONTEND_DIR/release" -maxdepth 1 -name 'Twill-*.dmg' -print | sort | tail -n 1)"
if [[ -z "$DMG" ]]; then
  echo "[error] The DMG was not created." >&2
  exit 1
fi
echo "[package] Complete: $DMG"
