#!/usr/bin/env bash
# macOS/Linux용 노트 앱 실행: backend(8000) + frontend(5173) 동시 구동
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

HOST="${NOTE_APP_HOST:-127.0.0.1}"
BACKEND_PORT="${NOTE_APP_BACKEND_PORT:-8000}"
FRONTEND_PORT="${NOTE_APP_FRONTEND_PORT:-5173}"
VENV_PYTHON="$ROOT_DIR/backend/.venv/bin/python"

"$ROOT_DIR/mac/setup.sh"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(cd backend && exec "$VENV_PYTHON" -m uvicorn app.main:app --host "$HOST" --port "$BACKEND_PORT") &
BACKEND_PID=$!
(cd frontend && exec npm run dev -- --host "$HOST" --port "$FRONTEND_PORT" --strictPort) &
FRONTEND_PID=$!

echo
echo "  📝 노트 앱: http://$HOST:$FRONTEND_PORT"
echo "  (종료: Ctrl+C)"
echo

# macOS 기본 Bash 3.2에는 wait -n이 없다. 먼저 끝난 서비스의 종료 코드를
# 반환하면 EXIT trap이 나머지 서비스를 정리한다.
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  wait "$BACKEND_PID"
else
  wait "$FRONTEND_PID"
fi
