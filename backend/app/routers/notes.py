import datetime

import frontmatter
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import db, indexer
from ..config import notes_dir
from .files import rel_str, resolve_path

router = APIRouter(prefix="/api", tags=["notes"])

DAILY_DIR = "daily"
TEMPLATE_DIR = "templates"
DAILY_TEMPLATE_NAMES = {"daily", "데일리", "데일리 노트"}


@router.get("/notes/calendar")
def calendar(year: int = Query(ge=1970, le=2200), month: int = Query(ge=1, le=12)):
    return db.calendar_counts(year, month)


@router.get("/notes/db")
def notes_db(dir: str = ""):
    """데이터베이스(테이블) 뷰: 디렉토리 하위 노트를 임의 frontmatter 속성까지 포함해 반환."""
    if dir:
        p = resolve_path(dir)
        if not p.is_dir():
            raise HTTPException(status_code=404, detail="디렉토리를 찾을 수 없습니다")
    return db.notes_under(dir.strip().strip("/"))


@router.get("/notes")
def list_notes(date: str | None = None, tag: str | None = None):
    if date:
        return db.notes_by_date(date)
    if tag:
        return db.notes_by_tag(tag)
    raise HTTPException(status_code=400, detail="date 또는 tag 파라미터가 필요합니다")


class DailyRequest(BaseModel):
    date: str | None = None


@router.post("/notes/daily")
def open_daily(req: DailyRequest):
    """오늘(또는 지정 날짜)의 데일리 노트를 가져오거나 없으면 생성."""
    date = req.date or datetime.date.today().isoformat()
    p = resolve_path(f"{DAILY_DIR}/{date}.md")
    if p.is_file():
        return {"path": rel_str(p), "created": False}

    body, tags = "", []
    tpl_dir = notes_dir() / TEMPLATE_DIR
    if tpl_dir.is_dir():
        for f in sorted(tpl_dir.glob("*.md")):
            if f.stem.lower() in DAILY_TEMPLATE_NAMES:
                tpl = indexer.parse_note(f)
                body, tags = tpl["body"], tpl["tags"]
                break

    p.parent.mkdir(parents=True, exist_ok=True)
    post = frontmatter.Post(body, title=date, date=date, tags=tags)
    p.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
    indexer.index_file(rel_str(p))
    return {"path": rel_str(p), "created": True}


@router.get("/templates")
def list_templates():
    tpl_dir = notes_dir() / TEMPLATE_DIR
    if not tpl_dir.is_dir():
        return []
    return [
        {"name": f.stem, "path": rel_str(f)}
        for f in sorted(tpl_dir.glob("*.md"), key=lambda f: f.name.lower())
    ]


@router.get("/todos")
def list_todos(include_done: bool = False):
    return db.all_todos(include_done)


class ToggleRequest(BaseModel):
    path: str
    line: int
    text: str  # 검증용 — 파일이 바뀌었으면 텍스트로 재탐색


@router.post("/todos/toggle")
def toggle_todo(req: ToggleRequest):
    p = resolve_path(req.path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    raw = p.read_text(encoding="utf-8")
    lines = raw.splitlines()

    def match(i: int) -> bool:
        m = indexer.TODO_RE.match(lines[i]) if 0 <= i < len(lines) else None
        return bool(m and m.group(2).strip() == req.text)

    idx = req.line if match(req.line) else next((i for i in range(len(lines)) if match(i)), None)
    if idx is None:
        raise HTTPException(status_code=409, detail="해당 할 일을 찾을 수 없습니다 (파일이 변경됨)")

    m = indexer.TODO_RE.match(lines[idx])
    done = m.group(1).lower() == "x"
    box_start = lines[idx].find("[" + m.group(1) + "]")
    lines[idx] = lines[idx][:box_start] + ("[ ]" if done else "[x]") + lines[idx][box_start + 3:]
    p.write_text("\n".join(lines) + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")
    indexer.index_file(rel_str(p))
    return {"done": not done, "mtime": p.stat().st_mtime}


@router.get("/notes/resolve")
def resolve_note(name: str):
    """[[이름]] 링크가 가리키는 노트 경로 해석 (파일명 또는 제목 매칭)."""
    r = db.resolve_link_target(name.strip())
    return {"path": r["path"] if r else None, "title": r["title"] if r else None}


@router.get("/notes/backlinks")
def note_links(path: str):
    """현재 노트의 나가는 링크([[...]]), 백링크, 하위 노트(동반 폴더) 목록."""
    p = resolve_path(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    rel = rel_str(p)
    note = indexer.parse_note(p)
    incoming = [n for n in db.backlinks([p.stem, note["title"]]) if n["path"] != rel]
    outgoing = []
    for target in db.outgoing_links(rel):
        resolved = db.resolve_link_target(target)
        outgoing.append({
            "target": target,
            "path": resolved["path"] if resolved else None,
            "title": resolved["title"] if resolved else target,
        })
    children = []
    companion = p.with_suffix("")
    if companion.is_dir():
        for f in sorted(companion.glob("*.md"), key=lambda f: f.name.lower()):
            sub = indexer.parse_note(f)
            children.append({"path": rel_str(f), "title": sub["title"], "date": sub["date"], "tags": sub["tags"]})
    return {"incoming": incoming, "outgoing": outgoing, "children": children}


@router.get("/search")
def search(q: str):
    return db.search(q)


@router.get("/tags")
def tags():
    return db.all_tags()


@router.post("/reindex")
def reindex():
    count = indexer.full_scan()
    return {"indexed": count}
