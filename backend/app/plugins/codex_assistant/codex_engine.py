"""Codex 엔진 어댑터.

`codex app-server` 프로세스를 감싼 AppServerClient 를 AIEngine 인터페이스로 노출한다.
Orchestrator 는 이 엔진을 통해서만 codex 와 상호작용.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, AsyncIterator

from ...memories import search_memories_tool
from ...skillbook import list_skillbook_tool, read_skillbook_tool
from ...ai_app_tools import (
    complete_todo_tool,
    create_calendar_event_tool,
    create_todo_tool,
    delete_calendar_event_tool,
    list_calendar_events_tool,
    list_todos_tool,
    update_calendar_event_tool,
)
from .app_server import client as app_server, AppServerError
from .codex_cli import resolve_codex_installation

from .cli import codex_command

log = logging.getLogger("codex_engine")


_SKILLBOOK_DYNAMIC_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "list_skillbook",
        "description": (
            "이 노트 시스템에서 사용할 수 있는 앱 전용 스킬과 읽기 전용 시스템 매뉴얼을 검색한다. "
            "반복 가능한 전문 절차, 시스템 사용법, 도메인 지식이 필요할 때 먼저 호출한다."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "이름·설명·ID를 검색할 선택적 검색어. 사용자 요청 문장 전체를 전달해도 "
                        "포함된 항목명과 개별 단어를 기준으로 관련 항목을 찾는다."
                    ),
                },
                "source": {
                    "type": "string",
                    "enum": ["all", "app_skill", "system_manual"],
                    "description": "검색할 항목 종류",
                    "default": "all",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "read_skillbook",
        "description": (
            "list_skillbook에서 선택한 항목의 SKILL.md, 시스템 매뉴얼 또는 하위 텍스트 구성요소를 읽는다."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {
                    "type": "string",
                    "description": "list_skillbook이 반환한 정확한 ID",
                },
                "path": {
                    "type": "string",
                    "description": "선택적 하위 구성요소 경로. 생략하면 대표 문서를 읽는다.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "search_memories",
        "description": (
            "과거 실행에서 학습한 사용자 선호, 프로젝트 규약, 결정, 관례가 현재 요청에 필요할 때만 "
            "워크스페이스 루트의 MEMORIES.md를 검색하고 관련 구간만 가져온다. 전체 메모리는 프롬프트에 "
            "자동 포함되지 않으므로 기억에 의존하기 전에 이 도구로 확인한다."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "찾으려는 사실을 나타내는 구체적인 검색어",
                },
                "source": {
                    "type": "string",
                    "enum": ["all", "global"],
                    "description": "검색할 메모리 범위",
                    "default": "all",
                },
                "section_id": {
                    "type": "string",
                    "description": "이번 실행 컨텍스트에 표시된 section_id",
                },
                "scope_id": {
                    "type": "string",
                    "description": "이번 실행 컨텍스트에 표시된 scope_id",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5,
                    "description": "반환할 관련 구간 수. 기본값 3",
                    "default": 3,
                },
            },
            "additionalProperties": False,
        },
    },
]

_NATIVE_APP_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function", "name": "list_calendar_events",
        "description": "Twill 캘린더에 등록된 일정을 조회한다. 날짜별 확인 또는 날짜 범위 확인에 사용한다.",
        "inputSchema": {"type": "object", "properties": {
            "date": {"type": "string", "description": "조회 날짜 YYYY-MM-DD"},
            "start_date": {"type": "string", "description": "기간 시작일 YYYY-MM-DD"},
            "end_date": {"type": "string", "description": "기간 종료일 YYYY-MM-DD"},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "create_calendar_event",
        "description": "사용자가 일정을 등록하거나 약속을 추가해 달라고 할 때 Twill 캘린더에 일정을 만든다.",
        "inputSchema": {"type": "object", "required": ["date", "title"], "properties": {
            "date": {"type": "string", "description": "일정 날짜 YYYY-MM-DD"},
            "time": {"type": "string", "description": "선택적 시각 HH:MM"},
            "title": {"type": "string", "description": "일정 제목"},
            "description": {"type": "string", "description": "선택적 설명"},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "update_calendar_event",
        "description": "Twill 캘린더 일정의 날짜, 시각, 제목 또는 설명을 수정한다.",
        "inputSchema": {"type": "object", "required": ["event_id"], "properties": {
            "event_id": {"type": "string"}, "date": {"type": "string"},
            "time": {"type": "string"}, "title": {"type": "string"},
            "description": {"type": "string"},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "delete_calendar_event",
        "description": "사용자가 요청한 Twill 캘린더 일정을 삭제한다.",
        "inputSchema": {"type": "object", "required": ["event_id"], "properties": {
            "event_id": {"type": "string"},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "list_todos",
        "description": "Twill 할 일 화면의 Markdown 체크박스를 조회한다. 날짜 생략 시 오늘의 미완료 항목을 조회한다.",
        "inputSchema": {"type": "object", "properties": {
            "date": {"type": "string", "description": "조회 날짜 YYYY-MM-DD. 생략하면 오늘"},
            "include_done": {"type": "boolean", "description": "완료 항목 포함 여부", "default": False},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "create_todo",
        "description": "사용자가 할 일을 추가해 달라고 할 때 지정 날짜의 데일리 노트에 체크박스를 만들고 Twill 할 일 목록에 반영한다.",
        "inputSchema": {"type": "object", "required": ["text"], "properties": {
            "text": {"type": "string", "description": "할 일 한 줄"},
            "date": {"type": "string", "description": "날짜 YYYY-MM-DD. 생략하면 오늘"},
        }, "additionalProperties": False},
    },
    {
        "type": "function", "name": "complete_todo",
        "description": "Twill 할 일 항목을 완료 처리한다. text는 할 일 제목 일부 또는 전체이며, path/date로 대상을 좁힐 수 있다.",
        "inputSchema": {"type": "object", "required": ["text"], "properties": {
            "text": {"type": "string"}, "path": {"type": "string"},
            "date": {"type": "string", "description": "날짜 YYYY-MM-DD"},
        }, "additionalProperties": False},
    },
]


# ─────────────────────────────────────────────────────────────
# 이벤트 매핑 — codex JSON-RPC notification → AIEngine 표준 스키마
# 기존 codex_assistant/__init__.py 의 _classify_notification 과 동일 로직 (재사용)
# ─────────────────────────────────────────────────────────────
def _summarize_command(cmd: str, limit: int = 100) -> str:
    cmd = cmd.strip().replace("\n", " ")
    return cmd if len(cmd) <= limit else cmd[: limit - 1] + "…"


def _first_change_path(item: dict) -> str:
    """fileChange 아이템에서 첫 변경 파일 경로 추출 — 실제 app-server 는 item.changes[0].path 로 내려준다."""
    changes = item.get("changes")
    if isinstance(changes, list) and changes and isinstance(changes[0], dict):
        return str(changes[0].get("path") or "")
    return str(item.get("path") or item.get("file") or "")


def _error_event(error: object) -> dict:
    """Codex turn 오류를 프런트 공통 오류 스키마로 정규화한다."""
    data = error if isinstance(error, dict) else {}
    message = str(data.get("message") or "Codex 요청을 완료하지 못했습니다.")
    code = data.get("codexErrorInfo")
    if code == "usageLimitExceeded":
        return {"type": "error", "code": "usage_limit_exceeded", "message": message}
    return {"type": "error", "message": message}


def _usage_limit_error(message: str) -> bool:
    return bool(re.search(r"usage.?limit|rate.?limit|사용량.{0,8}한도", message, re.IGNORECASE))


def _classify(method: str, params: dict) -> dict | None:
    if method == "turn/started":
        return {"type": "turn_start"}
    if method == "turn/completed":
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        if turn.get("status") == "failed":
            return _error_event(turn.get("error"))
        if turn.get("status") == "interrupted":
            return {"type": "cancelled", "message": "요청에 따라 이 턴을 중단했습니다."}
        return {"type": "turn_done"}
    if method == "error":
        return _error_event(params.get("error"))
    if method == "item/agentMessage/delta":
        return {"type": "delta", "text": params.get("delta", ""), "itemId": params.get("itemId")}
    if method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
        return {"type": "reasoning_delta", "text": params.get("delta", ""), "itemId": params.get("itemId")}
    if method in ("item/commandExecution/outputDelta", "command/exec/outputDelta"):
        chunk = params.get("chunk") or params.get("delta") or params.get("text") or ""
        return {"type": "tool_output_delta", "text": chunk if isinstance(chunk, str) else "", "itemId": params.get("itemId")}
    if method == "item/started":
        item = params.get("item") or {}
        it = item.get("type") or item.get("itemType") or ""
        item_id = item.get("id") or item.get("itemId") or params.get("itemId")
        if it in ("agent_message", "assistantMessage", "agentMessage"):
            return {"type": "message_start", "itemId": item_id}
        if it == "reasoning":
            return {"type": "reasoning_start", "itemId": item_id}
        if it in ("command_execution", "commandExecution"):
            cmd = _summarize_command(str(item.get("command") or item.get("commandForDisplay") or ""))
            return {
                "type": "status",
                "kind": "tool_start",
                "text": f"실행 중: {cmd}",
                "itemId": item_id,
                "tool_type": "command",
            }
        if it in ("file_change", "fileChange"):
            path = _first_change_path(item)
            return {
                "type": "status",
                "kind": "tool_start",
                "text": f"파일 변경: {path or '(알 수 없음)'}",
                "path": path,
                "itemId": item_id,
                "tool_type": "file_change",
            }
        if it in ("dynamic_tool_call", "dynamicToolCall"):
            tool = str(item.get("tool") or "앱 도구")
            return {
                "type": "status",
                "kind": "tool_start",
                "text": f"도구 호출: {tool}",
                "itemId": item_id,
                "tool_type": "dynamic",
            }
        return None
    if method == "item/completed":
        item = params.get("item") or {}
        it = item.get("type") or item.get("itemType") or ""
        item_id = item.get("id") or item.get("itemId") or params.get("itemId")
        if it in ("agent_message", "assistantMessage", "agentMessage"):
            return {"type": "message_end", "itemId": item_id,
                    "text": item.get("text") or item.get("content") or ""}
        if it == "reasoning":
            return {"type": "reasoning_end", "itemId": item_id}
        if it in ("image_generation", "imageGeneration"):
            # app-server v2의 imageGeneration item은 결과 문자열과, 가능한 경우 생성물을
            # 기록한 savedPath를 함께 준다. 원본 base64를 WebSocket으로 흘리지 않고
            # orchestrator가 워크스페이스 assets로 옮길 수 있도록 내부 이벤트로만 넘긴다.
            return {
                "type": "image_result_candidate",
                "itemId": item_id,
                "status": item.get("status"),
                "result": item.get("result"),
                "savedPath": item.get("savedPath") or item.get("saved_path"),
                "revisedPrompt": item.get("revisedPrompt") or item.get("revised_prompt"),
            }
        if it in ("command_execution", "commandExecution"):
            cmd = _summarize_command(str(item.get("command") or ""))
            exit_code = item.get("exitCode") if "exitCode" in item else item.get("exit_code")
            return {"type": "status", "kind": "tool_done",
                    "text": f"완료: {cmd}",
                    "itemId": item_id,
                    "tool_type": "command",
                    "exit_code": exit_code,
                    "success": exit_code in (None, 0, "0")}
        if it in ("file_change", "fileChange"):
            # 파일 쓰기가 디스크에 반영된 시점 — orchestrator 가 워크스페이스 상대 경로로 변환해 릴레이.
            path = _first_change_path(item)
            if path:
                return {
                    "type": "file_change",
                    "path": path,
                    "text": f"파일 변경: {path}",
                    "itemId": item_id,
                    "tool_type": "file_change",
                    "success": True,
                }
        if it in ("dynamic_tool_call", "dynamicToolCall"):
            tool = str(item.get("tool") or "앱 도구")
            success = item.get("success")
            return {
                "type": "status",
                "kind": "tool_done",
                "text": f"{'완료' if success is not False else '실패'}: {tool}",
                "itemId": item_id,
                "tool_type": "dynamic",
                "success": success is not False,
            }
        return None
    if method == "item/reasoning/summaryPartAdded":
        return {"type": "reasoning_part", "itemId": params.get("itemId")}
    return None


# 기본 config: reasoning summary 켜기 (사고 과정 스트리밍 강제)
_BASE_CONFIG = {
    "model_reasoning_summary": "detailed",
}

# 이벤트가 이 시간 동안 전혀 없으면 스트림이 죽은 것으로 판단 (긴 사고·도구 실행도 델타는 흘러온다)
_STALL_TIMEOUT_SEC = 600

# `turn/steer`는 app-server 입장에서는 새 사용자 입력이다. 원문만 넘기면 모델이 이를
# 기존 작업을 대체하는 요청으로 해석해 짧게 답한 뒤 끝낼 수 있다. 벼리의 추가 지시는
# CLI에서 작업 도중 입력하는 것처럼 *기존 작업에 누적*되는 동작이므로, 어댑터 경계에서
# 그 의미를 분명히 한다. 이 안내문은 세션에 저장하는 사용자의 원문에는 섞지 않는다.
_STEER_CONTINUATION_PREAMBLE = """[추가 지시 전달 규칙]
이 메시지는 현재 진행 중인 원래 요청에 덧붙이는 사용자 지시입니다. 진행 중이거나 아직 끝나지 않은 원래 작업을 취소하거나 이 메시지로 대체하지 마세요. 원래 요청의 미완료 작업을 계속 수행하면서 아래 추가 지시도 함께 반영하세요.

아래 지시가 '네라고 답해'처럼 짧은 확인 응답을 요구하더라도, 그 짧은 응답만으로 작업이나 턴을 마무리하지 말고 원래 작업을 계속 수행하세요. 사용자가 원래 요청을 명시적으로 중단·취소·대체하라고 한 경우에만 그 명시를 우선하세요.

[사용자의 추가 지시]
"""


def _compose_continuing_steer_input(guidance: str) -> str:
    """추가 지시를 원래 작업을 이어 가는 입력으로 Codex에 전달한다."""
    return f"{_STEER_CONTINUATION_PREAMBLE}{guidance}"


def _merge_config(base: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    cfg = dict(base)
    if not override:
        return cfg
    if override.get("model"):
        cfg["model"] = override["model"]
    if override.get("effort"):
        cfg["model_reasoning_effort"] = override["effort"]
    if override.get("summary"):
        cfg["model_reasoning_summary"] = override["summary"]
    return cfg


class CodexEngine:
    """AIEngine 인터페이스를 구현하는 codex 어댑터."""

    id = "codex"
    display_name = "Codex"
    supports_developer_instructions = True
    # thread/start에서 고정되는 동적 도구 구성이 바뀌면 기존 스레드를 한 번 교체한다.
    toolset_version = 3

    def __init__(self) -> None:
        # `turn/steer`는 같은 스레드 안에서 활성 턴을 새 ID로 바꿀 수 있다. 스트림
        # 리스너도 이 ID를 알아야, 이전 턴의 completed 알림으로 이어지는 작업을 끝내지
        # 않는다. (Codex CLI와 같은 steer 수명 처리)
        self._active_turn_ids: dict[str, str] = {}
        app_server.register_dynamic_tool("list_skillbook", list_skillbook_tool)
        app_server.register_dynamic_tool("read_skillbook", read_skillbook_tool)
        app_server.register_dynamic_tool("search_memories", search_memories_tool)
        for name, handler in {
            "list_calendar_events": list_calendar_events_tool,
            "create_calendar_event": create_calendar_event_tool,
            "update_calendar_event": update_calendar_event_tool,
            "delete_calendar_event": delete_calendar_event_tool,
            "list_todos": list_todos_tool,
            "create_todo": create_todo_tool,
            "complete_todo": complete_todo_tool,
        }.items():
            app_server.register_dynamic_tool(name, handler)

    async def start_thread(self, *, cwd: str, config: dict[str, Any] | None = None) -> str:
        merged = _merge_config(_BASE_CONFIG, config)
        approval = (config or {}).get("approval")
        params: dict[str, Any] = {
            "cwd": cwd,
            "sandbox": "workspace-write",
            "config": merged,
            "dynamicTools": [*_SKILLBOOK_DYNAMIC_TOOLS, *_NATIVE_APP_TOOLS],
        }
        if approval:
            params["approvalPolicy"] = approval
        developer_instructions = (config or {}).get("developer_instructions")
        if isinstance(developer_instructions, str) and developer_instructions:
            params["developerInstructions"] = developer_instructions
        result = await app_server.request("thread/start", params, timeout=20)
        tid = (result.get("thread") or {}).get("id")
        if not isinstance(tid, str):
            raise AppServerError("thread/start 응답에 threadId가 없습니다")
        return tid

    async def resume_thread(self, *, thread_id: str, cwd: str, config: dict[str, Any] | None = None) -> str:
        merged = _merge_config(_BASE_CONFIG, config)
        params: dict[str, Any] = {"threadId": thread_id, "cwd": cwd, "config": merged}
        developer_instructions = (config or {}).get("developer_instructions")
        if isinstance(developer_instructions, str) and developer_instructions:
            params["developerInstructions"] = developer_instructions
        result = await app_server.request("thread/resume", params, timeout=20)
        tid = (result.get("thread") or {}).get("id")
        if not isinstance(tid, str):
            raise AppServerError("thread/resume 응답에 threadId가 없습니다")
        return tid

    async def run_turn(
        self,
        *,
        thread_id: str,
        input_text: str,
        config: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """turn/start 후 스트리밍 알림을 AIEngine 표준 이벤트로 변환해서 yield."""
        await app_server.ensure_started()

        turn_done_event = asyncio.Event()
        events: asyncio.Queue[dict | None] = asyncio.Queue()

        def on_notification(method: str, params: dict) -> None:
            if method == "__connection_lost__":
                # app-server read loop 사망 (프로세스 재시작) — 이 턴의 이벤트는 더 오지 않으므로
                # 조용히 매달리지 말고 즉시 오류로 종료시킨다.
                detail = str(params.get("detail") or "").strip()
                suffix = f" ({detail})" if detail else ""
                events.put_nowait({
                    "type": "error",
                    "message": f"codex app-server 연결이 끊어져 실행을 종료합니다{suffix}. 다시 시도해주세요.",
                })
                turn_done_event.set()
                return
            if params.get("threadId") and params.get("threadId") != thread_id:
                return
            if method == "turn/started":
                turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
                started_turn_id = turn.get("id") or turn.get("turnId")
                if isinstance(started_turn_id, str) and started_turn_id:
                    self._active_turn_ids[thread_id] = started_turn_id
                    events.put_nowait({"type": "_turn_id", "turn_id": started_turn_id})
            if method == "turn/completed":
                turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
                completed_turn_id = turn.get("id") or turn.get("turnId")
                active_turn_id = self._active_turn_ids.get(thread_id)
                # steer 뒤에는 기존 turn의 completed 알림이 올 수 있다. 현재 활성 turn과
                # 다른 완료는 UI/실행 종료로 전파하지 않고, 새 turn의 이벤트를 계속 받는다.
                if (
                    isinstance(completed_turn_id, str)
                    and active_turn_id
                    and completed_turn_id != active_turn_id
                ):
                    return
                self._active_turn_ids.pop(thread_id, None)
                turn_done_event.set()
            ui = _classify(method, params)
            if ui is not None:
                events.put_nowait(ui)

        unsub = app_server.subscribe(on_notification)

        # 텍스트 + 첨부 이미지 입력 조립 — app-server 는 {"type":"localImage","path":...} 를 받는다
        input_items: list[dict[str, Any]] = [{"type": "text", "text": input_text}]
        for image_path in (config or {}).get("images") or []:
            input_items.append({"type": "localImage", "path": str(image_path)})

        turn_params: dict[str, Any] = {
            "threadId": thread_id,
            "input": input_items,
            "summary": (config or {}).get("summary") or "detailed",
        }
        if (config or {}).get("model"):
            turn_params["model"] = config["model"]
        if (config or {}).get("effort"):
            turn_params["effort"] = config["effort"]
        if (config or {}).get("approval"):
            turn_params["approvalPolicy"] = config["approval"]
        writable_roots = (config or {}).get("workspace_write_roots")
        if isinstance(writable_roots, list):
            roots = [str(path) for path in writable_roots if isinstance(path, str) and path]
            if roots:
                # scope cwd 밖의 Notes 워크스페이스에도 문서를 저장할 수 있게 한다. 이 정책은
                # 현재 turn과 이후 turn에 적용되며, 허용 목록 밖 쓰기는 여전히 sandbox가 막는다.
                turn_params["sandboxPolicy"] = {
                    "type": "workspaceWrite",
                    "writableRoots": list(dict.fromkeys(roots)),
                }
        if (config or {}).get("output_schema"):
            turn_params["outputSchema"] = config["output_schema"]

        try:
            await app_server.request("turn/start", turn_params, timeout=30)
        except AppServerError as e:
            unsub()
            message = str(e)
            yield {
                "type": "error",
                "message": message,
                **({"code": "usage_limit_exceeded"} if _usage_limit_error(message) else {}),
            }
            return

        # turn/start 응답의 ID는 아직 steer 가능한 활성 턴을 뜻하지 않는다. 실제 활성화는
        # turn/started 알림에서 확인되므로, 위 listener가 _turn_id를 넣을 때까지 기다린다.

        # 스트리밍: turn_done_event 가 셋되고 큐가 비면 종료.
        # · 조용한 구간에는 1초마다 _tick 하트비트를 흘려 orchestrator 가 cancel/budget 검사를
        #   계속할 수 있게 한다 (이게 없으면 스트림이 멈춘 동안 중단 버튼이 안 먹음).
        # · _STALL_TIMEOUT_SEC 동안 이벤트가 전혀 없으면 죽은 스트림으로 판단하고 오류 종료.
        loop = asyncio.get_running_loop()
        last_event_at = loop.time()
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(events.get(), timeout=1.0)
                    if ev is None:
                        break
                    last_event_at = loop.time()
                    yield ev
                except asyncio.TimeoutError:
                    if turn_done_event.is_set() and events.empty():
                        break
                    if loop.time() - last_event_at > _STALL_TIMEOUT_SEC:
                        log.warning("turn stalled: no events for %ss (thread=%s)", _STALL_TIMEOUT_SEC, thread_id)
                        yield {
                            "type": "error",
                            "message": f"{_STALL_TIMEOUT_SEC // 60}분 동안 엔진 응답이 없어 실행을 종료합니다.",
                        }
                        break
                    yield {"type": "_tick"}
        finally:
            unsub()
            self._active_turn_ids.pop(thread_id, None)

    async def interrupt(self, *, thread_id: str, turn_id: str | None = None) -> None:
        if not turn_id:
            return
        try:
            await app_server.request(
                "turn/interrupt",
                {"threadId": thread_id, "turnId": turn_id},
                timeout=5,
            )
        except AppServerError as e:
            log.info("turn/interrupt failed: %s", e)

    async def steer(
        self,
        *,
        thread_id: str,
        turn_id: str,
        guidance: str,
        client_message_id: str | None = None,
        images: list[str] | None = None,
    ) -> str | None:
        """현재 Codex app-server 프로토콜로 같은 턴에 추가 지시를 전달한다.

        `expectedTurnId`는 오래된 턴에 지시가 잘못 붙는 일을 막는 서버 측 전제조건이다.
        응답의 turnId는 steer 뒤에도 이어서 사용할 활성 턴 ID이므로 호출자에게 돌려준다.
        """
        input_items: list[dict[str, str]] = [
            {"type": "text", "text": _compose_continuing_steer_input(guidance)}
        ]
        input_items.extend({"type": "localImage", "path": image_path} for image_path in images or [])
        params: dict[str, Any] = {
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": input_items,
        }
        if client_message_id:
            params["clientUserMessageId"] = client_message_id
        result = await app_server.request("turn/steer", params, timeout=5)
        next_turn_id = result.get("turnId")
        if not isinstance(next_turn_id, str) or not next_turn_id:
            raise AppServerError("turn/steer 응답에 turnId가 없습니다")
        # app-server가 steer 응답을 먼저 보내고 이전 turn의 completed 알림을 뒤이어
        # 보낼 수 있으므로, 스트림 리스너보다 먼저 새 활성 turn을 기록한다.
        self._active_turn_ids[thread_id] = next_turn_id
        return next_turn_id

    async def status(self) -> dict[str, Any]:
        installation = resolve_codex_installation()
        if not installation:
            return {"available": False, "logged_in": False, "detail": "codex CLI가 설치되어 있지 않습니다"}
        try:
            proc = await asyncio.create_subprocess_exec(
                *codex_command("login", "status"),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, err = await proc.communicate()
        except FileNotFoundError:
            return {"available": False, "logged_in": False, "detail": "codex CLI를 실행할 수 없습니다"}
        text = (out.decode(errors="ignore") + err.decode(errors="ignore")).strip()
        logged_in = proc.returncode == 0 and ("logged in" in text.lower() or "@" in text or "signed in" in text.lower())
        return {
            "available": True,
            "logged_in": bool(logged_in),
            "detail": text,
            **installation.as_status(),
        }

    async def list_models(self) -> list[dict[str, Any]]:
        data = []
        cursor = None
        seen = set()
        while True:
            result = await app_server.request(
                "model/list", {"includeHidden": False, "limit": 50, **({"cursor": cursor} if cursor else {})}, timeout=15
            )
            if not isinstance(result.get("data"), list):
                raise AppServerError("model/list 응답에 모델 목록이 없습니다")
            data.extend(result["data"])
            cursor = result.get("nextCursor")
            if not cursor:
                break
            if cursor in seen:
                raise AppServerError("model/list 페이지 커서가 반복됩니다")
            seen.add(cursor)
        return [
            {
                "id": m.get("id"),
                "model": m.get("model"),
                "displayName": m.get("displayName"),
                "description": m.get("description"),
                "isDefault": m.get("isDefault", False),
                "defaultEffort": m.get("defaultReasoningEffort"),
                "supportedEfforts": [e.get("reasoningEffort") for e in m.get("supportedReasoningEfforts", [])],
            }
            for m in data if not m.get("hidden")
        ]

    async def usage_limits(self) -> dict[str, Any]:
        """로그인한 Codex 계정의 서버 측 5시간·주간 한도 스냅샷을 반환한다."""
        try:
            result = await app_server.request("account/rateLimits/read", None, timeout=15)
        except AppServerError as e:
            return {"available": False, "reason": str(e)}

        by_limit_id = result.get("rateLimitsByLimitId")
        snapshot = by_limit_id.get("codex") if isinstance(by_limit_id, dict) else None
        if not isinstance(snapshot, dict):
            snapshot = result.get("rateLimits")
        if not isinstance(snapshot, dict):
            return {"available": False, "reason": "Codex 사용량 정보를 받을 수 없습니다"}

        def window(value: object) -> dict[str, int | None] | None:
            if not isinstance(value, dict) or not isinstance(value.get("usedPercent"), (int, float)):
                return None
            return {
                "used_percent": max(0, min(100, int(value["usedPercent"]))),
                "resets_at": value.get("resetsAt") if isinstance(value.get("resetsAt"), int) else None,
                "window_duration_mins": value.get("windowDurationMins")
                if isinstance(value.get("windowDurationMins"), int)
                else None,
            }

        primary = window(snapshot.get("primary"))
        secondary = window(snapshot.get("secondary"))
        reached_type = snapshot.get("rateLimitReachedType")
        blocked = bool(reached_type) or bool(primary and primary["used_percent"] >= 100) or bool(
            secondary and secondary["used_percent"] >= 100
        )
        return {
            "available": bool(primary or secondary),
            "blocked": blocked,
            "reached_type": reached_type if isinstance(reached_type, str) else None,
            "plan_type": snapshot.get("planType") if isinstance(snapshot.get("planType"), str) else None,
            "primary": primary,
            "secondary": secondary,
        }


# 싱글턴 인스턴스 — 플러그인 install 시 registry 에 등록
engine = CodexEngine()
