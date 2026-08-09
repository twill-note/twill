import datetime
import re
from pathlib import Path

import frontmatter

from . import db
from .config import EXCLUDED_DIRS, notes_dir


def _normalize_date(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.strftime("%Y-%m-%d")
    s = str(value).strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else None


def _normalize_tags(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [t.strip() for t in value.split(",") if t.strip()]
    if isinstance(value, list):
        return [str(t).strip() for t in value if str(t).strip()]
    return []


# frontmatter에서 앱이 구조적으로 다루는 키 — 나머지는 임의 속성(props)으로 보존
RESERVED_KEYS = {"title", "date", "tags", "icon", "cover"}


def _jsonable(value):
    """YAML 파싱 결과(date 객체 등)를 JSON 직렬화 가능한 값으로 변환."""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def parse_note(abs_path: Path) -> dict:
    """마크다운 파일에서 frontmatter와 본문을 분리해 구조화된 형태로 반환."""
    try:
        post = frontmatter.load(abs_path)
        meta, body = post.metadata, post.content
    except Exception:
        # frontmatter 파싱 실패(YAML 오류 등) 시 파일 전체를 본문으로 취급
        meta, body = {}, abs_path.read_text(encoding="utf-8", errors="replace")

    title = str(meta.get("title") or "").strip()
    if not title:
        m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        title = m.group(1).strip() if m else abs_path.stem

    return {
        "title": title,
        "date": _normalize_date(meta.get("date")),
        "tags": _normalize_tags(meta.get("tags")),
        "icon": str(meta.get("icon") or "").strip(),
        "cover": str(meta.get("cover") or "").strip(),
        "props": {str(k): _jsonable(v) for k, v in meta.items() if k not in RESERVED_KEYS},
        "body": body,
    }


TODO_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+)$")
LINK_RE = re.compile(r"\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]")


def parse_todos(raw_text: str) -> list[tuple[int, str, bool]]:
    """원본 파일 기준 줄 번호로 체크박스 항목 추출 (토글 시 그 줄을 직접 수정)."""
    todos = []
    for i, line in enumerate(raw_text.splitlines()):
        m = TODO_RE.match(line)
        if m:
            todos.append((i, m.group(2).strip(), m.group(1).lower() == "x"))
    return todos


def parse_links(body: str) -> list[str]:
    targets = []
    for m in LINK_RE.finditer(body):
        name = m.group(1).strip().removesuffix(".md")
        if name and name not in targets:
            targets.append(name)
    return targets


def index_file(rel_path: str) -> None:
    abs_path = notes_dir() / rel_path
    if not abs_path.is_file() or abs_path.suffix != ".md":
        return
    note = parse_note(abs_path)
    raw = abs_path.read_text(encoding="utf-8", errors="replace")
    db.upsert_note(
        path=rel_path,
        title=note["title"],
        date=note["date"],
        tags=note["tags"],
        body=note["body"],
        updated_at=abs_path.stat().st_mtime,
        todos=parse_todos(raw),
        links=parse_links(note["body"]),
        icon=note["icon"],
        props=note["props"],
    )


def remove(rel_path: str) -> None:
    db.delete_prefix(rel_path)


def iter_note_files() -> list[Path]:
    files = []
    for p in sorted(notes_dir().rglob("*.md")):
        rel_parts = p.relative_to(notes_dir()).parts
        if any(part.startswith(".") or part in EXCLUDED_DIRS for part in rel_parts[:-1]):
            continue
        if rel_parts[-1].startswith("."):
            continue
        files.append(p)
    return files


def full_scan() -> int:
    db.clear_all()
    count = 0
    for p in iter_note_files():
        index_file(str(p.relative_to(notes_dir())))
        count += 1
    return count
