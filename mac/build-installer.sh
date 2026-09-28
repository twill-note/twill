#!/usr/bin/env bash
# Build a self-contained macOS DMG. Run this script on the target Mac architecture.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_PYTHON="$BACKEND_DIR/.venv/bin/python"
BACKEND_OUTPUT="$FRONTEND_DIR/build/backend"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$ROOT_DIR/.build-cache/electron-builder}"
export npm_config_cache="${npm_config_cache:-$ROOT_DIR/.build-cache/npm}"
export electron_config_cache="${electron_config_cache:-$ROOT_DIR/.build-cache/electron}"
export PYINSTALLER_CONFIG_DIR="${PYINSTALLER_CONFIG_DIR:-$ROOT_DIR/.build-cache/pyinstaller}"

echo "[package] Preparing development dependencies..."
"$SCRIPT_DIR/setup.sh"

echo "[package] Installing the backend packager..."
"$VENV_PYTHON" -m pip install --requirement "$BACKEND_DIR/requirements-build.txt"

echo "[package] Downloading the latest official Codex CLI runtime..."
if [[ "${TWILL_REUSE_CODEX_RUNTIME:-0}" == "1" ]]; then
  "$VENV_PYTHON" "$ROOT_DIR/scripts/prepare_codex_runtime.py" --reuse-existing
else
  "$VENV_PYTHON" "$ROOT_DIR/scripts/prepare_codex_runtime.py"
fi

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
  --add-data "$ROOT_DIR/skillbook/skills/create-system-skill:skillbook/skills/create-system-skill" \
  --add-data "$ROOT_DIR/skillbook/skills/write-project-wiki:skillbook/skills/write-project-wiki" \
  --add-data "$BACKEND_DIR/app/system_manual:backend/app/system_manual" \
  "$BACKEND_DIR/desktop_main.py"

echo "[package] Building the macOS disk image..."
(cd "$FRONTEND_DIR" && npm run dist:mac)

DMG=""
while IFS= read -r candidate; do
  if [[ -z "$DMG" || "$candidate" -nt "$DMG" ]]; then
    DMG="$candidate"
  fi
done < <(find "$FRONTEND_DIR/release" -maxdepth 1 -type f -name 'Twill-*.dmg' -print)
if [[ -z "$DMG" ]]; then
  echo "[error] The DMG was not created." >&2
  exit 1
fi
echo "[package] Complete: $DMG"
