"""데이터베이스(폴더) 컬럼 스키마 설정 API.

Notion 스타일 database 를 위한 컬럼 정의(type, options, 색상 등)를 폴더별로 저장.
저장 위치: `<db_folder>/.db.json` — 폴더와 함께 이동/버전관리 되도록 파일로 유지.

CellType:
  text | number | select | multi_select | status | date | checkbox | url | path

SelectOption:
  { value: str, label: str, color?: str }        # color 는 프리셋(gray/red/orange/yellow/green/blue/purple/pink/brown/default)

ColumnDef:
  { key: str, label?: str, type: CellType, options?: [SelectOption], visible?: bool }

DbConfig:
  { columns: [ColumnDef], primarySort?: {key, dir}, defaultView?: 'table'|'board', boardGroupBy?: str }
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import EXCLUDED_DIRS, notes_dir

router = APIRouter(prefix="/api/db", tags=["db"])

CONFIG_FILE = ".db.json"

CellType = Literal["text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "path"]


class SelectOption(BaseModel):
    value: str
    label: str = ""
    color: str = "default"


class ColumnDef(BaseModel):
    key: str
    label: str | None = None
    type: CellType = "text"
    options: list[SelectOption] = Field(default_factory=list)
    visible: bool = True


class SortSpec(BaseModel):
    key: str
    dir: Literal["asc", "desc"] = "asc"


class DbConfig(BaseModel):
    title: str = ""
    kind: str = ""  # "task_board" 등. 클릭 행동 · 특수 UI 를 결정.
    columns: list[ColumnDef] = Field(default_factory=list)
    primary_sort: SortSpec | None = Field(default=None, alias="primarySort")
    default_view: Literal["table", "board"] = Field(default="table", alias="defaultView")
    board_group_by: str | None = Field(default=None, alias="boardGroupBy")

    class Config:
        populate_by_name = True


def _resolve_db_dir(dir_rel: str, require_exists: bool = True) -> Path:
    """DB 폴더 (또는 노트 루트) 경로를 안전하게 해석.

    - `.` 로 시작하거나 예약 디렉토리(assets/.trash) 는 거부
    - require_exists=False 이면 존재 확인 생략 (아직 생성되지 않은 inline DB 조회용)
    """
    rel = (dir_rel or "").strip().strip("/")
    root = notes_dir().resolve()
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise HTTPException(status_code=400, detail="노트 루트 밖의 경로는 허용되지 않습니다")
    parts = p.relative_to(root).parts
    if any(part.startswith(".") or (i == 0 and part in EXCLUDED_DIRS) for i, part in enumerate(parts)):
        raise HTTPException(status_code=400, detail="예약된 디렉토리는 접근할 수 없습니다")
    if require_exists and not p.is_dir():
        raise HTTPException(status_code=404, detail="폴더가 존재하지 않습니다")
    return p


def _default_config() -> dict[str, Any]:
    return {
        "title": "",
        "kind": "",
        "columns": [],
        "primarySort": None,
        "defaultView": "table",
        "boardGroupBy": None,
    }


def _read_config(dir_path: Path) -> dict[str, Any]:
    cfg_path = dir_path / CONFIG_FILE
    if not cfg_path.is_file():
        return _default_config()
    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_config()
    # 기본값 병합
    out = _default_config()
    if isinstance(raw, dict):
        if isinstance(raw.get("title"), str):
            out["title"] = raw["title"]
        if isinstance(raw.get("kind"), str):
            out["kind"] = raw["kind"]
        # 레거시 라벨 자동 리브랜딩 (파일은 그대로, 응답만 새 라벨로)
        if out.get("kind") == "scopes_board" and out.get("title") == "스코프 카탈로그":
            out["title"] = "프로젝트 관리"
        out.update({k: v for k, v in raw.items() if k in out and k not in ("title", "kind")})
        # columns 정규화 (필수 키 채우기)
        cols = out.get("columns") or []
        norm = []
        for c in cols:
            if not isinstance(c, dict) or not c.get("key"):
                continue
            norm.append(
                {
                    "key": str(c["key"]),
                    "label": c.get("label") or None,
                    "type": c.get("type") or "text",
                    "options": c.get("options") or [],
                    "visible": bool(c.get("visible", True)),
                }
            )
        out["columns"] = norm
        if out.get("kind") == "task_board":
            out = _normalize_task_board_config(out)
        elif out.get("kind") == "scopes_board":
            out = _normalize_scopes_board_config(out)
    return out


@router.get("/config")
def get_config(dir: str = ""):
    # 폴더가 아직 없어도(예: inline DB 첫 사용) 기본 config 를 반환해 클라이언트가 안전하게 렌더링하도록.
    try:
        p = _resolve_db_dir(dir, require_exists=False)
    except HTTPException:
        return _default_config()
    if not p.is_dir():
        return _default_config()
    return _read_config(p)


class SaveConfigRequest(BaseModel):
    dir: str = ""
    config: DbConfig


TASK_BOARD_PRESET: dict[str, Any] = {
    "title": "태스크 보드",
    "kind": "task_board",
    "columns": [
        {
            "key": "status",
            "label": "상태",
            "type": "status",
            "visible": True,
            "options": [
                {"value": "blocked", "label": "🚫 보류", "color": "red"},
                {"value": "todo", "label": "📋 대기", "color": "gray"},
                {"value": "running", "label": "⚡ 실행", "color": "blue"},
                {"value": "verify", "label": "🔎 확인 필요", "color": "purple"},
                {"value": "done", "label": "🎉 완료", "color": "green"},
            ],
        },
        {
            "key": "type",
            "label": "유형",
            "type": "select",
            "visible": True,
            "options": [
                {"value": "spec", "label": "spec", "color": "purple"},
                {"value": "api", "label": "api", "color": "blue"},
                {"value": "ui", "label": "ui", "color": "pink"},
                {"value": "refactor", "label": "refactor", "color": "brown"},
                {"value": "test", "label": "test", "color": "green"},
                {"value": "docs", "label": "docs", "color": "gray"},
                {"value": "other", "label": "기타", "color": "default"},
            ],
        },
        {"key": "scope", "label": "프로젝트", "type": "select", "visible": True, "options": []},
        {"key": "skill", "label": "skill", "type": "multi_select", "visible": True, "options": []},
        {"key": "max_time_min", "label": "시간 한도(분)", "type": "number", "visible": False, "options": []},
        # 배치 인계(전체 실행) 메타 — 표에 노출하지 않음
        {"key": "batch_id", "label": "배치", "type": "text", "visible": False, "options": []},
        {"key": "batch_order", "label": "배치 순번", "type": "number", "visible": False, "options": []},
        {"key": "run_log", "label": "최근 실행", "type": "url", "visible": True, "options": []},
    ],
    "primarySort": None,
    "defaultView": "board",
    "boardGroupBy": "status",
}


# 태스크 보드는 이름과 상태 흐름을 고정한다. 예전 보드 파일에는 승인 정책 열과
# 보류가 맨 오른쪽에 있던 상태 옵션이 남아 있을 수 있으므로, 읽기·저장 양쪽에서
# 현재 스키마로 정규화한다. 카드의 과거 frontmatter는 보존하지만 실행에는 쓰지 않는다.
TASK_STATUS_OPTIONS = TASK_BOARD_PRESET["columns"][0]["options"]


def _normalize_task_board_config(config: dict[str, Any]) -> dict[str, Any]:
    columns = [column for column in config.get("columns", []) if column.get("key") != "approval"]
    status_index = next((i for i, column in enumerate(columns) if column.get("key") == "status"), None)
    if status_index is None:
        columns.insert(0, json.loads(json.dumps(TASK_BOARD_PRESET["columns"][0])))
    else:
        existing = columns[status_index]
        existing_options = {
            str(option.get("value")): option
            for option in existing.get("options", [])
            if isinstance(option, dict) and option.get("value")
        }
        # 기존 사용자가 바꾼 라벨·색은 유지하되, 공식 5개 상태의 표시 순서는 고정한다.
        existing["options"] = [
            {**default, **existing_options.get(default["value"], {})}
            for default in TASK_STATUS_OPTIONS
        ]
        columns[status_index] = existing
    return {
        **config,
        "title": TASK_BOARD_PRESET["title"],
        "columns": columns,
        "boardGroupBy": "status",
    }


def _task_board_preset_with_scopes() -> dict[str, Any]:
    """현재 워크스페이스의 프로젝트 선택지를 포함한 새 태스크 보드 프리셋."""
    preset = json.loads(json.dumps(TASK_BOARD_PRESET))
    ws_settings_path = notes_dir() / ".workspace.json"
    if not ws_settings_path.is_file():
        return preset
    try:
        ws = json.loads(ws_settings_path.read_text(encoding="utf-8"))
        scopes = ws.get("scopes") or []
        colors = ["blue", "green", "orange", "purple", "pink", "yellow", "brown", "red"]
        for col in preset["columns"]:
            if col["key"] == "scope":
                col["options"] = [
                    {"value": s["id"], "label": s.get("label") or s["id"], "color": colors[i % len(colors)]}
                    for i, s in enumerate(scopes)
                    if isinstance(s, dict) and s.get("id")
                ]
                break
    except (OSError, json.JSONDecodeError):
        pass
    return preset


SCOPES_BOARD_PRESET: dict[str, Any] = {
    "title": "프로젝트 관리",
    "kind": "scopes_board",  # 내부 종류명은 유지 (backward compat)
    "columns": [
        {"key": "path", "label": "경로", "type": "path", "visible": True, "options": []},
    ],
    "primarySort": None,
    "defaultView": "table",
    "boardGroupBy": None,
}


def _normalize_scopes_board_config(config: dict[str, Any]) -> dict[str, Any]:
    """프로젝트 관리는 프로젝트명과 경로만 보이는 고정 테이블로 제한한다.

    프로젝트명은 행의 label 속성을 고정 첫 열에서 표시하므로 별도 데이터 열이 필요 없다.
    과거 project/label/custom 열과 보드 설정은 원본 행 frontmatter를 지우지 않고 화면
    스키마에서만 제거한다.
    """
    existing_path = next(
        (column for column in config.get("columns", []) if column.get("key") == "path"),
        None,
    )
    path_column = {
        **json.loads(json.dumps(SCOPES_BOARD_PRESET["columns"][0])),
        **(existing_path or {}),
        "key": "path",
        "label": "경로",
        "type": "path",
        "visible": True,
    }
    return {
        **config,
        "columns": [path_column],
        "defaultView": "table",
        "boardGroupBy": None,
    }


class EnsureTaskBoardRequest(BaseModel):
    dir: str = "tasks"


class EnsureScopesBoardRequest(BaseModel):
    dir: str = "scopes"


@router.post("/ensure-scopes-board")
def ensure_scopes_board(req: EnsureScopesBoardRequest):
    """워크스페이스 아래에 여러 프로젝트 스코프를 관리할 DB 폴더를 (없으면) 생성.

    각 행(노트) = 하나의 스코프. project/scope_id/label/path 컬럼.
    Codex 챗의 scope 드롭다운은 이 DB 에서 항목을 읽어옴.
    """
    rel = req.dir.strip().strip("/") or "scopes"
    p = notes_dir() / rel
    p.mkdir(parents=True, exist_ok=True)
    cfg_path = p / CONFIG_FILE
    created = False
    if not cfg_path.is_file():
        cfg_path.write_text(json.dumps(SCOPES_BOARD_PRESET, ensure_ascii=False, indent=2), encoding="utf-8")
        created = True
    return {"dir": rel, "created": created}


@router.post("/ensure-task-board")
def ensure_task_board(req: EnsureTaskBoardRequest):
    """워크스페이스 아래에 태스크 보드 폴더 + .db.json 을 생성·복구.

    빈 기본 DB 설정이 태스크 보드에 잘못 저장된 경우에는 일반 테이블로 방치하지 않고
    프리셋으로 복구한다. 정상 태스크 보드의 사용자 정의 컬럼은 건드리지 않는다.
    """
    rel = req.dir.strip().strip("/") or "tasks"
    p = notes_dir() / rel
    p.mkdir(parents=True, exist_ok=True)
    cfg_path = p / CONFIG_FILE
    created = False
    repaired = False
    if not cfg_path.is_file():
        cfg_path.write_text(json.dumps(_task_board_preset_with_scopes(), ensure_ascii=False, indent=2), encoding="utf-8")
        created = True
    elif _read_config(p).get("kind") != "task_board":
        # DatabaseView가 설정을 비동기로 읽기 전에 행을 만들면 EMPTY_CONFIG가 저장될 수 있다.
        # 이 엔드포인트는 태스크 보드 전용이므로 비어 있거나 일반 DB인 설정은 안전하게 복구한다.
        cfg_path.write_text(json.dumps(_task_board_preset_with_scopes(), ensure_ascii=False, indent=2), encoding="utf-8")
        repaired = True
    return {"dir": rel, "created": created, "repaired": repaired}


@router.put("/config")
def save_config(req: SaveConfigRequest):
    # 저장 시에는 폴더가 존재해야 하지만, inline DB 는 첫 행 생성 전에는 폴더가 없을 수 있으므로 자동 생성.
    p = _resolve_db_dir(req.dir, require_exists=False)
    p.mkdir(parents=True, exist_ok=True)
    cfg_path = p / CONFIG_FILE
    data = req.config.model_dump(by_alias=True, exclude_none=False)
    existing = _read_config(p) if cfg_path.is_file() else None
    # DatabaseView의 첫 렌더는 EMPTY_CONFIG다. 그 사이 '+ 새로 만들기'를 누르면 기존
    # 태스크 보드 스키마 전체가 빈 값으로 교체될 수 있으므로, 이 레이스의 저장은 무시한다.
    if (
        existing
        and existing.get("kind") == "task_board"
        and not data.get("kind")
        and not data.get("columns")
    ):
        return existing
    if data.get("kind") == "task_board":
        data = _normalize_task_board_config(data)
    elif data.get("kind") == "scopes_board":
        data = _normalize_scopes_board_config(data)
    cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return _read_config(p)
