"""Skill 노트 조회.

Skill = frontmatter 에 `type: skill` 인 마크다운 노트.
Orchestrator 가 Codex 실행 시 선택된 skill 들의 본문을 developerInstructions 로 합성.

skill 노트 스키마 (frontmatter):
  type: skill
  name: str          # 표시명 (없으면 파일 스템)
  aliases: [str]     # 자동완성 별칭
  description: str   # 한 줄 설명
  draft: bool        # 초안 여부 (Learning pipeline 이 생성한 미확정 skill)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import config, db, indexer

router = APIRouter(prefix="/api/skills", tags=["skills"])


def _extract_skill(rel_path: str, note: dict) -> dict | None:
    props = note.get("props") or {}
    if props.get("type") != "skill":
        return None
    return {
        "path": rel_path,
        "name": str(props.get("name") or note.get("title") or rel_path).strip(),
        "aliases": [str(a) for a in props.get("aliases", [])] if isinstance(props.get("aliases"), list) else [],
        "description": str(props.get("description") or "").strip(),
        "draft": bool(props.get("draft")),
    }


@router.get("")
def list_skills():
    """워크스페이스 내 모든 skill 노트 목록. props.type == 'skill' 인 노트만 반환."""
    rows = db.notes_under("")
    skills = []
    for r in rows:
        s = _extract_skill(r["path"], r)
        if s:
            skills.append(s)
    skills.sort(key=lambda s: s["name"].lower())
    return {"skills": skills}


@router.get("/{path:path}/body")
def read_skill_body(path: str):
    """Skill 노트의 본문(프롬프트 내용) 을 반환. Orchestrator 가 developerInstructions 합성 시 사용."""
    abs_path = config.notes_dir() / path
    if not abs_path.is_file():
        raise HTTPException(status_code=404, detail="skill 노트를 찾을 수 없습니다")
    note = indexer.parse_note(abs_path)
    if (note.get("props") or {}).get("type") != "skill":
        raise HTTPException(status_code=400, detail="skill 노트가 아닙니다")
    return {"path": path, "body": note["body"], "name": note.get("props", {}).get("name") or note["title"]}
