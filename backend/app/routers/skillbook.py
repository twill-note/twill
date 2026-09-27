from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import skillbook


router = APIRouter(prefix="/api/skillbook", tags=["skillbook"])


class SkillCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=1024)


class SkillContentUpdateRequest(BaseModel):
    content: str
    frontmatter: dict[str, Any] | None = None
    mtime: float | None = None


class LanguageRequest(BaseModel):
    language: Literal["ko", "en"]


def _raise_http(exc: Exception) -> None:
    if isinstance(exc, skillbook.SkillBookNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, skillbook.SkillBookReadOnly):
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if isinstance(exc, skillbook.SkillBookConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, skillbook.SkillBookValidationError):
        raise HTTPException(status_code=400, detail={"message": str(exc), "errors": exc.errors}) from exc
    raise exc


@router.get("/storage")
def storage_info():
    return {"path": str(skillbook.SKILLBOOK_ROOT)}


@router.post("/language")
def set_language(request: LanguageRequest):
    return {"language": skillbook.set_skillbook_language(request.language)}


@router.get("")
async def list_entries(
    query: str | None = Query(default=None),
    source: Literal["all", "app_skill", "system_manual"] = Query(default="all"),
    language: Literal["ko", "en"] | None = Query(default=None),
) -> list[dict[str, Any]]:
    if language:
        skillbook.set_skillbook_language(language)
    return skillbook.list_skillbook(query=query, source=source)


@router.post("", status_code=201)
async def create_entry(request: SkillCreateRequest) -> dict[str, Any]:
    try:
        return skillbook.create_skill(request.name, request.description)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.get("/{entry_id:path}/content")
async def get_content(
    entry_id: str,
    path: str | None = Query(default=None),
) -> dict[str, Any]:
    try:
        return skillbook.read_skillbook_component(entry_id, path)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.put("/{entry_id:path}/content")
async def update_content(
    entry_id: str,
    request: SkillContentUpdateRequest,
    path: str = Query(..., min_length=1),
) -> dict[str, Any]:
    try:
        return skillbook.save_skillbook_component(
            entry_id,
            path,
            content=request.content,
            metadata=request.frontmatter,
            expected_mtime=request.mtime,
        )
    except Exception as exc:
        _raise_http(exc)
        raise


@router.get("/{entry_id:path}/asset")
async def get_asset(entry_id: str, path: str = Query(..., min_length=1)) -> FileResponse:
    try:
        target = skillbook.asset_path(entry_id, path)
        return FileResponse(target)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.put("/{entry_id:path}/asset")
async def update_asset(
    entry_id: str,
    path: str = Query(..., min_length=1),
    mtime: float | None = Form(default=None),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    try:
        data = await file.read(10 * 1024 * 1024 + 1)
        return skillbook.replace_asset(
            entry_id,
            path,
            data=data,
            expected_mtime=mtime,
        )
    except Exception as exc:
        _raise_http(exc)
        raise


@router.get("/{entry_id:path}")
async def get_entry(entry_id: str) -> dict[str, Any]:
    try:
        return skillbook.get_skillbook_detail(entry_id)
    except Exception as exc:
        _raise_http(exc)
        raise


@router.delete("/{entry_id:path}")
async def delete_entry(entry_id: str) -> dict[str, str]:
    try:
        return skillbook.delete_skill(entry_id)
    except Exception as exc:
        _raise_http(exc)
        raise
