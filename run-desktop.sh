#!/usr/bin/env bash
# Linux/WSL용 Electron 데스크톱 실행기. Electron이 백엔드 수명주기를 직접 관리합니다.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/setup.sh"
(cd frontend && npm run desktop:prepare)

exec "$ROOT_DIR/frontend/node_modules/.bin/electron" "$ROOT_DIR/frontend/electron/main.mjs"
