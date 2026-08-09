#!/usr/bin/env bash
# macOS/Linux용 개발 환경 준비: Python venv와 Node 의존성을 현재 플랫폼에 맞게 설치합니다.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="$ROOT_DIR/backend/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
VENV_STAMP="$VENV_DIR/.note-install-stamp"
NODE_STAMP="$ROOT_DIR/frontend/node_modules/.note-install-stamp"
PLATFORM="$(uname -s)-$(uname -m)"

checksum() {
  cksum "$1" | awk '{print $1 ":" $2}'
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] '$1' 명령을 찾을 수 없습니다." >&2
    exit 1
  fi
}

require_command "$PYTHON_BIN"
require_command node
require_command npm

PYTHON_VERSION="$($PYTHON_BIN --version 2>&1)"
BACKEND_STAMP="$PLATFORM|$PYTHON_VERSION|$(checksum backend/requirements.txt)"
FRONTEND_STAMP="$PLATFORM|$(node --version)|$(npm --version)|$(checksum frontend/package-lock.json)"

# 다른 OS에서 복사한 venv는 실행할 수 없으므로 새로 만듭니다.
if ! "$VENV_PYTHON" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  if [ -e "$VENV_DIR" ]; then
    echo "[setup] 호환되지 않는 백엔드 가상환경을 다시 생성합니다..."
    rm -rf "$VENV_DIR"
  else
    echo "[setup] 백엔드 가상환경 생성 중..."
  fi
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [ ! -f "$VENV_STAMP" ] || [ "$(<"$VENV_STAMP")" != "$BACKEND_STAMP" ]; then
  echo "[setup] 백엔드 의존성 설치 중..."
  "$VENV_PYTHON" -m pip install --requirement backend/requirements.txt
  printf '%s\n' "$BACKEND_STAMP" > "$VENV_STAMP"
else
  echo "[setup] 백엔드 의존성이 최신 상태입니다."
fi

# node_modules에는 OS별 실행 파일이 포함될 수 있어 플랫폼 또는 잠금 파일이 바뀌면 재설치합니다.
if [ ! -f "$NODE_STAMP" ] || [ "$(<"$NODE_STAMP")" != "$FRONTEND_STAMP" ]; then
  echo "[setup] 프론트엔드 의존성 설치 중..."
  (cd frontend && npm ci --no-audit --no-fund)
  printf '%s\n' "$FRONTEND_STAMP" > "$NODE_STAMP"
else
  echo "[setup] 프론트엔드 의존성이 최신 상태입니다."
fi

echo "[setup] 완료"
