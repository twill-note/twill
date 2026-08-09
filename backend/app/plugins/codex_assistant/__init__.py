"""Twill AI의 Codex 엔진 구현 모듈.

- OAuth 로그인은 시스템에 설치된 `codex` CLI 에 위임한다 (vibe와 동일 접근).
- 챗·태스크 실행은 모두 오케스트레이터(`/api/ai/run`)를 통해 흐른다 — 이 플러그인은
  엔진 어댑터(CodexEngine)를 레지스트리에 등록하고, codex 고유 기능(로그인/로그아웃/상태)만
  라우터로 노출한다. (과거 자체 챗 WebSocket·세션 저장은 오케스트레이터/코어 세션으로 이관됨.)

이 모듈은 과거 플러그인 구조의 구현 코드를 보존한 위치일 뿐, 현재 Twill AI는
`main.py`에서 항상 등록되는 코어 기능이다. 로그인 API도 `/api/ai/*`를 사용한다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from . import session_store
from .app_server import client as app_server, AppServerError
from .codex_engine import engine as codex_engine
from ...ai.engine import registry as engine_registry

log = logging.getLogger("plugins.codex_assistant")

MANIFEST = {
    "id": "codex_assistant",
    "core_feature": True,
    "name": "Twill AI (Codex 엔진)",
    "version": "0.2.0",
    "description": "Twill의 시스템 AI 'Twill AI'를 codex CLI 엔진으로 동작시킵니다. 설치하면 Twill AI 패널에서 대화·태스크 실행이 가능해집니다.",
    "permissions": ["subprocess:codex", "workspace:read"],
    "ui": {
        "selectionActions": [
            {"id": "codex-ask", "label": "Twill AI에게 질문", "icon": "🤖"},
        ],
        "slashItems": [
            {"id": "codex-ask", "title": "Twill AI에게 질문", "aliases": ["ask", "ai", "codex", "twill", "twill ai", "byeori", "벼리"]},
        ],
        "commands": [
            {"id": "codex-open", "title": "Twill AI 열기"},
        ],
    },
}


# ─────────────────────────────────────────────────────────────
# codex CLI 헬퍼
# ─────────────────────────────────────────────────────────────
def _codex_binary() -> str:
    return shutil.which("codex") or "codex"


URL_RE = re.compile(r"https?://[\w./%?=&#:_-]+")


def _find_url(text: str) -> str | None:
    m = URL_RE.search(text)
    return m.group(0) if m else None


async def _codex_status() -> dict:
    """`codex login status` 실행 후 결과 파싱."""
    try:
        proc = await asyncio.create_subprocess_exec(
            _codex_binary(),
            "login",
            "status",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
    except FileNotFoundError:
        return {"available": False, "logged_in": False, "detail": "codex CLI가 설치되어 있지 않습니다"}
    text = (out.decode(errors="ignore") + err.decode(errors="ignore")).strip()
    # codex login status 는 로그인 시 이메일이나 조직명을 반환하고, 미로그인 시 안내 메시지를 반환한다.
    logged_in = proc.returncode == 0 and (
        "logged in" in text.lower() or "@" in text or "signed in" in text.lower()
    )
    return {
        "available": True,
        "logged_in": bool(logged_in),
        "detail": text,
    }


# ─────────────────────────────────────────────────────────────
# 라우터
# ─────────────────────────────────────────────────────────────
router = APIRouter(tags=["codex_assistant"])


@router.get("/status")
async def status():
    return await _codex_status()


@router.post("/logout")
async def logout():
    binary = _codex_binary()
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "logout", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
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
    """codex login 프로세스 출력을 클라이언트로 릴레이.

    프로토콜:
      client → (선택) {"type": "cancel"}
      server → {"type": "url", "url": "..."}
      server → {"type": "log", "text": "..."}
      server → {"type": "success"} 또는 {"type": "error", "message": "..."}
    """
    await ws.accept()
    binary = _codex_binary()
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
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
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="ignore").rstrip()
            if text:
                await ws.send_json({"type": "log", "text": text})
                if not url_sent:
                    url = _find_url(text)
                    if url and "auth" in url.lower():
                        url_sent = True
                        await ws.send_json({"type": "url", "url": url})

    async def watch_client() -> None:
        try:
            while True:
                data = await ws.receive_text()
                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "cancel":
                    if proc.returncode is None:
                        proc.terminate()
                    return
        except WebSocketDisconnect:
            if proc.returncode is None:
                proc.terminate()

    try:
        await asyncio.gather(pump_stdout(), watch_client(), return_exceptions=True)
        await proc.wait()
        if proc.returncode == 0:
            await ws.send_json({"type": "success"})
        else:
            await ws.send_json({"type": "error", "message": f"login exited with {proc.returncode}"})
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


# ─────────────────────────────────────────────────────────────
# 모델 목록 (codex app-server 에서 조회)
# ─────────────────────────────────────────────────────────────
@router.get("/models")
async def list_models(include_hidden: bool = False):
    try:
        await app_server.ensure_started()
        result = await app_server.request(
            "model/list", {"includeHidden": include_hidden, "limit": 50}, timeout=15
        )
    except AppServerError as e:
        raise HTTPException(status_code=500, detail=str(e))
    models = []
    for m in result.get("data", []):
        if m.get("hidden") and not include_hidden:
            continue
        models.append(
            {
                "id": m.get("id"),
                "model": m.get("model"),
                "displayName": m.get("displayName"),
                "description": m.get("description"),
                "isDefault": m.get("isDefault", False),
                "defaultEffort": m.get("defaultReasoningEffort"),
                "supportedEfforts": [
                    e.get("reasoningEffort") for e in m.get("supportedReasoningEfforts", []) if e.get("reasoningEffort")
                ],
            }
        )
    return {"models": models}


# ─────────────────────────────────────────────────────────────
# 라이프사이클
# ─────────────────────────────────────────────────────────────
def on_install() -> None:
    # AI 엔진 레지스트리에 codex 를 등록. Orchestrator 는 registry 를 통해서만 엔진에 접근.
    engine_registry.register(codex_engine, make_default=True)
    log.info("codex_assistant installed; engine 'codex' registered")


def on_uninstall() -> None:
    engine_registry.unregister(codex_engine.id)
    session_store.clear_all()
    try:
        asyncio.get_event_loop().create_task(app_server.stop())
    except RuntimeError:
        pass
    log.info("codex_assistant uninstalled; engine unregistered; sessions cleared")
