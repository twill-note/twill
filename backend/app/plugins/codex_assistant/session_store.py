"""Codex 플러그인 세션 저장소.

세션 자체(대화 히스토리)는 codex CLI가 관리하므로 여기서는 워크스페이스별로
`thread_id`, 마지막 프롬프트 요약, 갱신 시각 정도만 보관한다.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from ... import config

STORE_FILE = "sessions.json"


def _path() -> Path:
    return config.plugin_data_dir("codex_assistant") / STORE_FILE


def _load() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("sessions"), list):
            return data
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return {"sessions": []}


def _save(data: dict) -> None:
    _path().parent.mkdir(parents=True, exist_ok=True)
    _path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def list_sessions(workspace: str | None = None) -> list[dict]:
    data = _load()
    sessions = data["sessions"]
    if workspace:
        sessions = [s for s in sessions if s.get("workspace") == workspace]
    return sorted(sessions, key=lambda s: s.get("updated_at", 0), reverse=True)


def create_session(workspace: str, title: str = "", cwd: str = "", model: str | None = None, effort: str | None = None) -> dict:
    now = time.time()
    session = {
        "id": str(uuid.uuid4()),
        "workspace": workspace,
        "cwd": cwd or workspace,
        "title": title or "새 대화",
        "thread_id": None,
        "model": model,
        "effort": effort,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    data = _load()
    data["sessions"].append(session)
    _save(data)
    return session


def get_session(session_id: str) -> dict | None:
    for s in _load()["sessions"]:
        if s.get("id") == session_id:
            return s
    return None


def update_session(session_id: str, **fields: Any) -> dict | None:
    data = _load()
    for s in data["sessions"]:
        if s.get("id") == session_id:
            s.update(fields)
            s["updated_at"] = time.time()
            _save(data)
            return s
    return None


def append_message(session_id: str, role: str, content: str) -> dict | None:
    data = _load()
    for s in data["sessions"]:
        if s.get("id") == session_id:
            s.setdefault("messages", []).append(
                {"role": role, "content": content, "ts": time.time()}
            )
            s["updated_at"] = time.time()
            _save(data)
            return s
    return None


def delete_session(session_id: str) -> bool:
    data = _load()
    before = len(data["sessions"])
    data["sessions"] = [s for s in data["sessions"] if s.get("id") != session_id]
    if len(data["sessions"]) != before:
        _save(data)
        return True
    return False


def clear_all() -> None:
    """플러그인 삭제 시 호출."""
    p = _path()
    if p.exists():
        try:
            p.unlink()
        except OSError:
            pass
