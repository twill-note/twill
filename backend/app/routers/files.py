import datetime
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote

import frontmatter
from fastapi import APIRouter, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import db, indexer
from ..config import EXCLUDED_DIRS, TREE_HIDDEN_ROOT_DIRS, notes_dir, trash_dir

router = APIRouter(prefix="/api/files", tags=["files"])


# Codex가 파일 위치를 ``path/to/note.md:42:7``처럼 돌려주는 형식. 줄/열 정보는
# 내부 편집기가 아직 해석하지 않으므로, 문서 자체의 경로만 검증한다.
_CODEX_LINE_REFERENCE_RE = re.compile(r"(\.erd\.json|\.md):\d+(?::\d+)?$", re.IGNORECASE)
_WINDOWS_ABSOLUTE_PATH_RE = re.compile(r"^[A-Za-z]:/")


def _document_kind(path: Path) -> str | None:
    """파일 트리에 표시되는 관리 문서 종류만 반환한다."""
    if path.name.endswith(".erd.json"):
        return "erd"
    if path.suffix == ".md":
        return "note"
    return None


def resolve_document_link_target(href: str | None) -> dict[str, str] | None:
    """채팅 링크 후보를 현재 워크스페이스의 실제 문서로만 해석한다.

    이 함수가 Markdown 링크와 Codex의 ``파일:줄:열`` 형식을 함께 검증하는 단일
    경계다. 프런트엔드는 이 결과가 있을 때만 내부 편집기 링크를 만들므로, 스코프의
    소스 파일·외부 절대 경로·삭제된 문서가 열기 동작으로 이어지지 않는다.
    """
    raw = (href or "").strip()
    if not raw:
        return None

    # file: URL은 워크스페이스 안을 가리켜도 브라우저 파일 접근으로 오인될 수 있다.
    # URL 디코딩 뒤에도 다시 확인해 우회를 막는다.
    if raw.lower().startswith("file:"):
        return None
    candidate = unquote(raw).replace("\\", "/")
    if candidate.lower().startswith("file:"):
        return None

    # 웹 URL 등 URI scheme은 내부 문서 경로가 아니다. Windows 드라이브 표기만 예외로
    # 남겨 Windows에서 선택한 워크스페이스의 절대 경로를 올바르게 처리한다.
    if re.match(r"^[A-Za-z][A-Za-z\d+.-]*:", candidate) and not _WINDOWS_ABSOLUTE_PATH_RE.match(candidate):
        return None

    # 헤딩 fragment/query는 파일 이름에 포함하지 않고, Codex의 줄/열 접미사는 제거한다.
    candidate = re.split(r"[?#]", candidate, maxsplit=1)[0]
    candidate = _CODEX_LINE_REFERENCE_RE.sub(r"\1", candidate)
    if not candidate or "\x00" in candidate:
        return None

    # ``../``는 최종 경로가 다시 루트 안으로 들어오더라도 내부 링크 후보로 취급하지
    # 않는다. 정규화 이전에 검사해야 %2e%2e/와 Windows 구분자도 같은 규칙을 따른다.
    if any(part == ".." for part in candidate.split("/")):
        return None

    root = notes_dir().resolve()
    is_windows_absolute = bool(_WINDOWS_ABSOLUTE_PATH_RE.match(candidate))
    if is_windows_absolute and os.name != "nt":
        # POSIX 서버에서 Windows 절대 경로는 로컬 워크스페이스가 될 수 없다. 이 분기는
        # 상대 Windows 구분자(`folder\\note.md`)를 막지 않는다.
        return None

    raw_path = Path(candidate)
    target = raw_path if raw_path.is_absolute() or is_windows_absolute else root / raw_path
    try:
        target = target.resolve()
        relative = target.relative_to(root)
    except (OSError, ValueError):
        return None

    # 파일 트리와 동일한 관리 범위를 적용한다. 실제 존재하는 Markdown/ERD 파일만
    # 허용하고 숨김·예약 디렉터리는 제외한다.
    if not relative.parts or any(part.startswith(".") for part in relative.parts):
        return None
    if relative.parts[0] in EXCLUDED_DIRS or not target.is_file():
        return None
    kind = _document_kind(target)
    if not kind:
        return None
    return {"kind": kind, "path": relative.as_posix()}


def resolve_path(rel: str) -> Path:
    rel = (rel or "").strip().strip("/")
    root = notes_dir().resolve()
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise HTTPException(status_code=400, detail="노트 루트 밖의 경로는 허용되지 않습니다")
    parts = p.relative_to(root).parts
    if any(part.startswith(".") or (i == 0 and part in EXCLUDED_DIRS) for i, part in enumerate(parts)):
        raise HTTPException(status_code=400, detail="예약된 디렉토리는 접근할 수 없습니다")
    return p


def rel_str(p: Path) -> str:
    # API와 SQLite에는 운영체제와 무관한 워크스페이스 상대 경로를 저장한다.
    # Windows의 역슬래시를 그대로 쓰면 `tasks/%`, `scopes/%` 조회에서
    # 방금 생성한 행이 누락된다.
    return p.resolve().relative_to(notes_dir().resolve()).as_posix()


def _special_note_kind(path: Path) -> str | None:
    """자동 관리 메모리/지시사항은 트리에서도 일반 노트와 구분해 보여준다."""
    try:
        note_type = str(frontmatter.load(path).metadata.get("type") or "")
    except Exception:  # noqa: BLE001
        return None
    return note_type if note_type in {"agents", "memories"} else None


def _show_all_files() -> bool:
    """워크스페이스별 파일 탐색기 표시 설정을 안전하게 읽는다."""
    path = notes_dir() / ".workspace.json"
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    explorer = data.get("explorer") if isinstance(data, dict) else None
    return explorer.get("show_all_files") is True if isinstance(explorer, dict) else False


def build_tree(
    dir_path: Path,
    icons: dict[str, str] | None = None,
    *,
    show_all_files: bool = False,
) -> list[dict]:
    """트리 구성. `foo.md`와 같은 이름의 폴더 `foo/`는 노션식 하위 노트로 병합해 한 노드로 표시."""
    icons = icons if icons is not None else {}
    try:
        children = sorted(dir_path.iterdir(), key=lambda c: c.name.lower())
    except FileNotFoundError:
        return []
    is_root = dir_path.resolve() == notes_dir().resolve()
    visible = [
        c
        for c in children
        if not c.name.startswith(".")
        and not (is_root and c.name in TREE_HIDDEN_ROOT_DIRS)
    ]
    dirs = {c.name: c for c in visible if c.is_dir()}
    md_files = [c for c in visible if c.is_file() and c.suffix == ".md"]
    erd_files = [c for c in visible if c.is_file() and c.name.endswith(".erd.json")]
    managed_files = {*md_files, *erd_files}
    other_files = [
        c for c in visible
        if show_all_files and c.is_file() and c not in managed_files
    ]

    consumed = set()
    file_entries = []
    for f in md_files:
        node: dict = {"name": f.name, "path": rel_str(f), "type": "file"}
        special = _special_note_kind(f)
        if special:
            node["special"] = special
        icon = icons.get(node["path"])
        if icon:
            node["icon"] = icon
        companion = dirs.get(f.stem)
        if companion is not None:
            node["children"] = build_tree(companion, icons, show_all_files=show_all_files)
            consumed.add(f.stem)
        file_entries.append(node)

    erd_entries = [
        {"name": f.name, "path": rel_str(f), "type": "erd"}
        for f in erd_files
    ]

    other_entries = [
        {"name": f.name, "path": rel_str(f), "type": "other"}
        for f in other_files
    ]

    dir_entries = [
        {
            "name": d.name,
            "path": rel_str(d),
            "type": "dir",
            "children": build_tree(d, icons, show_all_files=show_all_files),
        }
        for name, d in dirs.items()
        if name not in consumed
    ]
    return dir_entries + erd_entries + file_entries + other_entries


@router.get("/tree")
def get_tree():
    return {
        "children": build_tree(
            notes_dir(),
            db.all_icons(),
            show_all_files=_show_all_files(),
        )
    }


@router.get("/document-link")
def get_document_link_target(href: str):
    """현재 워크스페이스에서만 유효한 채팅 내부 문서 링크를 확인한다."""
    return {"target": resolve_document_link_target(href)}


class CreateRequest(BaseModel):
    path: str
    type: str  # "file" | "dir"
    date: str | None = None  # 데일리 노트 등 생성 시 frontmatter date 지정
    template: str | None = None  # 본문/태그를 복사할 템플릿 노트 경로


@router.post("")
def create_entry(req: CreateRequest):
    p = resolve_path(req.path)
    if req.type == "dir":
        if p.exists():
            raise HTTPException(status_code=409, detail="이미 존재하는 디렉토리입니다")
        p.mkdir(parents=True)
        return {"path": rel_str(p), "type": "dir"}

    if p.suffix != ".md":
        p = p.with_name(p.name + ".md")
    if p.exists():
        raise HTTPException(status_code=409, detail="이미 존재하는 파일입니다")
    p.parent.mkdir(parents=True, exist_ok=True)

    body, tags = "", []
    if req.template:
        tpl = resolve_path(req.template)
        if not tpl.is_file():
            raise HTTPException(status_code=404, detail="템플릿을 찾을 수 없습니다")
        tpl_note = indexer.parse_note(tpl)
        body, tags = tpl_note["body"], tpl_note["tags"]

    date = req.date or datetime.date.today().isoformat()
    post = frontmatter.Post(body, title=p.stem, date=date, tags=tags)
    p.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
    indexer.index_file(rel_str(p))
    return {"path": rel_str(p), "type": "file"}


@router.get("/content")
def get_content(path: str):
    p = resolve_path(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    note = indexer.parse_note(p)
    return {
        "path": rel_str(p),
        "frontmatter": {
            "title": note["title"],
            "date": note["date"],
            "tags": note["tags"],
            "icon": note["icon"] or None,
            "cover": note["cover"] or None,
            "extra": note["props"],  # 앱이 모르는 frontmatter 키 — 저장 시 그대로 보존
        },
        "body": note["body"],
        "mtime": p.stat().st_mtime,
    }


class SaveRequest(BaseModel):
    path: str
    frontmatter: dict
    body: str
    mtime: float | None = None  # 마지막으로 읽은 시점의 mtime (충돌 감지용)
    force: bool = False


@router.put("/content")
def save_content(req: SaveRequest):
    p = resolve_path(req.path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다")
    if not req.force and req.mtime is not None:
        current = p.stat().st_mtime
        if abs(current - req.mtime) > 1e-6:
            raise HTTPException(
                status_code=409,
                detail="파일이 외부에서 수정되었습니다",
                headers={"X-Current-Mtime": str(current)},
            )

    fm = dict(req.frontmatter)
    extra = fm.pop("extra", None)
    if isinstance(extra, dict):
        fm = {**extra, **fm}  # 앱이 모르는 키 보존, 알려진 키가 우선
    fm = {k: v for k, v in fm.items() if v is not None and v != ""}
    if isinstance(fm.get("tags"), list):
        fm["tags"] = [str(t) for t in fm["tags"]]
    post = frontmatter.Post(req.body, **fm)
    p.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
    indexer.index_file(rel_str(p))
    return {"mtime": p.stat().st_mtime}


def _project_agents_target(path: str) -> tuple[Path, set[str]]:
    # workspace 라우터가 files.resolve_path를 import하므로 모듈 초기화 순환을 피하려고
    # 실제 요청 시점에만 가져온다.
    from .workspace import resolve_registered_scope_agents

    return resolve_registered_scope_agents(path)


@router.get("/content-external")
def get_external_content(path: str):
    """등록된 프로젝트 루트의 실제 AGENTS.md만 원문 Markdown으로 연다."""
    target, _scope_ids = _project_agents_target(path)
    try:
        raw = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 AGENTS.md를 읽지 못했습니다") from exc

    # 과거 노트 앱 템플릿으로 만든 type: agents 파일만 메타데이터를 걷어내어
    # 다음 저장부터 Codex가 읽는 평범한 Markdown 문서로 정리한다.
    body = raw
    try:
        post = frontmatter.loads(raw)
        if post.metadata.get("type") == "agents":
            body = post.content
    except Exception:  # noqa: BLE001
        pass
    return {
        "path": str(target),
        "external": True,
        "frontmatter": {
            "title": "AGENTS.md",
            "date": None,
            "tags": [],
            "icon": None,
            "cover": None,
            "extra": {},
        },
        "body": body,
        "mtime": target.stat().st_mtime,
    }


@router.put("/content-external")
def save_external_content(req: SaveRequest):
    """프로젝트 AGENTS.md 본문을 frontmatter 없이 원자적으로 저장한다."""
    target, scope_ids = _project_agents_target(req.path)
    current_stat = target.stat()
    if not req.force and req.mtime is not None and abs(current_stat.st_mtime - req.mtime) > 1e-6:
        raise HTTPException(
            status_code=409,
            detail="파일이 외부에서 수정되었습니다",
            headers={"X-Current-Mtime": str(current_stat.st_mtime)},
        )

    text = req.body.rstrip() + "\n"
    fd = -1
    temp_name = ""
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, current_stat.st_mode)
        os.replace(temp_name, target)
        temp_name = ""
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="프로젝트 AGENTS.md를 수정할 권한이 없습니다") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="프로젝트 AGENTS.md를 저장하지 못했습니다") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        if temp_name:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
    # Codex는 AGENTS.md를 첫 턴 지시에 포함한다. 기존 대화의 최근 문맥은 유지하되,
    # 다음 실행은 새 스레드에서 이 파일을 다시 읽도록 마이그레이션 표시한다.
    from ..ai import sessions as ai_sessions

    refreshed_sessions = ai_sessions.invalidate_scope_instruction_threads(scope_ids)
    return {"mtime": target.stat().st_mtime, "sessions_marked_for_refresh": refreshed_sessions}


class RenameRequest(BaseModel):
    path: str
    new_name: str


def _companion_dir(p: Path) -> Path | None:
    """`foo.md`의 하위 노트 폴더 `foo/` (노션식 하위 노트)."""
    if p.is_file() and p.suffix == ".md":
        comp = p.with_suffix("")
        if comp.is_dir():
            return comp
    return None


@router.post("/rename")
def rename_entry(req: RenameRequest):
    src = resolve_path(req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    new_name = req.new_name.strip()
    if not new_name or "/" in new_name:
        raise HTTPException(status_code=400, detail="올바르지 않은 이름입니다")
    if src.is_file() and src.name.endswith(".erd.json"):
        if not new_name.endswith(".erd.json"):
            new_name += ".erd.json"
    elif src.is_file() and src.suffix == ".md" and not new_name.endswith(".md"):
        new_name += ".md"
    elif src.is_file() and not Path(new_name).suffix and src.suffix:
        # 기타 문서는 사용자가 새 확장자를 명시하지 않았을 때만 기존 확장자를 보존한다.
        new_name += src.suffix
    dst = src.with_name(new_name)
    if dst.exists():
        raise HTTPException(status_code=409, detail="같은 이름이 이미 존재합니다")
    comp_src = _companion_dir(src)
    comp_dst = dst.with_suffix("") if comp_src else None
    if comp_dst is not None and comp_dst.exists():
        raise HTTPException(status_code=409, detail="하위 노트 폴더와 같은 이름이 이미 존재합니다")
    indexer.remove(rel_str(src))
    src.rename(dst)
    if comp_src is not None:
        indexer.remove(rel_str(comp_src))
        comp_src.rename(comp_dst)
        _reindex_moved(comp_dst)
    _reindex_moved(dst)
    return {"path": rel_str(dst)}


class MoveRequest(BaseModel):
    path: str
    dest_dir: str  # "" 는 루트


@router.post("/move")
def move_entry(req: MoveRequest):
    src = resolve_path(req.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    dest_dir = resolve_path(req.dest_dir)
    if not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="대상 디렉토리가 없습니다")
    if src.is_dir() and (dest_dir == src or src in dest_dir.parents):
        raise HTTPException(status_code=400, detail="자기 자신 안으로 이동할 수 없습니다")
    dst = dest_dir / src.name
    if dst == src:
        return {"path": rel_str(src)}
    if dst.exists():
        raise HTTPException(status_code=409, detail="같은 이름이 이미 존재합니다")
    comp_src = _companion_dir(src)
    if comp_src is not None:
        if dest_dir == comp_src or comp_src in dest_dir.parents:
            raise HTTPException(status_code=400, detail="자신의 하위 노트 안으로 이동할 수 없습니다")
        if (dest_dir / comp_src.name).exists():
            raise HTTPException(status_code=409, detail="하위 노트 폴더와 같은 이름이 이미 존재합니다")
    indexer.remove(rel_str(src))
    shutil.move(str(src), str(dst))
    if comp_src is not None:
        indexer.remove(rel_str(comp_src))
        comp_dst = dest_dir / comp_src.name
        shutil.move(str(comp_src), str(comp_dst))
        _reindex_moved(comp_dst)
    _reindex_moved(dst)
    return {"path": rel_str(dst)}


@router.delete("")
def delete_entry(path: str):
    p = resolve_path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="대상을 찾을 수 없습니다")
    if p == notes_dir():
        raise HTTPException(status_code=400, detail="루트는 삭제할 수 없습니다")
    trash = trash_dir()
    trash.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    def trash_one(target: Path) -> Path:
        dst = trash / f"{stamp}-{target.name}"
        n = 1
        while dst.exists():
            dst = trash / f"{stamp}-{n}-{target.name}"
            n += 1
        indexer.remove(rel_str(target))
        shutil.move(str(target), str(dst))
        return dst

    comp = _companion_dir(p)
    dst = trash_one(p)
    if comp is not None:
        trash_one(comp)
    return {"trashed_to": dst.relative_to(notes_dir()).as_posix()}


@router.post("/import")
async def import_files(files: list[UploadFile], dest_dir: str = Form("")):
    """OS 드래그&드롭으로 받은 .md 파일들을 대상 디렉토리에 저장."""
    base = resolve_path(dest_dir)
    if not base.is_dir():
        raise HTTPException(status_code=400, detail="대상 디렉토리가 없습니다")
    created: list[str] = []
    skipped: list[str] = []
    for f in files:
        name = Path(f.filename or "").name
        if not name.lower().endswith(".md"):
            skipped.append(name or "(이름 없음)")
            continue
        data = await f.read()
        dst = base / name
        stem, n = dst.stem, 1
        while dst.exists():
            dst = base / f"{stem}-{n}.md"
            n += 1
        dst.write_bytes(data)
        indexer.index_file(rel_str(dst))
        created.append(rel_str(dst))
    return {"created": created, "skipped": skipped}


def _reindex_moved(dst: Path) -> None:
    if dst.is_file():
        indexer.index_file(rel_str(dst))
    else:
        for f in dst.rglob("*.md"):
            indexer.index_file(rel_str(f))
