"""ERD 디자이너 코어 구현 모듈.

- 데이터베이스 테이블/컬럼/관계를 시각적으로 설계하는 도구 (erdcloud.com 스타일).
- 다이어그램 상태는 워크스페이스 내 `.erd.json` 파일로 저장.
- 코어 라우터는 `/api/erd/*`로 마운트되며, 플러그인 설치 여부와 무관하다.
- `.erd.json`은 워크스페이스의 어느 폴더에나 저장되고 파일 트리에서 다시 연다.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ... import config

MANIFEST = {
    "id": "erd_designer",
    "core_feature": True,
    "name": "ERD 디자이너",
    "version": "0.1.0",
    "description": "SQL 데이터베이스 테이블·컬럼·관계를 시각적으로 설계하고 DDL 로 내보냅니다.",
    "permissions": ["workspace:read", "workspace:write"],
    "ui": {
        "sidebarButton": {"id": "erd-open", "label": "ERD 디자이너", "icon": "🗺️"},
        "slashItems": [
            {"id": "erd-new", "title": "새 ERD 다이어그램", "aliases": ["erd", "diagram", "테이블설계"]},
        ],
        "commands": [
            {"id": "erd-open", "title": "ERD 디자이너 열기"},
        ],
    },
}


router = APIRouter(tags=["erd_designer"])

_DIAGRAM_SUFFIX = ".erd.json"
_DIALECTS = {"mariadb", "postgres", "mysql", "sqlite", "generic"}
_WINDOWS_RESERVED_FILENAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def _resolve_diagram_path(path: str) -> Path:
    """Resolve an ERD path strictly inside the active workspace.

    ERD files are intentionally outside the markdown note APIs: they are JSON
    artifacts, are not indexed as notes, and must never provide a path escape
    hatch through the plugin endpoint.
    """
    raw = (path or "").strip().strip("/")
    if not raw.endswith(_DIAGRAM_SUFFIX):
        raise HTTPException(status_code=400, detail="ERD 파일은 .erd.json 확장자를 사용해야 합니다")

    root = config.notes_dir().resolve()
    target = (root / raw).resolve()
    if target == root or root not in target.parents:
        raise HTTPException(status_code=400, detail="워크스페이스 밖의 경로는 사용할 수 없습니다")

    parts = target.relative_to(root).parts
    if any(part.startswith(".") for part in parts) or parts[0] in config.EXCLUDED_DIRS:
        raise HTTPException(status_code=400, detail="예약된 디렉터리에는 ERD를 저장할 수 없습니다")
    return target


def _relative_path(path: Path) -> str:
    return path.relative_to(config.notes_dir().resolve()).as_posix()


def _validate_diagram(value: Any) -> dict[str, Any]:
    """Keep the file format predictable while allowing future editor fields."""
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="ERD 데이터는 JSON 객체여야 합니다")
    if value.get("version") != 1:
        raise HTTPException(status_code=422, detail="지원하지 않는 ERD 파일 버전입니다")

    meta = value.get("meta")
    if not isinstance(meta, dict) or not isinstance(meta.get("title"), str):
        raise HTTPException(status_code=422, detail="ERD 제목 정보가 올바르지 않습니다")
    if meta.get("dialect") not in _DIALECTS:
        raise HTTPException(status_code=422, detail="지원하지 않는 SQL 방언입니다")
    if not isinstance(value.get("tables"), list) or not isinstance(value.get("relations"), list):
        raise HTTPException(status_code=422, detail="ERD 테이블 또는 관계 데이터가 올바르지 않습니다")
    return value


def _read_diagram(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail="ERD JSON 파일을 읽을 수 없습니다") from exc
    return _validate_diagram(value)


class DiagramSaveRequest(BaseModel):
    path: str
    diagram: dict[str, Any]
    # None keeps direct/older API callers on the path they supplied. The ERD
    # editor always sends an explicit value so its choice survives reopening.
    sync_title: bool | None = None


def _filename_from_title(title: str) -> str:
    """Return a portable `.erd.json` filename derived from an ERD title.

    The editor keeps the title itself intact. Only the filesystem projection is
    normalised, so a display title can still contain punctuation that is not
    legal in Windows or POSIX path components.
    """
    stem = unicodedata.normalize("NFC", title).strip()
    stem = re.sub(r"[<>:\"/\\|?*\x00-\x1f\x7f]", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip(". ")
    if stem.lower().endswith(_DIAGRAM_SUFFIX):
        stem = stem[: -len(_DIAGRAM_SUFFIX)].rstrip(". ")
    if not stem:
        raise HTTPException(
            status_code=422,
            detail="ERD 제목에서 사용할 수 있는 파일 이름을 만들 수 없습니다. 제목을 입력하세요.",
        )
    if stem.upper() in _WINDOWS_RESERVED_FILENAMES:
        stem = f"{stem}_"

    # Keep the complete UTF-8 name well below common 255-byte filesystem
    # limits. Slicing bytes can split a Korean character, so trim characters.
    limit = 220 - len(_DIAGRAM_SUFFIX.encode("utf-8"))
    while len(stem.encode("utf-8")) > limit:
        stem = stem[:-1].rstrip(". ")
    if not stem:
        raise HTTPException(
            status_code=422,
            detail="ERD 제목이 너무 짧거나 올바르지 않아 파일 이름을 만들 수 없습니다.",
        )
    return f"{stem}{_DIAGRAM_SUFFIX}"


def _write_diagram_atomically(source: Path, target: Path, diagram: dict[str, Any]) -> None:
    """Persist a diagram and, when needed, rename it without overwriting files.

    The temporary file is fully written before either public path changes. For
    a title-driven rename we first atomically move the old file to its final
    name, then atomically replace its content. If the second operation fails,
    the old file is moved back to the original path before reporting failure.
    This keeps both the former file and the editor's current path usable on a
    failed rename.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    source_exists = source.exists()
    try:
        temp.write_text(json.dumps(diagram, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        if source_exists and source != target:
            if target.exists():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"제목 기반 파일명 '{target.name}'이(가) 이미 있습니다. "
                        "제목을 바꾸거나 기존 파일의 이름을 바꾼 뒤 다시 저장하세요."
                    ),
                )
            try:
                os.replace(source, target)
                try:
                    os.replace(temp, target)
                except OSError as exc:
                    # target still contains the old project here. Put it back
                    # under its original name before the client sees failure.
                    try:
                        os.replace(target, source)
                    except OSError as rollback_error:
                        raise HTTPException(
                            status_code=500,
                            detail="ERD 이름 변경을 복구하지 못했습니다. 파일 트리를 새로고침해 파일 상태를 확인하세요.",
                        ) from rollback_error
                    raise HTTPException(
                        status_code=500,
                        detail="ERD 이름 변경에 실패했습니다. 기존 파일은 그대로 유지되었습니다.",
                    ) from exc
            except HTTPException:
                raise
            except OSError as exc:
                raise HTTPException(
                    status_code=500,
                    detail="ERD 이름 변경에 실패했습니다. 기존 파일은 그대로 유지되었습니다.",
                ) from exc
        else:
            if not source_exists and target.exists():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"제목 기반 파일명 '{target.name}'이(가) 이미 있습니다. "
                        "제목을 바꾸거나 기존 파일의 이름을 바꾼 뒤 다시 저장하세요."
                    ),
                )
            try:
                # source == target is an ordinary atomic save. A brand-new
                # title-based file reaches this branch only after collision
                # detection above.
                os.replace(temp, target)
            except OSError as exc:
                raise HTTPException(status_code=500, detail="ERD 파일을 저장하지 못했습니다. 기존 파일은 유지되었습니다.") from exc
    finally:
        if temp.exists():
            temp.unlink(missing_ok=True)


@router.get("/diagrams")
def list_diagrams():
    """List all saved ERD projects, including diagrams stored in subfolders."""
    root = config.notes_dir().resolve()
    diagrams: list[dict[str, Any]] = []
    for path in root.rglob(f"*{_DIAGRAM_SUFFIX}"):
        if not path.is_file() or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        if path.relative_to(root).parts[0] in config.EXCLUDED_DIRS:
            continue
        try:
            diagram = _read_diagram(path)
        except HTTPException:
            # A malformed artifact must not make all valid projects disappear.
            continue
        meta = diagram["meta"]
        diagrams.append(
            {
                "path": _relative_path(path),
                "title": meta.get("title") or path.name.removesuffix(_DIAGRAM_SUFFIX),
                "dialect": meta["dialect"],
                "updated": meta.get("updated") or int(path.stat().st_mtime),
                "tables": len(diagram["tables"]),
                "relations": len(diagram["relations"]),
            }
        )
    diagrams.sort(key=lambda item: (int(item["updated"]), item["path"]), reverse=True)
    return {"diagrams": diagrams}


@router.get("/diagrams/content")
def get_diagram(path: str):
    target = _resolve_diagram_path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="ERD 파일을 찾을 수 없습니다")
    return {"path": _relative_path(target), "diagram": _read_diagram(target)}


@router.put("/diagrams/content")
def save_diagram(req: DiagramSaveRequest):
    source = _resolve_diagram_path(req.path)
    diagram = _validate_diagram(req.diagram)
    sync_title = req.sync_title is True
    target = source.with_name(_filename_from_title(diagram["meta"]["title"])) if sync_title else source

    # Persist the user's explicit policy. Older/direct callers that do not
    # supply sync_title retain their existing JSON shape and path behaviour.
    if req.sync_title is not None:
        diagram = {**diagram, "meta": {**diagram["meta"], "filenameMode": "title" if sync_title else "manual"}}

    _write_diagram_atomically(source, target, diagram)
    return {"path": _relative_path(target), "diagram": diagram}


def on_install() -> None:
    pass


def on_uninstall() -> None:
    pass
