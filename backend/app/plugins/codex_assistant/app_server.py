"""codex app-server 프로세스 관리 + JSON-RPC 클라이언트.

codex 는 `codex app-server` 로 실행하면 JSON-RPC 2.0 프로토콜을 stdio 로 노출한다.
이 프로토콜은 공식 VSCode 확장이 사용하는 것과 동일하며, `item/agentMessage/delta` 같은
토큰 단위 스트리밍 이벤트를 제공한다.

싱글턴 프로세스로 관리하며 여러 챗 세션(thread)이 하나의 프로세스를 공유한다.
- 지연 시작: 첫 요청 시 프로세스 스폰
- 자동 재시작: 프로세스 종료 시 다음 요청에서 재시작 (미구현: 필요 시 확장)
- 종료: 플러그인 uninstall 또는 앱 종료 시 stop()

프로토콜 참고:
  codex app-server generate-json-schema --out <dir>
"""
from __future__ import annotations

import asyncio
from collections import deque
import inspect
import json
import logging
from typing import Any, Callable

from .cli import codex_command, codex_process_options, stop_codex_process

log = logging.getLogger("plugins.codex_assistant.app_server")

Listener = Callable[[str, dict], None]
DynamicToolHandler = Callable[[Any], Any]


class AppServerError(RuntimeError):
    pass


def _app_server_command(binary: str) -> tuple[str, str]:
    """Return the Codex app-server command.

    Stdio is the app-server's default transport. Recent CLI versions expose a
    ``--stdio`` alias, but older supported versions reject that flag, so the bare
    command is the most broadly compatible form.
    """
    return binary, "app-server"


# codex app-server 가 클라이언트에게 보내는 승인 요청(id 있는 request) 에 대한 기본 응답.
# sandbox="workspace-write" 로 워크스페이스 내부 파일 작업은 대부분 승인 요청 자체가 없지만,
# 커맨드 실행/네트워크 접근 등 sandbox 밖 escalation 은 여전히 요청이 올 수 있음.
# 응답을 안 주면 codex 가 해당 턴에서 영원히 대기 → 클라이언트 쪽 turn 타임아웃(응답 시간 초과)으로만 끝남.
# 단일 사용자 로컬 워크스페이스이므로 자동 승인해서 턴이 멈추지 않게 한다.
_AUTO_APPROVAL_RESULTS: dict[str, dict] = {
    "item/commandExecution/requestApproval": {"decision": "accept"},
    "execCommandApproval": {"decision": "accept"},
    "item/fileChange/requestApproval": {"decision": "accept"},
    "applyPatchApproval": {"decision": "accept"},
}


# stdout 파이프의 한 줄 최대 크기. asyncio 기본값(64KB)은 codex 가 큰 도구 출력(예: rg --files -uu
# 전체 목록)을 하나의 JSON-RPC 라인으로 내려보내면 초과해서 read loop 가 ValueError 로 죽고,
# 진행 중이던 턴이 응답 없이 영원히 매달리는 사고가 실제로 발생했다 (2026-07-12).
_STREAM_LIMIT = 16 * 1024 * 1024  # 16MB


class AppServerClient:
    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._stderr_tail: deque[str] = deque(maxlen=20)
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._listeners: set[Listener] = set()
        self._dynamic_tool_handlers: dict[str, DynamicToolHandler] = {}
        self._start_lock = asyncio.Lock()
        self._initialized = False
        self.maintenance_reason: str | None = None

    # ─────────────────────────────────────────────────────────
    # 프로세스 라이프사이클
    # ─────────────────────────────────────────────────────────
    async def ensure_started(self) -> None:
        if self.maintenance_reason:
            raise AppServerError(self.maintenance_reason)
        if self._proc and self._proc.returncode is None and self._initialized:
            return
        async with self._start_lock:
            if self.maintenance_reason:
                raise AppServerError(self.maintenance_reason)
            if self._proc and self._proc.returncode is None and self._initialized:
                return
            await self._spawn()
            await self._handshake()

    async def _spawn(self) -> None:
        # read loop 사망 후 재시작하는 경우, 이전 프로세스가 살아있으면 고아로 남지 않게 정리
        if self._proc and self._proc.returncode is None:
            log.warning("terminating stale app-server (pid=%s) before respawn", self._proc.pid)
            await self._stop()
        # stdio is the default transport; newer Codex versions no longer accept --stdio.
        proc = await asyncio.create_subprocess_exec(
            *codex_command("app-server"),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_STREAM_LIMIT,
            **codex_process_options(),
        )
        self._proc = proc
        self._next_id = 1
        self._pending.clear()
        self._stderr_tail.clear()
        self._reader_task = asyncio.create_task(self._read_loop(proc))
        self._stderr_task = asyncio.create_task(self._drain_stderr(proc))
        log.info("codex app-server started (pid=%s)", proc.pid)

    async def _handshake(self) -> None:
        result = await self.request(
            "initialize",
            {
                "clientInfo": {"name": "note-app", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
            timeout=15,
        )
        await self.notify("initialized", {})
        self._initialized = True
        log.info("codex app-server initialized: %s", result.get("codexHome"))

    async def stop(self) -> None:
        async with self._start_lock:
            await self._stop()

    async def _stop(self) -> None:
        if self._proc:
            await stop_codex_process(self._proc)
        tasks = [task for task in (self._reader_task, self._stderr_task) if task]
        if self._reader_task:
            self._reader_task.cancel()
        if self._stderr_task:
            self._stderr_task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._proc = None
        self._reader_task = None
        self._stderr_task = None
        self._initialized = False
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(AppServerError("app-server 프로세스가 종료됨"))
        self._pending.clear()

    # ─────────────────────────────────────────────────────────
    # JSON-RPC 요청/알림
    # ─────────────────────────────────────────────────────────
    async def request(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        if method != "initialize":
            await self.ensure_started()
        if not self._proc or not self._proc.stdin:
            raise AppServerError("app-server 프로세스가 실행 중이 아닙니다")
        msg_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        payload = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode())
        await self._proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise AppServerError(f"{method} 요청 시간 초과 ({timeout}s)")

    async def notify(self, method: str, params: dict | None = None) -> None:
        if not self._proc or not self._proc.stdin:
            raise AppServerError("app-server 프로세스가 실행 중이 아닙니다")
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode())
        await self._proc.stdin.drain()

    def register_dynamic_tool(self, name: str, handler: DynamicToolHandler) -> None:
        """thread/start에 노출한 동적 도구의 앱 측 실행기를 등록한다."""
        self._dynamic_tool_handlers[name] = handler

    async def _respond_to_server_request(
        self,
        msg_id: Any,
        method: str,
        params: dict[str, Any],
    ) -> None:
        """codex 가 보낸 승인/입력 요청(request)에 응답. 응답이 없으면 codex 가 무기한 대기한다."""
        if method == "item/tool/call":
            tool_name = str(params.get("tool") or "")
            handler = self._dynamic_tool_handlers.get(tool_name)
            if handler is None:
                result = {
                    "success": False,
                    "contentItems": [
                        {"type": "inputText", "text": f"등록되지 않은 앱 도구입니다: {tool_name}"}
                    ],
                }
            else:
                try:
                    output = handler(params.get("arguments"))
                    if inspect.isawaitable(output):
                        output = await output
                    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
                    result = {
                        "success": True,
                        "contentItems": [{"type": "inputText", "text": text}],
                    }
                except Exception as exc:  # noqa: BLE001
                    log.exception("dynamic tool '%s' failed", tool_name)
                    result = {
                        "success": False,
                        "contentItems": [{"type": "inputText", "text": str(exc)}],
                    }
        else:
            result = _AUTO_APPROVAL_RESULTS.get(method)
        if result is None:
            log.warning("unhandled server request '%s' — 빈 결과로 자동 응답", method)
            result = {}
        elif method != "item/tool/call":
            log.info("auto-approving server request '%s'", method)
        if not self._proc or not self._proc.stdin:
            return
        payload = {"jsonrpc": "2.0", "id": msg_id, "result": result}
        try:
            self._proc.stdin.write((json.dumps(payload) + "\n").encode())
            await self._proc.stdin.drain()
        except Exception:  # noqa: BLE001
            log.exception("failed to respond to server request '%s'", method)

    # ─────────────────────────────────────────────────────────
    # 알림 구독
    # ─────────────────────────────────────────────────────────
    def subscribe(self, listener: Listener) -> Callable[[], None]:
        self._listeners.add(listener)

        def unsubscribe() -> None:
            self._listeners.discard(listener)

        return unsubscribe

    # ─────────────────────────────────────────────────────────
    # 내부 리더
    # ─────────────────────────────────────────────────────────
    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        """stderr가 가득 차 app-server가 멈추는 일을 막고, 종료 원인을 남긴다."""
        assert proc.stderr
        try:
            async for line in proc.stderr:
                text = line.decode(errors="replace").strip()
                if text and proc is self._proc:
                    self._stderr_tail.append(text)
                    log.debug("app-server stderr: %s", text)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("app-server stderr reader crashed")

    async def _read_loop(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout
        try:
            async for line in proc.stdout:
                text = line.decode(errors="ignore").strip()
                if not text:
                    continue
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    log.debug("non-JSON stdout: %s", text[:120])
                    continue
                if not isinstance(msg, dict):
                    continue
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = self._pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        if "error" in msg:
                            err = msg["error"]
                            fut.set_exception(
                                AppServerError(
                                    err.get("message", "RPC error") if isinstance(err, dict) else str(err)
                                )
                            )
                        else:
                            fut.set_result(msg.get("result") or {})
                    continue
                method = msg.get("method")
                if not method:
                    continue
                params = msg.get("params") or {}
                if "id" in msg:
                    # 서버(codex)가 클라이언트에게 보낸 request (승인/입력 요청 등).
                    # JSON-RPC notification 은 id 가 없으므로 이 분기로 들어오지 않음.
                    await self._respond_to_server_request(msg["id"], method, params)
                    continue
                for listener in list(self._listeners):
                    try:
                        listener(method, params)
                    except Exception:  # noqa: BLE001
                        log.exception("listener error")
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("app-server read loop crashed")
        finally:
            # 새 프로세스가 이미 떠 있으면 이전 reader가 새 요청·리스너까지 종료시키면 안 된다.
            if proc is not self._proc:
                return
            if proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    pass
            detail = (
                f"종료 코드 {proc.returncode}"
                if proc.returncode is not None
                else "표준 출력 스트림이 예기치 않게 닫힘"
            )
            if self._stderr_tail:
                log.error("codex app-server 연결 종료 (%s): %s", detail, self._stderr_tail[-1])
            else:
                log.error("codex app-server 연결 종료 (%s)", detail)
            # 프로세스 종료 시 대기 중인 future 모두 실패 처리
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(AppServerError(f"app-server 프로세스가 종료됨 ({detail})"))
            self._pending.clear()
            self._initialized = False
            # 진행 중인 턴 구독자들에게 연결 단절을 알림 — 이게 없으면 run_turn 이
            # turn/completed 를 기다리며 영원히 매달린다 (13:00 실행 33분 고착의 직접 원인).
            for listener in list(self._listeners):
                try:
                    listener("__connection_lost__", {"detail": detail})
                except Exception:  # noqa: BLE001
                    log.exception("listener disconnect notify error")


client = AppServerClient()
