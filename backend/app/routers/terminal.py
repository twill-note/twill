"""WebSocket ↔ PTY 브리지: 프론트 터미널 패널(xterm.js)용 셸 세션."""

import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import config

router = APIRouter(prefix="/api/terminal", tags=["terminal"])


def _spawn_shell() -> tuple[int, int]:
    """워크스페이스 루트를 cwd로 하여 사용자 셸을 PTY에서 실행."""
    shell = os.environ.get("SHELL", "/bin/bash")
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(config.notes_dir())
            env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
            os.execvpe(shell, [shell], env)
        finally:
            os._exit(1)
    return pid, fd


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@router.websocket("/ws")
async def terminal_ws(ws: WebSocket):
    await ws.accept()
    pid, fd = _spawn_shell()
    loop = asyncio.get_running_loop()
    out_queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if data:
            out_queue.put_nowait(data)
        else:  # 셸 종료 (EOF)
            loop.remove_reader(fd)
            out_queue.put_nowait(None)

    loop.add_reader(fd, on_readable)

    async def pump_output():
        while True:
            chunk = await out_queue.get()
            if chunk is None:
                break
            await ws.send_bytes(chunk)
        try:
            await ws.close()
        except RuntimeError:
            pass

    pump = asyncio.create_task(pump_output())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "input":
                os.write(fd, str(msg.get("data", "")).encode())
            elif msg.get("type") == "resize":
                _set_winsize(fd, int(msg["rows"]), int(msg["cols"]))
    except (WebSocketDisconnect, RuntimeError, json.JSONDecodeError, OSError, KeyError, ValueError):
        pass
    finally:
        pump.cancel()
        loop.remove_reader(fd)
        # 실제 터미널이 닫힐 때처럼: 포그라운드 프로세스 그룹(실행 중인 명령)에 먼저 HUP
        try:
            fg = os.tcgetpgrp(fd)
            if fg > 0 and fg != pid:
                os.killpg(fg, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
