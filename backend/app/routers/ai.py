"""AI 엔진/오케스트레이터 관련 공용 엔드포인트."""
from __future__ import annotations

import json
import logging
import re
import asyncio

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from pydantic import BaseModel, Field

from ..ai import sessions as ai_sessions
from ..ai.engine import registry as engine_registry
from ..ai import git_metadata_access
from ..ai.orchestrator import (
    RunRequest,
    approve_memory_review,
    discard_memory_review,
    orchestrator,
    prompt_runtime_info,
)
from ..plugins.codex_assistant.app_server import client as codex_app_server
from ..plugins.codex_assistant.codex_cli import codex_binary, download_latest_codex_runtime, managed_runtime_dir

log = logging.getLogger("ai_router")

router = APIRouter(prefix="/api/ai", tags=["ai"])

_CODEX_URL_RE = re.compile(r"https?://[\w./%?=&#:_-]+")
_codex_update_lock = asyncio.Lock()


def _codex_binary() -> str:
    return codex_binary() or "codex"


@router.get("/engines")
def list_engines():
    """등록된 AI 엔진 목록. 플러그인이 install 되면 여기에 나타남."""
    return {"engines": engine_registry.list()}


@router.get("/status")
async def engine_status():
    """기본 엔진 상태 (설치·로그인 여부). 벼리 패널이 엔진과 무관하게 조회."""
    engine = engine_registry.default()
    if engine is None:
        return {"available": False, "logged_in": False, "detail": "설치된 AI 엔진이 없습니다", "engine": None}
    st = await engine.status()
    return {**st, "engine": engine.id}


@router.post("/codex-cli/update")
async def update_codex_cli():
    """공식 OpenAI 릴리스의 최신 Codex CLI를 Twill 전용 폴더에 설치한다."""
    if orchestrator.has_active_runs():
        raise HTTPException(
            status_code=409,
            detail="실행 중인 Twill AI 요청을 끝내거나 중단한 뒤 Codex CLI를 업데이트해주세요.",
        )
    if _codex_update_lock.locked():
        raise HTTPException(status_code=409, detail="Codex CLI 업데이트가 이미 진행 중입니다.")

    async with _codex_update_lock:
        # Windows에서는 실행 중인 codex.exe가 관리 런타임 교체를 방해할 수 있다.
        # 현재 요청이 모두 끝난 상태에서 app-server를 먼저 내리고 새 패키지를 설치한다.
        await codex_app_server.stop()
        try:
            installation = await asyncio.to_thread(
                download_latest_codex_runtime,
                managed_runtime_dir(),
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("Codex CLI update failed")
            raise HTTPException(
                status_code=502,
                detail=f"Codex CLI를 업데이트하지 못했습니다: {exc}",
            ) from exc
    return {
        "ok": True,
        "version": installation.version,
        "source": installation.source,
        "restart_required": True,
    }


@router.post("/logout")
async def logout():
    """벼리의 기본 Codex 계정을 로그아웃한다 (플러그인 라우트가 아닌 코어 API)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            _codex_binary(), "logout", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await proc.communicate()
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="codex CLI가 설치되어 있지 않습니다")
    if proc.returncode != 0:
        detail = err.decode(errors="ignore") or out.decode(errors="ignore")
        raise HTTPException(status_code=500, detail=detail or "로그아웃 실패")
    return {"ok": True}


@router.websocket("/login")
async def login_ws(ws: WebSocket):
    """벼리의 Codex 로그인 출력을 브라우저에 릴레이한다."""
    await ws.accept()
    try:
        proc = await asyncio.create_subprocess_exec(
            _codex_binary(),
            "login",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        await ws.send_json({"type": "error", "message": "codex CLI가 설치되어 있지 않습니다"})
        await ws.close()
        return

    url_sent = False

    async def pump_stdout() -> None:
        nonlocal url_sent
        assert proc.stdout is not None
        while line := await proc.stdout.readline():
            text = line.decode(errors="ignore").rstrip()
            if not text:
                continue
            await ws.send_json({"type": "log", "text": text})
            if not url_sent:
                match = _CODEX_URL_RE.search(text)
                if match and "auth" in match.group(0).lower():
                    url_sent = True
                    await ws.send_json({"type": "url", "url": match.group(0)})

    async def watch_client() -> None:
        try:
            while True:
                data = json.loads(await ws.receive_text())
                if isinstance(data, dict) and data.get("type") == "cancel" and proc.returncode is None:
                    proc.terminate()
                    return
        except (WebSocketDisconnect, json.JSONDecodeError):
            if proc.returncode is None:
                proc.terminate()

    watch_task = asyncio.create_task(watch_client())
    try:
        await pump_stdout()
        await proc.wait()
        await ws.send_json({"type": "success"} if proc.returncode == 0 else {
            "type": "error", "message": f"login exited with {proc.returncode}"
        })
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        watch_task.cancel()
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


@router.get("/models")
async def list_models():
    """기본 엔진의 사용 가능 모델 목록."""
    engine = engine_registry.default()
    if engine is None:
        return {"models": []}
    return {"models": await engine.list_models()}


@router.get("/usage-limits")
async def usage_limits():
    """엔진이 지원하는 경우 계정의 사용량 한도 스냅샷을 반환한다.

    모든 엔진이 ChatGPT/Codex 계정 한도를 제공하는 것은 아니므로, 지원하지 않는
    엔진도 오류 대신 ``available: false`` 로 응답한다.
    """
    engine = engine_registry.default()
    reader = getattr(engine, "usage_limits", None) if engine is not None else None
    if not callable(reader):
        return {"available": False, "blocked": False, "reason": "이 AI 엔진은 사용량 정보를 제공하지 않습니다"}
    try:
        return await reader()
    except Exception as e:  # noqa: BLE001
        log.warning("failed to read AI usage limits: %s", e)
        return {"available": False, "blocked": False, "reason": "사용량 정보를 확인할 수 없습니다"}


@router.get("/runtime-info")
def get_runtime_info():
    """설정 화면에서 주입 프롬프트와 도구 실행 정책을 읽기 전용으로 확인한다."""
    return prompt_runtime_info()


class GitMetadataAccessRequest(BaseModel):
    enabled: bool


@router.get("/git-metadata-access")
def get_git_metadata_access():
    """벼리의 사용자 동의 기반 Git 메타데이터 쓰기 권한 상태를 반환한다."""
    return git_metadata_access.status()


@router.put("/git-metadata-access")
async def put_git_metadata_access(req: GitMetadataAccessRequest):
    """앱 소유 Codex 규칙을 갱신하고 다음 벼리 요청을 새 서버로 시작한다."""
    if orchestrator.has_active_runs():
        raise HTTPException(
            status_code=409,
            detail="실행 중인 Twill AI 요청이 있어 Git 권한을 바꿀 수 없습니다. 실행을 끝내거나 중단한 뒤 다시 시도해주세요.",
        )
    try:
        result = git_metadata_access.set_enabled(req.enabled)
    except git_metadata_access.GitMetadataAccessConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Git 권한 규칙을 저장하지 못했습니다: {exc}") from exc

    # Codex는 rules/를 시작할 때 읽는다. 다음 요청은 이 프로세스를 자동으로 다시 시작한다.
    await codex_app_server.stop()
    return {**result, "server_restarted": True}


class MemoryReviewReq(BaseModel):
    session_id: str
    run_id: str
    bullets: list[str] = Field(default_factory=list)


class MemoryReviewDiscardReq(BaseModel):
    session_id: str
    run_id: str


@router.post("/memory-reviews/approve")
def approve_memory_candidates(req: MemoryReviewReq):
    """사용자가 검토·편집한 후보를 해당 실행의 메모리 노트에 확정 저장한다."""
    try:
        return approve_memory_review(req.session_id, req.run_id, req.bullets)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/memory-reviews/discard")
def discard_memory_candidates(req: MemoryReviewDiscardReq):
    """사용자가 저장하지 않기로 한 후보를 세션에서 제거한다."""
    try:
        return discard_memory_review(req.session_id, req.run_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ─────────────────────────────────────────────────────────────
# 벼리 세션 (패널 탭 하나 = 세션 하나)
# ─────────────────────────────────────────────────────────────
@router.get("/sessions")
def list_sessions():
    return {"sessions": ai_sessions.list_sessions()}


@router.delete("/sessions")
async def delete_sessions():
    """진행 중인 실행을 중단한 뒤 저장된 모든 벼리 세션을 삭제한다."""
    run_ids: set[str] = set()
    for session in ai_sessions.list_sessions():
        active_run = session.get("active_run")
        if not isinstance(active_run, dict):
            candidate = session.get("last_run")
            active_run = candidate if isinstance(candidate, dict) and candidate.get("status") == "running" else None
        run_id = str((active_run or {}).get("run_id") or "")
        if run_id:
            run_ids.add(run_id)

    if run_ids:
        await asyncio.gather(
            *(orchestrator.interrupt(run_id) for run_id in run_ids),
            return_exceptions=True,
        )
    return {"deleted": ai_sessions.delete_all_sessions()}


class CreateSessionReq(BaseModel):
    kind: str = "chat"
    title: str = ""
    task_path: str | None = None
    # 카드에서 시작한 일반 대화의 출처. 태스크 실행은 task_path를 같은 출처로 사용한다.
    source_task_path: str | None = None
    scope_id: str | None = None
    section_id: str | None = None
    model: str | None = None
    effort: str | None = None


@router.post("/sessions")
def create_session(req: CreateSessionReq):
    source_path = req.source_task_path or (req.task_path if req.kind == "task" else None)
    source_task = None
    if source_path:
        try:
            source_task = ai_sessions.capture_task_source(source_path)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # 카드에서 시작한 대화는 UI가 보낸 값보다 카드에 저장된 프로젝트·섹션을 우선한다.
    # 이렇게 해야 카드 팝업을 열어 둔 채 속성을 수정해도 세션의 실행 문맥이 흔들리지 않는다.
    source_scope_id = source_task.get("scope_id") if source_task else None
    source_section_id = source_task.get("section_id") if source_task else None
    return ai_sessions.create_session(
        kind=req.kind,
        title=req.title,
        task_path=req.task_path,
        source_task=source_task,
        scope_id=source_scope_id or req.scope_id,
        section_id=source_section_id or req.section_id,
        model=req.model,
        effort=req.effort,
    )


class UpdateSessionReq(BaseModel):
    title: str | None = None
    model: str | None = None
    effort: str | None = None


@router.patch("/sessions/{session_id}")
def update_session(session_id: str, req: UpdateSessionReq):
    # model/effort 는 null 로 초기화(기본값 사용)할 수 있어야 하므로 exclude_unset 만 거른다
    fields = req.model_dump(exclude_unset=True)
    if "title" in fields:
        title = str(fields["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=422, detail="세션 이름을 입력해주세요")
        fields["title"] = title
        # PATCH 제목 변경은 사용자의 명시적 이름 변경이다. 첫 질문으로 제목을
        # 자동 생성하는 흐름이 이후에 이 이름을 덮어쓰지 않도록 표시한다.
        fields["title_mode"] = "manual"
    updated = ai_sessions.update_session(session_id, **fields)
    if not updated:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    return updated


@router.post("/sessions/{session_id}/cancel")
async def cancel_session_run(session_id: str):
    """새로고침 뒤에도 세션에 연결된 채팅·태스크 실행을 중단한다."""
    session = ai_sessions.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    active_run = session.get("active_run")
    # active_run 도입 전 이미 시작한 실행은 기존 running last_run에 run id가 남아 있다.
    if not isinstance(active_run, dict):
        candidate = session.get("last_run")
        active_run = candidate if isinstance(candidate, dict) and candidate.get("status") == "running" else None
    run_id = str((active_run or {}).get("run_id") or "")
    if not run_id:
        return {"ok": False}
    return {"ok": await orchestrator.interrupt(run_id)}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    if not ai_sessions.delete_session(session_id):
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")
    return {"deleted": True}


class RunOrderRequest(BaseModel):
    paths: list[str] = []


@router.post("/run-order")
async def plan_run_order(req: RunOrderRequest):
    """'전체 실행' 전 단계 — 카드 내용을 읽고 AI 가 실행 순서를 결정한다.

    기준: 선행 조건/의존성 → 같은 스코프 충돌 최소화 → 확인이 필요한 작업 우선.
    실패하면 원래 카드 순서를 그대로 반환 (planned_by: fallback).
    """
    import frontmatter as _fm

    from .. import config
    from ..ai.orchestrator import _run_background_json

    paths = [p for p in req.paths if isinstance(p, str) and p]
    fallback = {"order": paths, "reason": "", "planned_by": "fallback"}
    if len(paths) < 2:
        return {**fallback, "planned_by": "trivial"}
    engine = engine_registry.default()
    if engine is None:
        return fallback

    cards: list[dict] = []
    for path in paths:
        f = config.notes_dir() / path
        if not f.is_file():
            continue
        try:
            post = _fm.load(f)
        except Exception:  # noqa: BLE001
            continue
        cards.append(
            {
                "path": path,
                "title": str(post.get("title") or f.stem),
                "scope": str(post.get("scope") or ""),
                "summary": (post.content or "").strip()[:600],
            }
        )
    if len(cards) < 2:
        return fallback

    listing = "\n\n".join(
        f"[{c['path']}]\n제목: {c['title']}\n스코프: {c['scope'] or '(없음)'}\n내용: {c['summary']}"
        for c in cards
    )
    prompt = f"""다음 태스크 카드들을 하나씩 순서대로 실행하려 한다. 내용을 읽고 최적의 실행 순서를 정해라.

고려 기준:
1. 선행 조건/의존성 — 다른 카드의 기반이 되는 작업을 먼저
2. 같은 스코프(코드베이스)의 작업은 충돌이 적도록 연속 배치
3. 이후 작업의 방향을 좌우하는(결과 확인이 필요한) 작업을 앞쪽에

{listing}

아래 JSON 형식으로만 응답해라 (다른 설명 금지). order 에는 위 대괄호 안의 경로 문자열을 정확히 그대로, 전부 한 번씩 넣어라:
{{"order": ["경로1", "경로2"], "reason": "이 순서로 정한 이유 한두 문장 (한국어)"}}"""

    try:
        # 순서 판단은 가벼운 보조 작업 — 낮은 추론 강도로 빠르게
        thread_id = await engine.start_thread(cwd=str(config.notes_dir()), config={"effort": "low"})
        data = await _run_background_json(engine, thread_id, prompt)
    except Exception as e:  # noqa: BLE001
        log.info("run-order planning failed: %s", e)
        return fallback
    if not isinstance(data, dict) or not isinstance(data.get("order"), list):
        return fallback

    valid = set(paths)
    seen: set[str] = set()
    order: list[str] = []
    for x in data["order"]:
        p = str(x)
        if p in valid and p not in seen:
            order.append(p)
            seen.add(p)
    order += [p for p in paths if p not in seen]  # 누락 카드는 원래 순서대로 뒤에
    return {"order": order, "reason": str(data.get("reason") or ""), "planned_by": "ai"}


@router.websocket("/run")
async def run_ws(ws: WebSocket):
    """Orchestrator 를 통한 실행 스트림.

    클라이언트 → 서버:
      첫 메시지 (JSON): { task_path?, prompt?, scope_id?, section_id?, skills?, engine_id?, retry?,
                          model?, effort?, output_schema?,
                          max_time_sec?, memory_mode?, enable_learn? }
      이후 메시지 (JSON): { "type": "steer", "guidance": "..." }
                       또는 { "type": "cancel" }

    서버 → 클라이언트:
      orchestrator 이벤트가 그대로 흘러옴. run_id 이벤트로 실행 식별자 통보 후,
      client 가 그 run_id 에 대해 steer/cancel 할 수 있음.
    """
    await ws.accept()
    import asyncio

    current_run_id: str | None = None
    cancel_requested = False
    # 프런트 소스 변경이나 화면 재진입으로 WebSocket이 끊겨도 세션에 연결된 실행은 서버가
    # 끝까지 수행·기록한다. 새 화면은 세션 active_run으로 진행 상태와 중단 기능을 복원한다.
    # 세션 없는 일회성 실행만 연결 종료 시 비용 낭비를 막기 위해 중단한다.
    client_connected = True
    continue_after_disconnect = False

    async def watch_client_commands() -> None:
        """실행 중 클라이언트가 보내는 steer/cancel 을 orchestrator 로 전달."""
        nonlocal cancel_requested, client_connected
        try:
            while True:
                msg = await ws.receive_text()
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                if data.get("type") == "steer":
                    guidance = str(data.get("guidance") or "").strip()
                    client_message_id = str(data.get("client_message_id") or "").strip()
                    ok = False
                    turn_id = None
                    if guidance and current_run_id:
                        ok = await orchestrator.steer(
                            current_run_id,
                            guidance,
                            client_message_id=client_message_id or None,
                        )
                        # 성공한 추가 지시는 일반 사용자 메시지와 같이 보관한다. 그래야 실행
                        # 화면에서 말풍선으로 남고 새로고침 뒤에도 어떤 지시를 보냈는지 확인할 수 있다.
                        if ok and req.session_id:
                            try:
                                ai_sessions.append_message(req.session_id, "user", guidance)
                            except Exception:  # noqa: BLE001
                                log.exception("steer guidance session persistence failed")
                        if ok:
                            turn_id = orchestrator.active_turn_id(current_run_id)
                    await ws.send_json(
                        {
                            "type": "steer_ack",
                            "ok": ok,
                            "client_message_id": client_message_id,
                            "turn_id": turn_id,
                        }
                    )
                elif data.get("type") == "cancel" and current_run_id:
                    ok = await orchestrator.interrupt(current_run_id)
                    await ws.send_json({"type": "cancel_ack", "ok": ok})
                elif data.get("type") == "cancel":
                    # thread/run_id가 만들어지기 전에 누른 중단도 버리지 않는다. run_id 이벤트를
                    # 받는 즉시 아래 스트림 루프에서 실제 interrupt를 수행한다.
                    cancel_requested = True
                    await ws.send_json({"type": "cancel_ack", "ok": True, "pending": True})
        except WebSocketDisconnect:
            client_connected = False
            if current_run_id and not continue_after_disconnect:
                await orchestrator.interrupt(current_run_id)

    try:
        first = await ws.receive_text()
        try:
            data = json.loads(first)
        except json.JSONDecodeError:
            await ws.send_json({"type": "error", "message": "요청은 JSON 이어야 합니다"})
            await ws.close()
            return
        if not isinstance(data, dict):
            await ws.send_json({"type": "error", "message": "요청 형식이 올바르지 않습니다"})
            await ws.close()
            return

        req = RunRequest(
            task_path=data.get("task_path") or None,
            prompt=str(data.get("prompt") or ""),
            scope_id=data.get("scope_id") or None,
            section_id=data.get("section_id") or None,
            skills=list(data.get("skills") or []),
            engine_id=data.get("engine_id") or None,
            model=data.get("model") or None,
            effort=data.get("effort") or None,
            output_schema=data.get("output_schema") or None,
            max_time_sec=data.get("max_time_sec"),
            # 구형 자동 저장 opt-in도 정확한 JSON boolean true만 허용한다. 신규 흐름은
            # memory_mode를 쓰며, 태스크에서 생략하면 워크스페이스 설정을 따른다.
            enable_learn=data.get("enable_learn") is True,
            memory_mode=data.get("memory_mode") if isinstance(data.get("memory_mode"), str) else None,
            session_id=data.get("session_id") or None,
            current_path=data.get("current_path") or None,
            context_text=data.get("context") or None,
            include_document=bool(data.get("include_document", False)),
            retry=bool(data.get("retry", False)),
            # 채팅 입력의 @ 멘션은 명시적으로 선택된 노트만 본문 컨텍스트로 확장한다.
            # 키가 없으면 기존 클라이언트와의 호환을 위해 orchestrator 가 기존 규칙을 유지한다.
            mention_paths=[str(path) for path in data["mention_paths"] if isinstance(path, str)]
            if isinstance(data.get("mention_paths"), list)
            else None,
            images=[str(u) for u in data.get("images") or [] if isinstance(u, str)],
            image_attachments=[item for item in data.get("image_attachments") or [] if isinstance(item, dict)],
            display_prompt=str(data.get("display_prompt")) if data.get("display_prompt") else None,
            files=[f for f in data.get("files") or [] if isinstance(f, dict)],
        )
        continue_after_disconnect = bool(req.session_id)

        watcher_task = asyncio.create_task(watch_client_commands())

        async for ev in orchestrator.run(req):
            if ev.get("type") == "run_id":
                current_run_id = ev.get("run_id")
                if cancel_requested and current_run_id:
                    ok = await orchestrator.interrupt(current_run_id)
                    await ws.send_json({"type": "cancel_ack", "ok": ok})
                    cancel_requested = False
            if client_connected:
                try:
                    await ws.send_json(ev)
                except Exception:  # noqa: BLE001
                    client_connected = False
                    # 세션 실행은 연결 없이도 계속 소비해 대화/실행 상태를 정상적으로
                    # 마무리한다. 세션 없는 일회성 실행만 즉시 중단한다.
                    if current_run_id and not continue_after_disconnect:
                        await orchestrator.interrupt(current_run_id)
        if client_connected:
            try:
                await ws.send_json({"type": "done"})
            except Exception:  # noqa: BLE001
                pass
        watcher_task.cancel()
    except WebSocketDisconnect:
        if current_run_id:
            await orchestrator.interrupt(current_run_id)
    except Exception as e:  # noqa: BLE001
        log.exception("run_ws error")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
