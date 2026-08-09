"""AI 엔진 어댑터 인터페이스.

Orchestrator 가 어떤 LLM(Codex/Claude/GPT/로컬) 을 쓰든 이 인터페이스만 따르면 됨.
플러그인이 자신을 엔진으로 등록: `engine.registry.register(MyEngine())`.

이벤트 스키마 (엔진이 run_turn 이터레이터로 yield 하는 dict):
    { "type": "turn_start" }
    { "type": "reasoning_start", "itemId": "..." }
    { "type": "reasoning_delta", "text": "...", "itemId": "..." }
    { "type": "reasoning_end",   "itemId": "..." }
    { "type": "message_start",   "itemId": "..." }
    { "type": "delta",           "text": "...", "itemId": "..." }
    { "type": "message_end",     "itemId": "...", "text": "최종 텍스트" }
    { "type": "status", "kind": "tool_start" | "tool_done", "text": "...",
      "itemId": "...", "tool_type": "command" | "file_change" | "dynamic", "exit_code": int? }
    { "type": "tool_output_delta", "text": "...", "itemId": "..." }
    { "type": "turn_done" }
    { "type": "error", "message": "..." }

이 스키마는 codex app-server 이벤트를 그대로 승계 — 다른 엔진 어댑터도 이 형태로 변환해 emit 해야 함.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, runtime_checkable


@runtime_checkable
class AIEngine(Protocol):
    """AI 실행 엔진 인터페이스."""

    id: str
    display_name: str

    async def start_thread(self, *, cwd: str, config: dict[str, Any] | None = None) -> str:
        """새 대화 스레드 시작. threadId 반환."""
        ...

    async def resume_thread(self, *, thread_id: str, cwd: str, config: dict[str, Any] | None = None) -> str:
        """기존 스레드 재개. 성공 시 threadId 반환. 실패하면 예외."""
        ...

    async def run_turn(
        self,
        *,
        thread_id: str,
        input_text: str,
        config: dict[str, Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """한 턴 실행. 이벤트 스트림을 async iterator 로 반환.

        config 에 사용 가능한 키:
          model         : 모델 override
          effort        : 추론 강도 override
          approval      : approval policy override
          summary       : reasoning summary 강도
          output_schema : structured output JSON schema
          workspace_write_roots : 엔진이 추가 쓰기를 허용할 절대 경로 목록 (선택)
        """
        ...

    async def interrupt(self, *, thread_id: str, turn_id: str | None = None) -> None:
        """실행 중인 턴을 중단."""
        ...

    async def steer(
        self,
        *,
        thread_id: str,
        turn_id: str,
        guidance: str,
        client_message_id: str | None = None,
    ) -> str | None:
        """실행 중 궤도 수정 지시를 주입하고, 새 활성 turn ID를 반환한다.

        ``client_message_id`` 는 엔진이 지원할 때 UI의 낙관적 말풍선과 엔진에 전달된
        사용자 입력을 연결하는 용도다.
        """
        ...

    async def status(self) -> dict[str, Any]:
        """엔진 상태 (로그인 여부, 사용 가능 모델 등)."""
        ...

    async def list_models(self) -> list[dict[str, Any]]:
        """사용 가능 모델 목록. 없으면 빈 리스트."""
        ...


class EngineRegistry:
    """설치된 엔진들의 등록소.

    플러그인 install 시 engine 을 등록, uninstall 시 해제.
    Orchestrator 는 default() 또는 get(id) 로 엔진 획득.
    """

    def __init__(self) -> None:
        self._engines: dict[str, AIEngine] = {}
        self._default_id: str | None = None

    def register(self, engine: AIEngine, make_default: bool = True) -> None:
        self._engines[engine.id] = engine
        if make_default or self._default_id is None:
            self._default_id = engine.id

    def unregister(self, engine_id: str) -> None:
        self._engines.pop(engine_id, None)
        if self._default_id == engine_id:
            self._default_id = next(iter(self._engines), None)

    def get(self, engine_id: str | None = None) -> AIEngine | None:
        if engine_id:
            return self._engines.get(engine_id)
        if self._default_id:
            return self._engines.get(self._default_id)
        return None

    def default(self) -> AIEngine | None:
        return self.get(None)

    def list(self) -> list[dict[str, Any]]:
        return [
            {"id": e.id, "name": getattr(e, "display_name", e.id), "default": e.id == self._default_id}
            for e in self._engines.values()
        ]


registry = EngineRegistry()
