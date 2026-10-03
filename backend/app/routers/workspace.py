import base64
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import frontmatter
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import config, indexer, watcher
from .files import resolve_path

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

# 프로젝트 삭제는 스코프 행, sidebar sections, 태스크 frontmatter, 세션 메타를 함께
# 변경한다. 요청 두 개가 서로 섞여 한쪽만 참조를 지우지 않도록 서버 프로세스 안에서는
# 하나의 임계 구역으로 직렬화한다. 각 파일은 같은 파일시스템 안의 replace로 교체하고,
# 뒤 단계가 실패하면 원본 바이트를 복구한다.
_SCOPE_DELETION_LOCK = threading.RLock()
_SCOPE_AGENTS_LOCK = threading.RLock()
_PROJECT_PATH_LOCK = threading.RLock()
PROJECT_AGENTS_FILE = "AGENTS.md"
PROJECT_RUNTIME_DIR = ".projects"
PROJECT_AGENTS_TEMPLATE = """# 프로젝트 작업 지침

이 문서에서 이 프로젝트의 빌드·테스트·코딩 규칙을 관리합니다.
"""


@router.get("")
def get_workspace():
    return {"root": str(config.notes_dir()), "recent": config.recent_roots(), "home": str(Path.home())}


def _read_workspace_json() -> dict:
    p = config.notes_dir() / ".workspace.json"
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_workspace_json(data: dict) -> None:
    p = config.notes_dir() / ".workspace.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class SectionItem(BaseModel):
    id: str
    name: str
    expanded: bool = True
    items: list[str] = []
    # 섹션 생성 시 자동 등록되는 프로젝트 관리(스코프) 노트의 id. 사용자가 그 노트에 path를
    # 직접 채워야 실제 스코프로 쓸 수 있다 — 여기서 자동 주입하는 건 "빈 자리 등록"뿐.
    scope_id: str | None = None
    # API 응답에서만 쓰는 파생값. 실제 원본은 scopes/<scope_id>.md 의 path이며
    # .workspace.json 에 중복 저장하지 않는다.
    project_path: str | None = None


class SectionsPutRequest(BaseModel):
    sections: list[SectionItem]


class CreateProjectSectionRequest(BaseModel):
    name: str


class SetProjectPathRequest(BaseModel):
    path: str


class RenameProjectRequest(BaseModel):
    name: str


def _normalize_sections(data: dict) -> tuple[list[dict], bool]:
    """더는 쓰지 않는 섹션별 메모리/DB 설정만 제거하고 사용자 파일은 유지한다."""
    raw_sections = data.get("sections")
    if not isinstance(raw_sections, list):
        return [], False
    normalized: list[dict] = []
    changed = False
    for raw in raw_sections:
        if not isinstance(raw, dict):
            changed = True
            continue
        # ERD는 어느 폴더에나 저장할 수 있는 일반 파일이다. 기존 설정만 정리하고
        # 실제 `database/` 폴더와 그 안의 사용자가 만든 파일은 절대 지우지 않는다.
        item = dict(raw)
        removed_legacy_fields = "database_dir" in item or "memories_ref" in item
        item.pop("database_dir", None)
        item.pop("memories_ref", None)
        normalized.append(item)
        changed = changed or removed_legacy_fields
    return normalized, changed


def _create_scope_for_section(name: str) -> str:
    """섹션 하나 = 프로젝트 하나라는 설계에 따라, 섹션 생성 시 프로젝트 관리 테이블에
    빈 행을 자동으로 등록해준다. path(실제 스코프 위치)는 사용자가 프로젝트 관리에서
    직접 채워야 한다 — 여기서 자동으로 추정/주입하지 않는다.
    """
    from .db import CONFIG_FILE as DB_CONFIG_FILE, SCOPES_BOARD_PRESET  # 지연 import (순환 방지)

    root = config.notes_dir()
    scopes_dir = root / "scopes"
    scopes_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = scopes_dir / DB_CONFIG_FILE
    if not cfg_path.is_file():
        cfg_path.write_text(json.dumps(SCOPES_BOARD_PRESET, ensure_ascii=False, indent=2), encoding="utf-8")

    safe = re.sub(r'[/\\?%*:|"<>]', "-", name.strip()) or "프로젝트"
    p = scopes_dir / f"{safe}-{uuid.uuid4().hex[:6]}.md"
    post = frontmatter.Post("", project="", label=name, path="")
    p.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
    try:
        indexer.index_file(p.relative_to(root).as_posix())
    except Exception:  # noqa: BLE001
        pass
    return p.stem


def _safe_project_dir_name(name: str) -> str:
    safe = re.sub(r'[/\\?%*:|"<>]+', "-", name.strip()).strip(" .-")
    if not safe or safe.startswith("."):
        return "프로젝트"
    return safe


def _unique_project_dir(name: str) -> str:
    """워크스페이스 루트에서 충돌하지 않는 프로젝트 폴더 이름을 만든다."""
    root = config.notes_dir()
    base = _safe_project_dir_name(name)
    candidate = base
    number = 2
    while (root / candidate).exists() or candidate in config.TREE_HIDDEN_ROOT_DIRS:
        candidate = f"{base}-{number}"
        number += 1
    return candidate


def _validated_project_id(raw_id: str) -> str:
    project_id = str(raw_id or "").strip()
    if (
        not project_id
        or project_id.startswith(".")
        or "/" in project_id
        or "\\" in project_id
        or project_id != Path(project_id).name
    ):
        raise HTTPException(status_code=400, detail="올바르지 않은 프로젝트 식별자입니다")
    return project_id


def _ensure_scope_row(scope_id: str, name: str) -> Path:
    """기존 project/section 식별자를 바꾸지 않고 누락된 프로젝트 관리 행만 복원한다."""
    project_id = _validated_project_id(scope_id)
    from .db import CONFIG_FILE as DB_CONFIG_FILE, SCOPES_BOARD_PRESET  # 지연 import (순환 방지)

    root = config.notes_dir()
    scopes_dir = root / "scopes"
    scopes_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = scopes_dir / DB_CONFIG_FILE
    if not cfg_path.is_file():
        cfg_path.write_text(json.dumps(SCOPES_BOARD_PRESET, ensure_ascii=False, indent=2), encoding="utf-8")
    row = scopes_dir / f"{project_id}.md"
    if row.is_file():
        return row
    if row.exists():
        raise HTTPException(status_code=409, detail="프로젝트 관리 행 경로가 파일이 아닙니다")

    legacy_path = ""
    raw_legacy = _read_workspace_json().get("scopes")
    if isinstance(raw_legacy, list):
        legacy = next(
            (
                item
                for item in raw_legacy
                if isinstance(item, dict) and str(item.get("id") or "") == project_id
            ),
            None,
        )
        legacy_path = str((legacy or {}).get("path") or "").strip()
    post = frontmatter.Post("", project="", label=name, path=legacy_path)
    try:
        with row.open("x", encoding="utf-8") as handle:
            handle.write(frontmatter.dumps(post) + "\n")
    except FileExistsError:
        return row
    try:
        indexer.index_file(row.relative_to(root).as_posix())
    except Exception:  # noqa: BLE001
        pass
    return row


def project_runtime_root(scope_id: str, *, create: bool = True) -> Path:
    """코드 경로가 없는 프로젝트가 AI를 실행할 안전한 프로젝트별 cwd를 반환한다."""
    project_id = _validated_project_id(scope_id)
    workspace = config.notes_dir().resolve()
    runtime_base = workspace / PROJECT_RUNTIME_DIR
    if runtime_base.is_symlink():
        raise HTTPException(status_code=400, detail="프로젝트 실행 저장소가 심볼릭 링크일 수 없습니다")
    if create:
        runtime_base.mkdir(parents=True, exist_ok=True)
    try:
        resolved_base = runtime_base.resolve()
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 실행 저장소를 준비하지 못했습니다") from exc
    if resolved_base.parent != workspace:
        raise HTTPException(status_code=400, detail="프로젝트 실행 저장소 경로가 올바르지 않습니다")

    target = resolved_base / project_id
    if target.is_symlink():
        raise HTTPException(status_code=400, detail="프로젝트 실행 경로가 심볼릭 링크일 수 없습니다")
    if create:
        target.mkdir(parents=True, exist_ok=True)
    try:
        resolved = target.resolve()
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 실행 경로를 준비하지 못했습니다") from exc
    if resolved.parent != resolved_base:
        raise HTTPException(status_code=400, detail="프로젝트 실행 경로가 올바르지 않습니다")
    return resolved


def _ensure_agents_file(target: Path) -> bool:
    if target.is_symlink():
        raise HTTPException(status_code=400, detail="심볼릭 링크 AGENTS.md는 편집할 수 없습니다")
    if target.exists() and not target.is_file():
        raise HTTPException(status_code=409, detail="프로젝트의 AGENTS.md가 파일이 아닙니다")
    if target.is_file():
        return False
    try:
        with target.open("x", encoding="utf-8") as handle:
            handle.write(PROJECT_AGENTS_TEMPLATE)
        return True
    except FileExistsError:
        return False
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="프로젝트에 AGENTS.md를 만들 권한이 없습니다") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 AGENTS.md를 만들지 못했습니다") from exc


def _ensure_linked_agents(scope_id: str, target: Path) -> bool:
    """외부 경로를 처음 연결할 때 내부 프로젝트 지침을 잃지 않고 이어 붙인다."""
    if target.is_symlink():
        raise HTTPException(status_code=400, detail="심볼릭 링크 AGENTS.md는 편집할 수 없습니다")
    if target.exists():
        if not target.is_file():
            raise HTTPException(status_code=409, detail="프로젝트의 AGENTS.md가 파일이 아닙니다")
        return False
    internal = project_runtime_root(scope_id) / PROJECT_AGENTS_FILE
    try:
        content = internal.read_text(encoding="utf-8") if internal.is_file() else PROJECT_AGENTS_TEMPLATE
        with target.open("x", encoding="utf-8") as handle:
            handle.write(content)
        return True
    except FileExistsError:
        return False
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="프로젝트에 AGENTS.md를 만들 권한이 없습니다") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 AGENTS.md를 만들지 못했습니다") from exc


def _project_path(scope_id: str | None) -> str:
    if not scope_id:
        return ""
    try:
        return str(_scope_record(scope_id).get("path") or "").strip()
    except (HTTPException, OSError, UnicodeError, ValueError):
        return ""


def _project_response(item: dict) -> dict:
    response = dict(item)
    response["project_path"] = _project_path(str(item.get("scope_id") or "")) or None
    return response


def _ensure_project_migration(items: list[dict]) -> bool:
    """기존 section 저장값에 프로젝트 연결과 내부 AI 실행 위치를 무손실로 보강한다."""
    changed = False
    for item in items:
        scope_id = str(item.get("scope_id") or "").strip()
        if not scope_id:
            scope_id = _create_scope_for_section(str(item.get("name") or "프로젝트"))
            item["scope_id"] = scope_id
            changed = True
        else:
            _ensure_scope_row(scope_id, str(item.get("name") or "프로젝트"))
        with _SCOPE_AGENTS_LOCK:
            _ensure_agents_file(project_runtime_root(scope_id) / PROJECT_AGENTS_FILE)
    return changed


@router.get("/sections")
def get_sections():
    """사이드바 프로젝트 목록을 반환하고 기존 sections 저장값을 무손실 마이그레이션한다."""
    data = _read_workspace_json()
    sections, changed = _normalize_sections(data)
    changed = _ensure_project_migration(sections) or changed
    if changed:
        data["sections"] = sections
        _write_workspace_json(data)
    return {"sections": [_project_response(section) for section in sections]}


@router.put("/sections")
def put_sections(req: SectionsPutRequest):
    data = _read_workspace_json()
    out = []
    for s in req.sections:
        item = s.model_dump()
        item.pop("project_path", None)
        if not item.get("scope_id"):
            item["scope_id"] = _create_scope_for_section(item["name"])
        else:
            _ensure_scope_row(item["scope_id"], item["name"])
        with _SCOPE_AGENTS_LOCK:
            _ensure_agents_file(project_runtime_root(item["scope_id"]) / PROJECT_AGENTS_FILE)
        out.append(item)
    data["sections"] = out
    _write_workspace_json(data)
    return {"sections": [_project_response(section) for section in out]}


@router.post("/sections/project")
def create_project_section(req: CreateProjectSectionRequest):
    """새 프로젝트와 독립 문서 저장소를 코드 경로보다 먼저 만든다.

    ERD는 특정 database 폴더에 묶지 않는다. 사용자는 파일 트리의 어느 폴더에서나
    우클릭으로 새 테이블(ERD)을 만들 수 있다.
    """
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="프로젝트 이름을 입력해주세요")
    data = _read_workspace_json()
    sections, _ = _normalize_sections(data)
    item: dict = {
        "id": f"s-{uuid.uuid4().hex[:10]}",
        "name": name,
        "expanded": True,
        "items": [],
        "scope_id": _create_scope_for_section(name),
    }
    project_dir = _unique_project_dir(name)
    (config.notes_dir() / project_dir).mkdir(parents=True, exist_ok=True)
    item["items"] = [project_dir]
    with _SCOPE_AGENTS_LOCK:
        _ensure_agents_file(project_runtime_root(item["scope_id"]) / PROJECT_AGENTS_FILE)
    sections.append(item)
    data["sections"] = sections
    _write_workspace_json(data)
    return {"section": _project_response(item)}


@router.put("/sections/{section_id}/project-path")
def set_project_path(section_id: str, req: SetProjectPathRequest):
    """기존 문서·태스크·채팅 식별자를 유지한 채 코드·분석 폴더만 연결한다."""
    project_id = _validated_project_id(section_id)
    selected = Path(req.path).expanduser()
    try:
        selected = selected.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="프로젝트 경로를 확인할 수 없습니다") from exc
    if not selected.is_dir():
        raise HTTPException(status_code=400, detail="선택한 프로젝트 경로가 존재하는 폴더가 아닙니다")
    if selected == Path(selected.anchor):
        raise HTTPException(status_code=400, detail="파일시스템 루트는 프로젝트 경로로 사용할 수 없습니다")

    with _PROJECT_PATH_LOCK:
        data = _read_workspace_json()
        sections, changed = _normalize_sections(data)
        project = next((item for item in sections if str(item.get("id") or "") == project_id), None)
        if project is None:
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
        scope_id = str(project.get("scope_id") or "").strip()
        if not scope_id:
            scope_id = _create_scope_for_section(str(project.get("name") or "프로젝트"))
            project["scope_id"] = scope_id
            changed = True
        else:
            _ensure_scope_row(scope_id, str(project.get("name") or "프로젝트"))
        _, row = _scope_row_path(scope_id)
        try:
            post = frontmatter.load(row)
            post["path"] = str(selected)
            row.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail="프로젝트 경로를 저장하지 못했습니다") from exc
        if changed:
            data["sections"] = sections
            _write_workspace_json(data)
        with _SCOPE_AGENTS_LOCK:
            agents_created = _ensure_linked_agents(scope_id, selected / PROJECT_AGENTS_FILE)
        try:
            indexer.index_file(row.relative_to(config.notes_dir()).as_posix())
        except Exception:  # noqa: BLE001
            pass
        return {
            "section": _project_response(project),
            "path": str(selected),
            "agents_path": str((selected / PROJECT_AGENTS_FILE).resolve()),
            "agents_created": agents_created,
        }


@router.put("/sections/{section_id}/name")
def rename_project(section_id: str, req: RenameProjectRequest):
    """사이드바 프로젝트와 프로젝트 관리 행의 표시명을 함께 변경한다."""
    project_id = _validated_project_id(section_id)
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="프로젝트 이름을 입력해주세요")
    with _PROJECT_PATH_LOCK:
        data = _read_workspace_json()
        sections, _ = _normalize_sections(data)
        project = next((item for item in sections if str(item.get("id") or "") == project_id), None)
        if project is None:
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
        scope_id = str(project.get("scope_id") or "").strip()
        if not scope_id:
            scope_id = _create_scope_for_section(name)
            project["scope_id"] = scope_id
        row = _ensure_scope_row(scope_id, name)
        try:
            post = frontmatter.load(row)
            post["label"] = name
            row.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail="프로젝트 이름을 저장하지 못했습니다") from exc
        project["name"] = name
        data["sections"] = sections
        _write_workspace_json(data)
        try:
            indexer.index_file(row.relative_to(config.notes_dir()).as_posix())
        except Exception:  # noqa: BLE001
            pass
        return {"section": _project_response(project)}


@router.put("/scopes/{scope_id}/name")
def rename_scope_project(scope_id: str, req: RenameProjectRequest):
    """프로젝트 관리 행에서의 이름 변경을 연결된 사이드바 프로젝트에도 적용한다."""
    normalized_scope_id, _ = _scope_row_path(scope_id)
    data = _read_workspace_json()
    sections, _ = _normalize_sections(data)
    project = next(
        (item for item in sections if str(item.get("scope_id") or "") == normalized_scope_id),
        None,
    )
    if project is None:
        raise HTTPException(status_code=404, detail="연결된 사이드바 프로젝트를 찾을 수 없습니다")
    return rename_project(str(project.get("id") or ""), req)


class LegacyScope(BaseModel):
    id: str
    label: str = ""
    path: str = ""


class CodexDefaults(BaseModel):
    instructions_ref: str = "AGENTS.md"
    memories_ref: str = "MEMORIES.md"
    # GPT-5.6 3티어 중 terra: gpt-5.5 동급 성능에 비용 절반 — 앱 기본값 (orchestrator.DEFAULT_MODEL 과 일치)
    default_model: str = "gpt-5.6-terra"
    default_effort: str = "xhigh"
    default_approval: Literal["on-request", "never"] = "never"


class ExplorerSettings(BaseModel):
    # 기본값은 기존 동작과 동일하게 Markdown/ERD만 표시한다.
    show_all_files: bool = False


class WorkspaceSettingsModel(BaseModel):
    name: str = ""
    scopes: list[LegacyScope] = Field(default_factory=list)  # deprecated (SCOPES 보드로 대체) — 하위호환 유지
    codex: CodexDefaults = Field(default_factory=CodexDefaults)
    explorer: ExplorerSettings = Field(default_factory=ExplorerSettings)


@router.get("/settings")
def get_settings():
    data = _read_workspace_json()
    codex_raw = data.get("codex") if isinstance(data.get("codex"), dict) else {}
    # 빈 문자열("")은 값이 없는 것으로 취급 → 앱 기본값(terra/xhigh 등)이 그대로 노출되어
    # orchestrator 의 실제 fallback 동작과 UI 표시가 일치하게 한다.
    codex_clean = {
        k: v for k, v in codex_raw.items() if k in CodexDefaults.model_fields and v not in ("", None)
    }
    settings = WorkspaceSettingsModel(
        name=str(data.get("name") or ""),
        scopes=data.get("scopes") if isinstance(data.get("scopes"), list) else [],
        codex=CodexDefaults(**codex_clean),
        explorer=ExplorerSettings(
            **(data.get("explorer") if isinstance(data.get("explorer"), dict) else {})
        ),
    )
    return settings.model_dump()


@router.put("/settings")
def put_settings(req: WorkspaceSettingsModel):
    data = _read_workspace_json()
    data["name"] = req.name
    data["scopes"] = [s.model_dump() for s in req.scopes]
    data["codex"] = req.codex.model_dump()
    data["explorer"] = req.explorer.model_dump()
    _write_workspace_json(data)
    return req.model_dump()


AGENTS_TEMPLATE = """---
title: AGENTS
type: agents
---

# 워크스페이스 규약

이 워크스페이스에서 AI가 작업할 때 지켜야 할 규칙을 여기에 적어두세요.
Codex가 이 워크스페이스를 작업 디렉터리로 사용할 때 표준 AGENTS.md 규칙으로 읽습니다.
"""

MEMORIES_TEMPLATE = """---
title: MEMORIES
type: memories
auto_managed: true
---

# 학습된 사실들
"""


class EnsureSpecialNoteRequest(BaseModel):
    kind: Literal["agents", "memories"]


@router.post("/ensure-special-note")
def ensure_special_note(req: EnsureSpecialNoteRequest):
    """AGENTS.md / MEMORIES.md 가 없으면 템플릿으로 생성. 파일명은 codex 설정의 참조를 따름."""
    codex_cfg = _read_workspace_json().get("codex")
    codex_cfg = codex_cfg if isinstance(codex_cfg, dict) else {}
    if req.kind == "agents":
        ref = str(codex_cfg.get("instructions_ref") or "AGENTS.md")
        template = AGENTS_TEMPLATE
    else:
        ref = str(codex_cfg.get("memories_ref") or "MEMORIES.md")
        template = MEMORIES_TEMPLATE

    p = config.notes_dir() / ref
    created = False
    if not p.is_file():
        p.write_text(template, encoding="utf-8")
        created = True
        try:
            indexer.index_file(ref)
        except Exception:  # noqa: BLE001
            pass
    return {"path": ref, "created": created}


def _read_scopes_db(dir_rel: str = "scopes") -> list[dict]:
    """스코프 카탈로그(DB 폴더, 기본 `scopes/`)의 노트들을 스코프 목록으로 파싱.

    각 노트 frontmatter: project(select) / label(text) / path(path, 워크스페이스
    상대 또는 절대). id 는 파일명(stem) — label 이 바뀌어도 태스크의 scope 참조가
    깨지지 않도록 파일명을 고정 식별자로 쓴다 (db.py 프리셋과 동일한 규약).
    `path` 가 없는 노트도 문서 전용 프로젝트로 반환한다. AI는 이 경우 프로젝트별
    내부 실행 경로를 사용하므로 태스크와 직접 질문의 선택 대상에서 제외하지 않는다.
    """
    root = config.notes_dir()
    d = root / dir_rel
    if not d.is_dir():
        return []
    out: list[dict] = []
    for p in sorted(d.glob("*.md")):
        try:
            note = indexer.parse_note(p)
        except Exception:  # noqa: BLE001
            continue
        props = note.get("props") or {}
        raw_path = str(props.get("path") or "").strip()
        resolved_path = ""
        if raw_path:
            path_obj = Path(raw_path).expanduser()
            if not path_obj.is_absolute():
                path_obj = root / path_obj
            resolved_path = str(path_obj)
        out.append(
            {
                "id": p.stem,
                "label": str(props.get("label") or p.stem),
                "path": resolved_path,
                "has_path": bool(resolved_path),
                "project": str(props.get("project") or ""),
                "note_path": p.relative_to(root).as_posix(),
            }
        )
    return out


def _read_legacy_scopes() -> list[dict]:
    """`.workspace.json` 의 레거시 scopes 목록 (SCOPES 보드 도입 이전 방식). fallback 전용."""
    data = _read_workspace_json()
    scopes = data.get("scopes")
    if not isinstance(scopes, list):
        return []
    out = []
    for s in scopes:
        if isinstance(s, dict) and s.get("id") and s.get("path"):
            out.append(
                {
                    "id": str(s["id"]),
                    "label": str(s.get("label") or s["id"]),
                    "path": str(s["path"]),
                    "has_path": True,
                    "project": "",
                    "note_path": "",
                }
            )
    return out


@router.get("/scopes")
def list_scopes():
    """SCOPES 보드(`scopes/`) + 레거시 `.workspace.json` 스코프를 병합한 통합 목록.

    태스크 보드의 scope 컬럼 옵션, orchestrator 의 scope→cwd 해석이 여기 의존한다.
    DB 쪽이 우선이며, 같은 id 가 레거시에도 있으면 레거시 쪽은 무시.
    """
    db_scopes = _read_scopes_db()
    legacy_by_id = {scope["id"]: scope for scope in _read_legacy_scopes()}
    # 전환기 데이터에서 새 DB 행의 path가 비어 있고 같은 id의 레거시 경로가 있으면
    # 기존 코드 연결을 잃지 않는다. DB 행에 값이 생기는 즉시 DB가 다시 우선한다.
    for scope in db_scopes:
        legacy_scope = legacy_by_id.get(scope["id"])
        if not scope.get("path") and legacy_scope and legacy_scope.get("path"):
            scope["path"] = legacy_scope["path"]
            scope["has_path"] = True
    known_ids = {s["id"] for s in db_scopes}
    legacy = [s for s in legacy_by_id.values() if s["id"] not in known_ids]
    return {"scopes": db_scopes + legacy}


@dataclass
class _FileReplacement:
    """삭제 트랜잭션에서 원자적으로 교체할 워크스페이스 파일 한 개."""

    path: Path
    original: bytes
    replacement: bytes
    staged_path: Path | None = None


def _scope_row_path(scope_id: str) -> tuple[str, Path]:
    """스코프 id가 가리키는 프로젝트 관리 행을 안전하게 해석한다."""
    normalized = str(scope_id or "").strip()
    if (
        not normalized
        or normalized.startswith(".")
        or "/" in normalized
        or "\\" in normalized
        or normalized != Path(normalized).name
    ):
        raise HTTPException(status_code=400, detail="올바르지 않은 프로젝트 식별자입니다")

    root = config.notes_dir().resolve()
    scopes_dir = (root / "scopes").resolve()
    row = (scopes_dir / f"{normalized}.md").resolve()
    if row.parent != scopes_dir:
        raise HTTPException(status_code=400, detail="프로젝트 관리 행 경로가 올바르지 않습니다")
    if not row.is_file():
        raise HTTPException(status_code=404, detail="프로젝트 관리 행을 찾을 수 없습니다")
    return normalized, row


def _scope_record(scope_id: str) -> dict[str, str]:
    """프로젝트 관리 행 또는 레거시 설정에서 스코프의 실제 경로를 읽는다."""
    normalized = str(scope_id or "").strip()
    try:
        normalized, row = _scope_row_path(normalized)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
    else:
        try:
            post = frontmatter.load(row)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="프로젝트 관리 행을 읽을 수 없습니다") from exc
        raw_path = str(post.metadata.get("path") or "").strip()
        if not raw_path:
            legacy = next((item for item in _read_legacy_scopes() if item["id"] == normalized), None)
            raw_path = str((legacy or {}).get("path") or "").strip()
        return {
            "id": normalized,
            "label": str(post.metadata.get("label") or normalized),
            "path": raw_path,
        }

    legacy = next((item for item in _read_legacy_scopes() if item["id"] == normalized), None)
    if legacy is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
    return {
        "id": normalized,
        "label": str(legacy.get("label") or normalized),
        "path": str(legacy["path"]),
    }


def _scope_project_root(record: dict[str, str]) -> Path:
    raw_path = str(record.get("path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=422, detail="프로젝트에 코드·분석 경로가 연결되지 않았습니다")
    raw = Path(raw_path).expanduser()
    if not raw.is_absolute():
        raw = config.notes_dir() / raw
    try:
        root = raw.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="프로젝트 경로를 확인할 수 없습니다") from exc
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="설정한 프로젝트 경로가 존재하는 폴더가 아닙니다")
    if root == Path(root.anchor):
        raise HTTPException(status_code=400, detail="파일시스템 루트는 프로젝트 경로로 사용할 수 없습니다")
    return root


def _scope_agents_path(scope_id: str) -> tuple[dict[str, str], Path]:
    record = _scope_record(scope_id)
    root = _scope_project_root(record) if record.get("path") else project_runtime_root(record["id"])
    target = root / PROJECT_AGENTS_FILE
    if target.is_symlink():
        raise HTTPException(status_code=400, detail="심볼릭 링크 AGENTS.md는 편집할 수 없습니다")
    if target.exists() and not target.is_file():
        raise HTTPException(status_code=409, detail="프로젝트 경로의 AGENTS.md가 파일이 아닙니다")
    return record, target


def resolve_registered_scope_agents(
    raw_path: str,
    *,
    require_file: bool = True,
) -> tuple[Path, set[str]]:
    """외부 편집 요청을 등록된 프로젝트 루트의 실제 AGENTS.md로만 제한한다."""
    raw = str(raw_path or "").strip()
    candidate = Path(raw).expanduser()
    if not raw or "\x00" in raw or not candidate.is_absolute() or candidate.name != PROJECT_AGENTS_FILE:
        raise HTTPException(status_code=400, detail="등록된 프로젝트의 AGENTS.md 경로만 열 수 있습니다")
    if candidate.is_symlink():
        raise HTTPException(status_code=400, detail="심볼릭 링크 AGENTS.md는 편집할 수 없습니다")

    try:
        candidate_parent = candidate.parent.resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="AGENTS.md 경로를 확인할 수 없습니다") from exc

    matched_scope_ids: set[str] = set()
    matched_target: Path | None = None
    for scope in list_scopes()["scopes"]:
        scope_id = str(scope.get("id") or "").strip()
        if not scope_id:
            continue
        if not scope.get("path"):
            try:
                runtime_target = project_runtime_root(scope_id, create=False) / PROJECT_AGENTS_FILE
            except HTTPException:
                continue
            if candidate == runtime_target:
                if require_file and not runtime_target.is_file():
                    raise HTTPException(status_code=404, detail="AGENTS.md를 찾을 수 없습니다")
                matched_target = runtime_target
                matched_scope_ids.add(scope_id)
            continue
        try:
            root = _scope_project_root(scope)
        except HTTPException:
            continue
        if candidate_parent != root:
            continue
        target = root / PROJECT_AGENTS_FILE
        if target.is_symlink():
            raise HTTPException(status_code=400, detail="심볼릭 링크 AGENTS.md는 편집할 수 없습니다")
        if require_file and not target.is_file():
            raise HTTPException(status_code=404, detail="AGENTS.md를 찾을 수 없습니다")
        matched_target = target
        if scope_id:
            matched_scope_ids.add(scope_id)
    if matched_target is not None:
        return matched_target, matched_scope_ids
    raise HTTPException(status_code=403, detail="프로젝트 관리에 등록되지 않은 AGENTS.md 경로입니다")


def resolve_registered_scope_agents_path(raw_path: str, *, require_file: bool = True) -> Path:
    return resolve_registered_scope_agents(raw_path, require_file=require_file)[0]


@router.post("/scopes/{scope_id}/ensure-agents")
def ensure_scope_agents(scope_id: str):
    """외부 경로 또는 프로젝트별 내부 폴백에 AGENTS.md를 보장한다."""
    with _SCOPE_AGENTS_LOCK:
        record, target = _scope_agents_path(scope_id)
        created = (
            _ensure_linked_agents(record["id"], target)
            if record.get("path")
            else _ensure_agents_file(target)
        )

        if target.is_symlink() or not target.is_file():
            raise HTTPException(status_code=409, detail="프로젝트의 AGENTS.md를 일반 파일로 확인할 수 없습니다")
        return {
            "scope_id": record["id"],
            "label": record["label"],
            "path": str(target),
            "created": created,
            "internal": not bool(record.get("path")),
        }


def _is_visible_workspace_path(root: Path, path: Path) -> bool:
    """숨김·휴지통 경로는 태스크 카드 스캔에서 제외한다."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return False
    return not any(part.startswith(".") or part in config.EXCLUDED_DIRS for part in parts)


def _task_board_dirs(root: Path) -> list[Path]:
    """기본 tasks/와 사용자 지정 task_board 폴더를 모두 수집한다."""
    dirs: set[Path] = set()
    default_tasks = root / "tasks"
    if default_tasks.is_dir():
        dirs.add(default_tasks)

    for cfg_path in root.rglob(".db.json"):
        if not _is_visible_workspace_path(root, cfg_path):
            continue
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(cfg, dict) and cfg.get("kind") == "task_board":
            dirs.add(cfg_path.parent)
    return sorted(dirs, key=lambda path: str(path).lower())


def _scope_task_cards(root: Path, scope_id: str) -> list[tuple[Path, frontmatter.Post]]:
    """삭제 대상 scope를 참조하는 모든 태스크 카드와 파싱 결과를 반환한다."""
    cards: list[tuple[Path, frontmatter.Post]] = []
    for board_dir in _task_board_dirs(root):
        for path in sorted(board_dir.glob("*.md"), key=lambda candidate: candidate.name.lower()):
            try:
                post = frontmatter.load(path)
            except Exception:  # noqa: BLE001
                # 유효하지 않은 노트는 scope 참조를 확실히 판정할 수 없으므로 건드리지 않는다.
                continue
            if str(post.get("scope") or "") == scope_id:
                cards.append((path, post))
    return cards


def _read_sessions_file(root: Path) -> tuple[Path, dict | None]:
    """세션 파일은 없거나 손상되어도 프로젝트 삭제 자체를 막지 않는 보조 메타다."""
    path = root / ".ai-orchestrator" / "sessions.json"
    if not path.is_file():
        return path, None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return path, None
    if not isinstance(raw, dict) or not isinstance(raw.get("sessions"), list):
        return path, None
    return path, raw


def _session_has_active_task_run(session: dict) -> bool:
    """서버에 남은 실제 실행 또는 새로고침 뒤 복원 가능한 running 실행인지 확인한다."""
    active = session.get("active_run")
    if isinstance(active, dict) and active.get("run_id"):
        return True
    last_run = session.get("last_run")
    return isinstance(last_run, dict) and last_run.get("status") == "running"


def _scope_deletion_inspection(scope_id: str) -> dict[str, Any]:
    """삭제 전 영향·차단 조건을 한 번에 읽는다. 실제 삭제 직전에 다시 호출해야 한다."""
    normalized, row_path = _scope_row_path(scope_id)
    root = config.notes_dir().resolve()
    try:
        scope_post = frontmatter.load(row_path)
        label = str(scope_post.get("label") or scope_post.get("title") or row_path.stem).strip() or row_path.stem
    except Exception:  # noqa: BLE001
        label = row_path.stem

    workspace_data = _read_workspace_json()
    raw_sections = workspace_data.get("sections") if isinstance(workspace_data.get("sections"), list) else []
    connected_sections = [
        section
        for section in raw_sections
        if isinstance(section, dict) and str(section.get("scope_id") or "") == normalized
    ]
    task_cards = _scope_task_cards(root, normalized)

    # `running`은 실제 실행뿐 아니라 클라이언트의 전역 슬롯/같은 스코프 대기열에 들어간 카드도
    # 쓰는 상태다. 따라서 이 상태의 카드는 서버에서 확실히 중단/상태 정리될 때까지 삭제를 막는다.
    blockers: dict[str, dict[str, str]] = {}
    for path, post in task_cards:
        if str(post.get("status") or "") == "running":
            rel = path.relative_to(root).as_posix()
            blockers[rel] = {
                "path": rel,
                "title": str(post.get("title") or path.stem),
                "state": "실행 중 또는 대기 중",
            }

    sessions_path, sessions_data = _read_sessions_file(root)
    if sessions_data:
        for session in sessions_data["sessions"]:
            if not isinstance(session, dict) or session.get("kind") != "task":
                continue
            if str(session.get("scope_id") or "") != normalized or not _session_has_active_task_run(session):
                continue
            task_path = str(session.get("task_path") or "")
            key = task_path or f"session:{session.get('id') or session.get('title') or 'unknown'}"
            blockers[key] = {
                "path": task_path,
                "title": str(session.get("title") or task_path or "태스크 실행"),
                "state": "서버에서 실행 중",
            }

    return {
        "scope_id": normalized,
        "label": label,
        "row_path": row_path,
        "workspace_data": workspace_data,
        "connected_sections": connected_sections,
        "task_cards": task_cards,
        "sessions_path": sessions_path,
        "sessions_data": sessions_data,
        "blocking_tasks": list(blockers.values()),
    }


def _scope_deletion_preview(inspection: dict[str, Any]) -> dict[str, Any]:
    blockers = inspection["blocking_tasks"]
    return {
        "scope_id": inspection["scope_id"],
        "label": inspection["label"],
        "section_count": len(inspection["connected_sections"]),
        "task_count": len(inspection["task_cards"]),
        "active_task_count": len(blockers),
        "blocking_tasks": blockers,
        "can_delete": not blockers,
    }


def _frontmatter_bytes(post: frontmatter.Post) -> bytes:
    text = frontmatter.dumps(post)
    return (text if text.endswith("\n") else f"{text}\n").encode("utf-8")


def _workspace_bytes(data: dict) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _scope_deletion_replacements(inspection: dict[str, Any]) -> tuple[list[_FileReplacement], int]:
    """참조를 끊을 변경본을 메모리에서만 만든다. 여기서는 디스크를 건드리지 않는다."""
    root = config.notes_dir().resolve()
    scope_id = inspection["scope_id"]
    replacements: list[_FileReplacement] = []

    workspace_data = inspection["workspace_data"]
    workspace_changed = False
    raw_sections = workspace_data.get("sections")
    if isinstance(raw_sections, list):
        next_sections = [
            section
            for section in raw_sections
            if not (isinstance(section, dict) and str(section.get("scope_id") or "") == scope_id)
        ]
        if next_sections != raw_sections:
            workspace_data["sections"] = next_sections
            workspace_changed = True

    # 같은 id가 레거시 settings.scopes에 남으면 SCOPES DB 행을 휴지통으로 옮긴 뒤 다시 선택지에
    # 나타난다. 따라서 삭제와 같은 트랜잭션에서 함께 제거한다.
    legacy_scopes = workspace_data.get("scopes")
    if isinstance(legacy_scopes, list):
        next_legacy = [
            item
            for item in legacy_scopes
            if not (isinstance(item, dict) and str(item.get("id") or "") == scope_id)
        ]
        if next_legacy != legacy_scopes:
            workspace_data["scopes"] = next_legacy
            workspace_changed = True

    workspace_path = root / ".workspace.json"
    if workspace_changed:
        original = workspace_path.read_bytes() if workspace_path.is_file() else b"{}\n"
        replacements.append(_FileReplacement(workspace_path, original, _workspace_bytes(workspace_data)))

    for path, post in inspection["task_cards"]:
        original = path.read_bytes()
        post.metadata.pop("scope", None)
        replacements.append(_FileReplacement(path, original, _frontmatter_bytes(post)))

    # 과거 대화/실행 기록은 남기되, 다음 요청이 지워진 scope_id로 cwd를 선택하지 않게 한다.
    # 표시용 마지막 프로젝트 이름만 유지한다.
    sessions_data = inspection["sessions_data"]
    session_count = 0
    if sessions_data:
        for session in sessions_data["sessions"]:
            if not isinstance(session, dict) or str(session.get("scope_id") or "") != scope_id:
                continue
            session["scope_id"] = None
            session["last_scope_label"] = inspection["label"]
            session_count += 1
        if session_count:
            sessions_path = inspection["sessions_path"]
            replacements.append(
                _FileReplacement(sessions_path, sessions_path.read_bytes(), _workspace_bytes(sessions_data))
            )

    return replacements, session_count


def _stage_replacements(replacements: list[_FileReplacement]) -> None:
    """모든 변경 파일을 먼저 같은 디렉터리에 준비해 커밋 전 오류를 앞당긴다."""
    for replacement in replacements:
        replacement.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{replacement.path.name}.", dir=replacement.path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(replacement.replacement)
                handle.flush()
                os.fsync(handle.fileno())
            replacement.staged_path = Path(temp_name)
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise


def _cleanup_staged_replacements(replacements: list[_FileReplacement]) -> None:
    for replacement in replacements:
        if replacement.staged_path is None:
            continue
        try:
            replacement.staged_path.unlink(missing_ok=True)
        except OSError:
            pass
        replacement.staged_path = None


def _restore_replacements(replacements: list[_FileReplacement]) -> bool:
    """중간 실패 시 이미 바뀐 파일들을 원래 바이트로 되돌린다."""
    recovered = True
    for replacement in reversed(replacements):
        fd = -1
        temp_name = ""
        try:
            fd, temp_name = tempfile.mkstemp(prefix=f".{replacement.path.name}.rollback.", dir=replacement.path.parent)
            with os.fdopen(fd, "wb") as handle:
                fd = -1
                handle.write(replacement.original)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, replacement.path)
            temp_name = ""
        except Exception:  # noqa: BLE001
            recovered = False
        finally:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
            if temp_name:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
    return recovered


def _scope_trash_destination(row_path: Path) -> Path:
    # 프로젝트 행은 항상 `<workspace>/scopes/<scope_id>.md`에 있으므로, 현재 행 기준으로
    # 휴지통을 계산한다. 워크스페이스 전환/테스트 중 전역 config 상태가 바뀌어도 다른
    # 워크스페이스의 휴지통으로 행을 옮기지 않게 한다.
    trash = row_path.parent.parent / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    candidate = trash / f"{stamp}-{row_path.name}"
    number = 1
    while candidate.exists():
        candidate = trash / f"{stamp}-{number}-{row_path.name}"
        number += 1
    return candidate


@router.get("/scopes/{scope_id}/deletion-preview")
def get_scope_deletion_preview(scope_id: str):
    """프로젝트 삭제 확인창용 영향 범위. 실제 삭제 때 동일 내용을 다시 검사한다."""
    with _SCOPE_DELETION_LOCK:
        return _scope_deletion_preview(_scope_deletion_inspection(scope_id))


@router.delete("/scopes/{scope_id}")
def delete_scope(scope_id: str):
    """프로젝트 관리 행을 안전하게 삭제하고 연결된 참조를 한 트랜잭션으로 정리한다.

    DB 행은 휴지통으로 옮기고, 사이드바 section·태스크 scope·세션의 실행 scope만 제거한다.
    섹션의 노트/폴더, 프로젝트의 외부 경로, 실행 로그 본문은 절대 삭제하지 않는다.
    """
    with _SCOPE_DELETION_LOCK:
        inspection = _scope_deletion_inspection(scope_id)
        preview = _scope_deletion_preview(inspection)
        if not preview["can_delete"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{preview['label']}' 프로젝트에 실행 중 또는 대기 중인 태스크가 "
                    f"{preview['active_task_count']}개 있습니다. 실행을 종료하거나 취소한 뒤 다시 시도하세요."
                ),
            )

        replacements, session_count = _scope_deletion_replacements(inspection)
        row_path: Path = inspection["row_path"]
        trash_path = _scope_trash_destination(row_path)
        moved_row = False
        try:
            _stage_replacements(replacements)
            for replacement in replacements:
                if replacement.staged_path is None:
                    raise OSError("프로젝트 삭제 변경본을 준비하지 못했습니다")
                os.replace(replacement.staged_path, replacement.path)
                replacement.staged_path = None
            # 참조 해제가 모두 성공한 뒤 행을 휴지통으로 이동한다. 실패하면 아래 복구 경로가
            # workspace/태스크/세션을 원본 바이트로 되돌리고 행도 제자리로 옮긴다.
            shutil.move(str(row_path), str(trash_path))
            moved_row = True
        except Exception as exc:  # noqa: BLE001
            row_recovered = True
            if moved_row and trash_path.exists():
                try:
                    shutil.move(str(trash_path), str(row_path))
                except Exception:  # noqa: BLE001
                    row_recovered = False
            files_recovered = _restore_replacements(replacements)
            if files_recovered and row_recovered:
                detail = "프로젝트 삭제를 완료하지 못했습니다. 변경한 참조는 원래 상태로 복구했습니다."
            else:
                detail = "프로젝트 삭제 중 오류가 발생했고 일부 복구를 확인하지 못했습니다. 워크스페이스를 새로고침해 상태를 확인하세요."
            raise HTTPException(status_code=500, detail=detail) from exc
        finally:
            _cleanup_staged_replacements(replacements)

        root = config.notes_dir().resolve()
        # 검색 인덱스 갱신 실패는 원본 데이터 트랜잭션을 되돌릴 이유가 없다. watcher가 뒤에서
        # 다시 동기화하므로 best-effort로 처리한다.
        try:
            indexer.remove(row_path.relative_to(root).as_posix())
        except Exception:  # noqa: BLE001
            pass
        for path, _post in inspection["task_cards"]:
            try:
                indexer.index_file(path.relative_to(root).as_posix())
            except Exception:  # noqa: BLE001
                pass

        return {
            "scope_id": inspection["scope_id"],
            "label": inspection["label"],
            "trashed_to": trash_path.relative_to(root).as_posix(),
            "sections_removed": preview["section_count"],
            "task_scopes_released": preview["task_count"],
            "sessions_released": session_count,
        }


class OpenRequest(BaseModel):
    path: str


@router.post("/open")
def open_workspace(req: OpenRequest):
    p = Path(req.path).expanduser().resolve()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="존재하지 않는 디렉토리입니다")
    if p == Path(p.anchor):
        raise HTTPException(status_code=400, detail="파일시스템 루트는 열 수 없습니다")
    config.set_notes_dir(p)
    watcher.request_restart()  # 감시 대상을 새 루트로 전환
    count = indexer.full_scan()
    return {"root": str(config.notes_dir()), "indexed": count}


@router.get("/browse")
def browse(path: str | None = None):
    """폴더 선택 다이얼로그용 서버측 디렉토리 목록."""
    base = Path(path).expanduser() if path else Path.home()
    try:
        base = base.resolve()
        if not base.is_dir():
            raise HTTPException(status_code=404, detail="디렉토리를 찾을 수 없습니다")
        dirs = sorted(
            (c for c in base.iterdir() if c.is_dir() and not c.name.startswith(".")),
            key=lambda c: c.name.lower(),
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="접근 권한이 없습니다")
    return {
        "path": str(base),
        "parent": str(base.parent) if base != base.parent else None,
        "home": str(Path.home()),
        "dirs": [{"name": d.name, "path": str(d)} for d in dirs],
    }


class RevealRequest(BaseModel):
    path: str = ""  # 노트 루트 기준 상대 경로 ("" = 루트)


def _is_wsl() -> bool:
    return "microsoft" in platform.uname().release.lower()


def _powershell_explorer_command(path: str) -> list[str]:
    """WSL에서 Windows 셸을 통해 탐색기를 전경으로 여는 명령을 만든다.

    ``explorer.exe <path>``를 WSL에서 직접 실행하면 기존 Explorer 프로세스에
    요청만 전달되고 브라우저 뒤에 창이 남을 수 있다. PowerShell의
    ``Start-Process``를 거치면 Windows 셸이 사용자 동작으로 실행한 창처럼
    활성화한다. 경로는 UTF-8 Base64 데이터로 전달해 공백·따옴표가 있는 폴더도
    PowerShell 코드나 별도 셸 인자로 해석되지 않게 한다. WSL 환경에 따라
    ``-EncodedCommand`` 자체가 interop 오류를 내는 경우가 있어 ``-Command``의
    고정 스크립트 안에서 경로 데이터만 복원한다.
    """
    encoded_path = base64.b64encode(path.encode("utf-8")).decode("ascii")
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        "$target = [Text.Encoding]::UTF8.GetString("
        f"[Convert]::FromBase64String('{encoded_path}'))\n"
        "$argument = '\"' + $target + '\"'\n"
        "Start-Process -FilePath explorer.exe -ArgumentList @($argument) -WindowStyle Normal\n"
    )
    return [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]


def _open_system_explorer(target: Path) -> None:
    """플랫폼의 표준 셸로 폴더를 열고 가능한 경우 창을 전경에 표시한다."""
    system = platform.system()
    if system == "Windows":
        # 디렉터리의 표준 ``explore`` 동작은 ShellExecute를 사용한다. explorer.exe를
        # 자식 프로세스로 직접 띄우는 것보다 기존 Explorer 창 활성화도 셸에 맡길 수 있다.
        startfile = getattr(os, "startfile", None)
        if startfile is None:
            raise OSError("Windows ShellExecute를 사용할 수 없습니다")
        startfile(os.path.normpath(str(target)), "explore", show_cmd=1)
        return

    if system == "Linux" and _is_wsl():
        win_path = subprocess.run(
            ["wslpath", "-w", str(target)], capture_output=True, text=True, check=True
        ).stdout.strip()
        # 직접 explorer.exe를 실행하면 WSL/Windows 경계에서 전경 권한이 이어지지 않아
        # 작업 표시줄에만 열린다. Windows 셸 호출이 끝날 때까지 기다려 실패도 감지한다.
        subprocess.run(
            _powershell_explorer_command(win_path),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=10,
        )
        return

    command = ["open", str(target)] if system == "Darwin" else ["xdg-open", str(target)]
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@router.post("/reveal")
def reveal(req: RevealRequest):
    """대상 폴더를 OS 파일 탐색기로 열기."""
    target = resolve_path(req.path)
    if target.is_file():
        target = target.parent
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")

    try:
        _open_system_explorer(target)
    except (OSError, NotImplementedError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        raise HTTPException(status_code=500, detail=f"탐색기를 열 수 없습니다: {e}")
    return {"opened": str(target)}
