"""AI 세션 저장소 (앱 코어 레벨).

'벼리' 패널의 세션 하나 = 상단 탭 하나. 챗 세션과 태스크 실행 세션을 같은 저장소에서 관리한다.
과거에는 codex 플러그인이 자체 세션 저장소를 가졌지만, 오케스트레이터 중심 통합에 따라
세션은 엔진과 무관한 앱 데이터가 되었다 — 저장 위치도 워크스페이스 로컬(.ai-orchestrator/)로
옮겨서 "모든 상태는 파일" 원칙을 따른다.

세션 스키마:
  id          : uuid
  kind        : "chat" | "task"
  title       : 탭 제목 (챗은 첫 프롬프트에서 자동, 태스크는 카드 제목)
  title_mode  : "suggested" | "generated" | "manual" (사용자 이름 변경 보호)
  task_path   : 태스크 세션일 때 카드 노트 경로 (워크스페이스 상대)
  source_task : 카드에서 시작한 세션의 출처 스냅샷. 일반 대화에는 없음.
                {card_id, path, title, last_path, last_title, scope_id, section_id}
  scope_id    : 실행 스코프 id (동시 실행 직렬화 판단에 사용)
  last_scope_label: 삭제된 스코프를 쓰던 과거 세션의 표시용 마지막 프로젝트 이름 (실행에는 미사용)
  section_id  : 섹션 전용 메모리/후속 태스크의 컨텍스트를 이어가기 위한 섹션 id
  thread_id   : 엔진 스레드 id (대화 이어가기)
  engine_id   : 스레드를 만든 엔진 (다른 엔진으로 resume 방지)
  model/effort: 세션별 오버라이드 (없으면 워크스페이스 기본값)
  messages    : [{role, content, ts, images?}] — 챗 히스토리. images는 채팅에서 다시
                표시할 [{url, name?, alt?}] 메타데이터이며 이미지 바이트는 assets에 저장한다.
  active_run  : 현재 서버에서 계속 수행 중인 채팅·태스크 실행 정보. 브라우저 새로고침 뒤에도
                진행 상태와 중단 동작을 복원하는 데 사용한다.
  last_run    : 마지막 실행의 종료 상태. 태스크는 run log·카드 상태도 함께 저장하고,
                새로고침 뒤 실행 요약과 중단·오류 안내를 복원한다.
  memory_review: 마지막 태스크에서 추출되어 사용자 승인 대기 중인 메모리 후보와 저장 문맥.
  memory_saved : 승인 또는 자동 모드로 가장 최근에 확정 저장한 메모리 결과.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

import frontmatter

from .. import config

STORE_FILE = "sessions.json"
TASK_SOURCE_ID_KEY = "source_card_id"


def _source_note_path(path: str) -> Path:
    """세션 출처로 쓸 일반 노트 경로만 안전하게 해석한다.

    세션 JSON은 사용자가 백업·복원할 수 있는 파일이므로, 여기에 들어 있는 과거 경로를
    그대로 ``Path``에 넘기면 숨김 데이터나 워크스페이스 밖 파일을 읽을 여지가 있다.
    출처 해석은 일반 노트와 같은 범위에서만 한다.
    """
    raw = str(path or "").strip().strip("/")
    if not raw or not raw.endswith(".md"):
        raise ValueError("태스크 카드 경로가 올바르지 않습니다")
    root = config.notes_dir().resolve()
    candidate = (root / raw).resolve()
    if candidate == root or root not in candidate.parents:
        raise ValueError("태스크 카드 경로가 노트 워크스페이스 밖입니다")
    relative = candidate.relative_to(root)
    if any(part.startswith(".") or part in config.EXCLUDED_DIRS for part in relative.parts):
        raise ValueError("태스크 카드 경로가 올바르지 않습니다")
    return candidate


def _card_title(post: frontmatter.Post, path: Path) -> str:
    return str(post.get("title") or "").strip() or path.stem


def capture_task_source(path: str) -> dict:
    """카드 출처의 불변 스냅샷과 이동 추적용 식별자를 만든다.

    경로만 저장하면 카드가 이름 변경 또는 이동된 뒤에는 과거 대화가 어느 카드에서
    시작했는지 복원할 수 없다. 카드 frontmatter의 UUID는 카드가 앱 안에서 이동돼도
    유지되며, 세션에는 시작 시점의 제목·경로도 별도로 보존한다.
    """
    card_path = _source_note_path(path)
    if not card_path.is_file():
        raise ValueError("원본 태스크 카드를 찾을 수 없습니다")
    try:
        post = frontmatter.load(card_path)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("원본 태스크 카드를 읽을 수 없습니다") from exc

    source_id = str(post.get(TASK_SOURCE_ID_KEY) or "").strip()
    if not source_id:
        source_id = str(uuid.uuid4())
        post[TASK_SOURCE_ID_KEY] = source_id
        # 이 키는 카드 식별자일 뿐 사용자에게 보이는 제목·본문을 바꾸지 않는다.
        card_path.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")

    root = config.notes_dir().resolve()
    relative = card_path.relative_to(root).as_posix()
    title = _card_title(post, card_path)
    scope_id = str(post.get("scope") or "").strip() or None
    section_id = str(post.get("section_id") or "").strip() or None
    return {
        "card_id": source_id,
        # path/title은 시작 당시 값으로 절대 덮어쓰지 않는다. 삭제 뒤에도 이 정보가 남는다.
        "path": relative,
        "title": title,
        # 마지막으로 확인한 위치·제목은 이동/이름 변경 뒤 삭제됐을 때의 읽기 전용 안내에 쓴다.
        "last_path": relative,
        "last_title": title,
        "scope_id": scope_id,
        "section_id": section_id,
    }


def _source_card_at(path: str, card_id: str) -> tuple[Path, frontmatter.Post] | None:
    """저장된 위치에서 카드 식별자가 일치하는지 확인한다."""
    try:
        candidate = _source_note_path(path)
        if not candidate.is_file():
            return None
        post = frontmatter.load(candidate)
    except Exception:  # noqa: BLE001
        return None
    if str(post.get(TASK_SOURCE_ID_KEY) or "").strip() != card_id:
        return None
    return candidate, post


def _find_source_card(card_id: str, known_paths: list[str]) -> tuple[Path, frontmatter.Post] | None:
    """기존 경로가 바뀐 경우 UUID로 워크스페이스의 최신 카드를 찾는다."""
    for known_path in known_paths:
        found = _source_card_at(known_path, card_id)
        if found is not None:
            return found

    root = config.notes_dir().resolve()
    # 파일 트리 이동/이름 변경은 frontmatter를 유지하므로 일반 노트만 다시 훑으면 된다.
    for candidate in root.rglob("*.md"):
        try:
            relative = candidate.relative_to(root)
            if any(part.startswith(".") or part in config.EXCLUDED_DIRS for part in relative.parts):
                continue
            post = frontmatter.load(candidate)
        except Exception:  # noqa: BLE001
            continue
        if str(post.get(TASK_SOURCE_ID_KEY) or "").strip() == card_id:
            return candidate, post
    return None


def _task_source_runtime(source: object) -> tuple[dict | None, dict | None, bool]:
    """세션용 출처 상태와 갱신된 영속 스냅샷을 함께 계산한다.

    반환의 세 번째 값은 ``source_task``를 디스크에 다시 저장해야 하는지다. 마지막 제목을
    갱신해 두어야, 다음에 카드가 삭제된 뒤에도 가장 최근 이름을 안내할 수 있다.
    """
    if not isinstance(source, dict):
        return None, None, False
    card_id = str(source.get("card_id") or "").strip()
    original_path = str(source.get("path") or "").strip()
    original_title = str(source.get("title") or "").strip()
    if not card_id or not original_path or not original_title:
        return None, None, False

    saved = dict(source)
    known_paths = [str(saved.get("last_path") or ""), original_path]
    found = _find_source_card(card_id, [path for path in known_paths if path])
    if found is None:
        # 링크를 만들지 않는다. 마지막으로 확인한 제목만 표시해 과거 대화의 문맥을 보존한다.
        title = str(saved.get("last_title") or original_title).strip() or original_title
        return {"state": "deleted", "path": None, "title": title}, saved, False

    path, post = found
    root = config.notes_dir().resolve()
    current_path = path.relative_to(root).as_posix()
    current_title = _card_title(post, path)
    changed = saved.get("last_path") != current_path or saved.get("last_title") != current_title
    if changed:
        saved["last_path"] = current_path
        saved["last_title"] = current_title
    return {"state": "available", "path": current_path, "title": current_title}, saved, changed


def _path() -> Path:
    d = config.notes_dir() / ".ai-orchestrator"
    d.mkdir(parents=True, exist_ok=True)
    return d / STORE_FILE


def _load() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("sessions"), list):
            return data
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return {"sessions": []}


def _save(data: dict) -> None:
    _path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _run_message(status: str) -> str:
    if status == "cancelled":
        return "요청에 따라 이 턴을 중단했습니다."
    if status == "error":
        return "이 태스크 실행은 오류로 종료되었습니다."
    return "이 태스크 실행이 완료되었습니다."


def _migrate_legacy_task_runs(data: dict) -> bool:
    """`last_run`이 없던 태스크 세션을 동일 thread_id의 run log로 한 번 보정한다."""
    legacy = [
        session
        for session in data["sessions"]
        if session.get("kind") == "task" and not session.get("last_run") and session.get("thread_id")
    ]
    if not legacy:
        return False

    root = config.notes_dir()
    runs_dir = root / "runs"
    if not runs_dir.is_dir():
        return False

    by_thread: dict[str, tuple[float, dict]] = {}
    for path in runs_dir.glob("*.md"):
        try:
            post = frontmatter.load(path)
        except Exception:  # noqa: BLE001
            continue
        thread_id = str(post.get("thread_id") or "")
        task_path = str(post.get("task") or "")
        if not thread_id or not task_path:
            continue
        status = str(post.get("status") or "completed")
        try:
            completed_at = float(post.get("completed_at") or 0)
        except (TypeError, ValueError):
            completed_at = 0.0
        candidate = {
            "run_id": path.stem,
            "status": status,
            "message": _run_message(status),
            "run_log_path": path.relative_to(root).as_posix(),
            "task_path": task_path,
            "task_status": "blocked" if status in {"cancelled", "error"} else "verify",
            "completed_at": completed_at,
        }
        previous = by_thread.get(thread_id)
        if previous is None or completed_at >= previous[0]:
            by_thread[thread_id] = (completed_at, candidate)

    changed = False
    for session in legacy:
        candidate = by_thread.get(str(session.get("thread_id")))
        if candidate is None:
            continue
        _, last_run = candidate
        if last_run["task_path"] != str(session.get("task_path") or ""):
            continue
        session["last_run"] = last_run
        changed = True
    return changed


def _with_task_card_runtime(session: dict) -> dict:
    """세션 API에만 태스크 카드의 배치·상태 메타를 보탠다.

    카드가 가진 batch_id/order는 실행 대기열 복원의 기준이다. 세션 파일을 다시 쓰지 않아
    카드의 최신 frontmatter가 항상 우선하도록 한다.
    """
    result = dict(session)
    task_path = result.get("task_path")
    if result.get("kind") != "task" or not isinstance(task_path, str) or not task_path:
        return result
    try:
        post = frontmatter.load(config.notes_dir() / task_path)
    except Exception:  # noqa: BLE001
        return result
    result["task_status"] = str(post.get("status") or "")
    batch_id = post.get("batch_id")
    if isinstance(batch_id, str) and batch_id:
        result["batch_id"] = batch_id
    batch_order = post.get("batch_order")
    if isinstance(batch_order, (int, float)):
        result["batch_order"] = int(batch_order)
    return result


def _with_task_source_runtime(session: dict) -> tuple[dict, bool]:
    """세션 API 응답에 카드 출처의 최신 위치 또는 삭제 상태를 덧붙인다."""
    result = dict(session)
    runtime, saved_source, changed = _task_source_runtime(session.get("source_task"))
    if runtime is None:
        return result, False
    if changed and saved_source is not None:
        session["source_task"] = saved_source
        result["source_task"] = saved_source
    result["source_task_status"] = runtime
    return result, changed


def list_sessions() -> list[dict]:
    data = _load()
    changed = _migrate_legacy_task_runs(data)
    results: list[dict] = []
    for session in data["sessions"]:
        sourced, source_changed = _with_task_source_runtime(session)
        changed = changed or source_changed
        results.append(_with_task_card_runtime(sourced))
    if changed:
        _save(data)
    return sorted(results, key=lambda s: s.get("updated_at", 0), reverse=True)


def reconcile_stale_active_runs() -> int:
    """프로세스 재시작 뒤 남은 ``active_run``을 재시도 가능한 오류 상태로 정리한다.

    브라우저 새로고침은 기존 서버 프로세스가 실행을 계속 소비하므로 active_run을 보존한다.
    반면 서버 프로세스가 재시작되면 메모리의 orchestrator 실행은 더 이상 존재하지 않는다.
    그 상태를 running으로 남기면 UI가 영구 대기하고 취소 API도 대상 run을 찾지 못한다.
    """
    data = _load()
    now = time.time()
    changed = 0
    for session in data["sessions"]:
        active = session.get("active_run")
        if not isinstance(active, dict) or not active.get("run_id"):
            continue
        task_path = str(active.get("task_path") or session.get("task_path") or "")
        is_task = session.get("kind") == "task" or bool(task_path)
        session["active_run"] = None
        session["last_run"] = {
            "run_id": str(active["run_id"]),
            "status": "error",
            "message": (
                "서버가 재시작되어 진행 중이던 태스크 실행을 다시 시작해야 합니다."
                if is_task
                else "서버가 재시작되어 진행 중이던 요청을 다시 보내야 합니다."
            ),
            "run_log_path": active.get("run_log_path"),
            "task_path": task_path,
            "task_status": "blocked" if is_task else "",
            "completed_at": now,
        }
        session["updated_at"] = now
        if is_task and task_path:
            try:
                path = config.notes_dir() / task_path
                post = frontmatter.load(path)
                post["status"] = "blocked"
                if "current_run" in post:
                    del post["current_run"]
                path.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
            except Exception:  # noqa: BLE001
                pass
        changed += 1
    if changed:
        _save(data)
    return changed


def create_session(
    *,
    kind: str = "chat",
    title: str = "",
    task_path: str | None = None,
    source_task: dict | None = None,
    scope_id: str | None = None,
    section_id: str | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> dict:
    now = time.time()
    session = {
        "id": str(uuid.uuid4()),
        "kind": kind if kind in ("chat", "task") else "chat",
        "title": title or ("새 대화" if kind == "chat" else "태스크 실행"),
        # 문서 기준 제목 후보는 첫 질문을 보내기 전까지만 유지한다. 이후에는
        # 첫 질문으로 만든 제목 또는 사용자가 정한 제목을 보존한다.
        "title_mode": "suggested" if kind == "chat" else "manual",
        "task_path": task_path,
        "scope_id": scope_id,
        "section_id": section_id,
        "thread_id": None,
        "engine_id": None,
        "model": model,
        "effort": effort,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }
    # 선택 필드로 유지해 과거 세션 JSON과 일반 채팅의 모양을 바꾸지 않는다.
    if isinstance(source_task, dict):
        session["source_task"] = dict(source_task)
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
            # 현재 문서 자동 참조를 제거하면서 남은 구 버전 세션 메타도 실제 파일에서 지운다.
            # None 은 일반 필드에는 유효한 값일 수 있으므로 이 두 레거시 키에만 삭제 신호로 쓴다.
            for legacy_key in ("document_context", "context_path"):
                if fields.get(legacy_key, object()) is None:
                    s.pop(legacy_key, None)
                    fields.pop(legacy_key, None)
            s.update(fields)
            s["updated_at"] = time.time()
            _save(data)
            return s
    return None


def invalidate_scope_instruction_threads(scope_ids: set[str]) -> int:
    """프로젝트 AGENTS.md가 바뀐 스코프의 Codex 스레드를 다음 실행에서 교체한다.

    thread_id 자체를 지우면 대화 인계 근거도 사라진다. 대신 스레드 시작 당시의 도구/지시
    버전만 제거해 orchestrator의 기존 마이그레이션 경로가 최근 대화를 제한적으로 넘긴 뒤
    새 cwd 컨텍스트에서 AGENTS.md를 다시 탐색하게 한다.
    """
    normalized = {str(scope_id).strip() for scope_id in scope_ids if str(scope_id).strip()}
    if not normalized:
        return 0
    data = _load()
    changed = 0
    for session in data["sessions"]:
        if (
            session.get("thread_id")
            and str(session.get("scope_id") or "") in normalized
            and session.get("engine_id") in {None, "codex"}
        ):
            session.pop("engine_toolset_version", None)
            session["updated_at"] = time.time()
            changed += 1
    if changed:
        _save(data)
    return changed


def append_message(
    session_id: str,
    role: str,
    content: str,
    *,
    images: list[dict] | None = None,
) -> dict | None:
    normalized_images: list[dict[str, str]] = []
    for image in images or []:
        if not isinstance(image, dict):
            continue
        url = str(image.get("url") or "").strip()
        if not url or len(url) > 2048:
            continue
        record = {"url": url}
        name = str(image.get("name") or "").strip()
        alt = str(image.get("alt") or "").strip()
        if name:
            record["name"] = name[:200]
        if alt:
            record["alt"] = alt[:300]
        normalized_images.append(record)

    data = _load()
    for s in data["sessions"]:
        if s.get("id") == session_id:
            message: dict[str, Any] = {"role": role, "content": content, "ts": time.time()}
            if normalized_images:
                message["images"] = normalized_images
            s.setdefault("messages", []).append(message)
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


def delete_all_sessions() -> int:
    """저장된 벼리 세션을 한 번에 비우고 삭제한 개수를 반환한다."""
    data = _load()
    deleted = len(data["sessions"])
    if deleted:
        data["sessions"] = []
        _save(data)
    return deleted
