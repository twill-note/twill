from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import frontmatter

from .config import CONFIG_PATH, REPO_ROOT


SKILLBOOK_ROOT = Path(os.environ.get("NOTE_APP_SKILLBOOK_DIR", CONFIG_PATH.parent / "skillbook")).expanduser().resolve()
BUNDLED_SKILLBOOK_ROOT = REPO_ROOT / "skillbook"
APP_SKILLS_DIR = SKILLBOOK_ROOT / "skills"
TRASH_DIR = SKILLBOOK_ROOT / ".trash"
SYSTEM_MANUAL_DIR = REPO_ROOT / "backend" / "app" / "system_manual"

SKILL_ID_PREFIX = "skillbook:"
MANUAL_ID_PREFIX = "system-manual:"
READ_ONLY_SKILL_NAMES = frozenset({"create-system-skill"})
SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SKILLBOOK_LANGUAGE = "ko"
SEARCH_TERM_RE = re.compile(r"[^\W_]+", re.UNICODE)
STRONG_SEARCH_MATCH_MIN = 7_000
MAX_TEXT_BYTES = 1_000_000
TEXT_SUFFIXES = {
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".csv", ".tsv", ".py", ".js", ".jsx", ".ts", ".tsx",
    ".css", ".scss", ".html", ".xml", ".sql", ".sh",
}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


class SkillBookError(Exception):
    pass


class SkillBookNotFound(SkillBookError):
    pass


class SkillBookReadOnly(SkillBookError):
    pass


class SkillBookConflict(SkillBookError):
    pass


class SkillBookValidationError(SkillBookError):
    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or [message]


def ensure_skillbook_dirs() -> None:
    APP_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)


def set_skillbook_language(language: str) -> str:
    """Set the app's active locale for localized skillbook catalog entries and reads."""
    global _SKILLBOOK_LANGUAGE
    _SKILLBOOK_LANGUAGE = "en" if language == "en" else "ko"
    return _SKILLBOOK_LANGUAGE


def initialize_skillbook(legacy_roots: list[Path] | None = None) -> dict[str, Any]:
    """Copy legacy skills out of the install directory without overwriting user data.

    A source is imported once so deleted/renamed skills do not reappear on startup.
    Copies are staged before rename; failed imports never receive a completion marker.
    """
    import hashlib

    ensure_skillbook_dirs()
    imported: list[str] = []
    for source in legacy_roots if legacy_roots is not None else [BUNDLED_SKILLBOOK_ROOT]:
        source = source.resolve()
        if source == SKILLBOOK_ROOT.resolve() or not source.is_dir():
            continue
        key = hashlib.sha256(str(source).encode()).hexdigest()[:20]
        marker = SKILLBOOK_ROOT / f".migrated-{key}.json"
        if marker.exists():
            continue
        for directory, destination in [(source / "skills", APP_SKILLS_DIR), (source / ".trash", TRASH_DIR)]:
            if not directory.is_dir() or directory.is_symlink():
                continue
            for entry in sorted(directory.iterdir()):
                target = destination / entry.name
                if not entry.is_dir() or entry.is_symlink() or entry.name.startswith(".") or target.exists():
                    continue
                with tempfile.TemporaryDirectory(prefix=".import-", dir=SKILLBOOK_ROOT) as staging:
                    staged = Path(staging) / entry.name
                    shutil.copytree(entry, staged, ignore=lambda folder, names: [
                        name for name in names if (Path(folder) / name).is_symlink()
                    ])
                    staged.rename(target)
                imported.append(f"{directory.name}/{entry.name}")
        marker.write_text(json.dumps({"source": str(source), "imported": imported}, ensure_ascii=False), encoding="utf-8")

    # This built-in guide contains the storage contract and must follow app updates.
    # Editable user skills are never replaced by bundled defaults.
    for name in READ_ONLY_SKILL_NAMES:
        source = BUNDLED_SKILLBOOK_ROOT / "skills" / name
        target = APP_SKILLS_DIR / name
        if source.is_dir() and not source.is_symlink() and source.resolve() != target.resolve():
            if target.is_symlink():
                raise SkillBookValidationError("기본 스킬 저장 경로에 심볼릭 링크가 있습니다.")
            shutil.copytree(source, target, dirs_exist_ok=True)
    return {"path": str(SKILLBOOK_ROOT), "imported": imported}


def _markdown_title_and_description(path: Path) -> tuple[str, str]:
    try:
        post = frontmatter.load(path)
        body = post.content
        title = str(post.metadata.get("title") or "").strip()
        description = str(post.metadata.get("description") or "").strip()
    except Exception:
        body = path.read_text(encoding="utf-8", errors="replace")
        title = ""
        description = ""

    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not title and line.startswith("# "):
            title = line[2:].strip()
            continue
        if not description and line and not line.startswith("#"):
            description = line
        if title and description:
            break
    return title or path.stem, description or "시스템 매뉴얼"


def _markdown_search_terms(path: Path) -> list[str]:
    try:
        values = frontmatter.load(path).metadata.get("keywords", [])
    except Exception:
        return []
    return _normalize_search_terms(values)


def _normalize_search_terms(values: Any) -> list[str]:
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        return []
    return [str(value).strip() for value in values if str(value).strip()]


def _validate_skill_dir(skill_dir: Path) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    skill_file = skill_dir / "SKILL.md"
    metadata: dict[str, Any] = {}
    name = skill_dir.name

    if skill_dir.is_symlink():
        return {"name": name, "description": "심볼릭 링크 스킬은 지원하지 않습니다."}, [
            "심볼릭 링크 스킬 디렉터리는 허용되지 않습니다."
        ]
    if not skill_file.is_file():
        return {"name": name, "description": "SKILL.md가 없습니다."}, ["SKILL.md가 없습니다."]

    try:
        post = frontmatter.load(skill_file)
        metadata = dict(post.metadata)
    except Exception as exc:
        errors.append(f"SKILL.md frontmatter를 읽을 수 없습니다: {exc}")

    allowed_keys = {"name", "description", "keywords"}
    extra_keys = sorted(set(metadata) - allowed_keys)
    missing_keys = sorted({"name", "description"} - set(metadata))
    if missing_keys:
        errors.append(f"필수 frontmatter가 없습니다: {', '.join(missing_keys)}")
    if extra_keys:
        errors.append(f"허용되지 않은 frontmatter가 있습니다: {', '.join(extra_keys)}")

    name = str(metadata.get("name") or skill_dir.name).strip()
    description = str(metadata.get("description") or "").strip()
    if not SKILL_NAME_RE.fullmatch(name):
        errors.append("name은 소문자, 숫자, 하이픈만 사용할 수 있습니다.")
    if name != skill_dir.name:
        errors.append("name은 스킬 디렉터리 이름과 같아야 합니다.")
    if not description:
        errors.append("description은 비어 있을 수 없습니다.")

    return {
        "name": name,
        "description": description or "설명이 없습니다.",
        "keywords": _normalize_search_terms(metadata.get("keywords", [])),
    }, errors


def _app_skill_summaries() -> list[dict[str, Any]]:
    ensure_skillbook_dirs()
    summaries: list[dict[str, Any]] = []
    for skill_dir in sorted(APP_SKILLS_DIR.iterdir(), key=lambda path: path.name.lower()):
        if not skill_dir.is_dir():
            continue
        metadata, errors = _validate_skill_dir(skill_dir)
        read_only = skill_dir.name in READ_ONLY_SKILL_NAMES
        summaries.append(
            {
                "id": f"{SKILL_ID_PREFIX}{skill_dir.name}",
                "name": metadata["name"],
                "description": metadata["description"],
                "search_terms": metadata.get("keywords", []),
                "source": "app_skill",
                "read_only": read_only,
                "entry_file": "SKILL.md",
                "valid": not errors,
            }
        )
    return summaries


def _manual_summaries() -> list[dict[str, Any]]:
    if not SYSTEM_MANUAL_DIR.is_dir():
        return []
    summaries: list[dict[str, Any]] = []
    for manual_file in sorted(SYSTEM_MANUAL_DIR.glob("*.md"), key=lambda path: path.name.lower()):
        if not manual_file.is_file() or manual_file.is_symlink():
            continue
        if manual_file.stem.endswith(".en"):
            continue
        entry_file = manual_file
        localized_english = manual_file.with_name(f"{manual_file.stem}.en.md")
        if _SKILLBOOK_LANGUAGE == "en" and localized_english.is_file() and not localized_english.is_symlink():
            entry_file = localized_english
        title, description = _markdown_title_and_description(entry_file)
        summaries.append(
            {
                "id": f"{MANUAL_ID_PREFIX}{manual_file.stem}",
                "name": title,
                "description": description,
                "search_terms": _markdown_search_terms(entry_file),
                "source": "system_manual",
                "read_only": True,
                "entry_file": entry_file.name,
                "valid": True,
            }
        )
    return summaries


def _normalized_search_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _skillbook_search_score(entry: dict[str, Any], query: str) -> int:
    """Return a positive relevance score when an entry matches a natural-language query.

    The tool is commonly called with a whole user request rather than a single keyword.
    An exact catalog name embedded in that request must therefore remain discoverable,
    while individual terms provide a fallback for punctuation or reordered wording.
    """
    needle = _normalized_search_text(query)
    if not needle:
        return 0

    name = _normalized_search_text(entry.get("name"))
    description = _normalized_search_text(entry.get("description"))
    entry_id = _normalized_search_text(entry.get("id"))
    score = 0

    for search_term in entry.get("search_terms", []):
        alias = _normalized_search_text(search_term)
        if alias and (alias in needle or needle in alias):
            score = max(score, 8_500 + len(alias))

    if needle == name:
        score = max(score, 10_000)
    elif name and name in needle:
        score = max(score, 9_000 + len(name))
    elif needle in name:
        score = max(score, 8_000 + len(needle))

    if needle in description:
        score = max(score, 7_000 + len(needle))
    if needle in entry_id:
        score = max(score, 7_500 + len(needle))

    terms = {
        term
        for term in SEARCH_TERM_RE.findall(needle)
        if len(term) >= 2
    }
    matched_terms = 0
    term_score = 0
    for term in terms:
        best = 0
        if term == name:
            best = 120
        elif term in name:
            best = 80
        elif term in entry_id:
            best = 60
        elif term in description:
            best = 40
        if best:
            matched_terms += 1
            term_score += best

    if matched_terms:
        score = max(score, term_score + matched_terms * 10)
    return score


def list_skillbook(
    *,
    query: str | None = None,
    source: str | None = None,
) -> list[dict[str, Any]]:
    entries = [*_app_skill_summaries(), *_manual_summaries()]
    if source and source != "all":
        entries = [entry for entry in entries if entry["source"] == source]
    needle = _normalized_search_text(query)
    if not needle:
        return sorted(entries, key=lambda entry: (entry["source"], entry["name"].casefold()))

    scored_entries = [
        (_skillbook_search_score(entry, needle), entry)
        for entry in entries
    ]
    positive_entries = [item for item in scored_entries if item[0] > 0]
    strong_entries = [
        item for item in positive_entries if item[0] >= STRONG_SEARCH_MATCH_MIN
    ]
    matched_entries = strong_entries or positive_entries
    return [
        entry
        for score, entry in sorted(
            matched_entries,
            key=lambda item: (
                -item[0],
                item[1]["source"],
                item[1]["name"].casefold(),
            ),
        )
    ]


def get_skillbook_summary(entry_id: str) -> dict[str, Any]:
    for summary in list_skillbook():
        if summary["id"] == entry_id:
            return summary
    raise SkillBookNotFound(f"스킬북 항목을 찾을 수 없습니다: {entry_id}")


def _entry_root_and_default_path(entry_id: str) -> tuple[dict[str, Any], Path, str]:
    summary = get_skillbook_summary(entry_id)
    if summary["source"] == "app_skill":
        root = APP_SKILLS_DIR / entry_id.removeprefix(SKILL_ID_PREFIX)
        default_path = "SKILL.md"
    else:
        root = SYSTEM_MANUAL_DIR
        default_path = summary["entry_file"]
    return summary, root, default_path


def _safe_component_path(root: Path, relative_path: str) -> Path:
    if not relative_path or "\x00" in relative_path:
        raise SkillBookValidationError("유효한 구성요소 경로가 필요합니다.")
    rel = Path(relative_path)
    if rel.is_absolute() or ".." in rel.parts:
        raise SkillBookValidationError("스킬 디렉터리 밖의 경로에는 접근할 수 없습니다.")
    cursor = root
    for part in rel.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise SkillBookValidationError("심볼릭 링크 구성요소에는 접근할 수 없습니다.")
    resolved_root = root.resolve()
    target = (root / rel).resolve()
    try:
        target.relative_to(resolved_root)
    except ValueError as exc:
        raise SkillBookValidationError("스킬 디렉터리 밖의 경로에는 접근할 수 없습니다.") from exc
    return target


def _component_kind(path: Path) -> str:
    if path.is_dir():
        return "directory"
    suffix = path.suffix.lower()
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in TEXT_SUFFIXES:
        return "text"
    return "binary"


def _list_components(summary: dict[str, Any], root: Path) -> list[dict[str, Any]]:
    if summary["source"] == "system_manual":
        paths = [root / summary["entry_file"]]
    else:
        paths = sorted(
            (
                path
                for path in root.rglob("*")
                if not path.is_symlink()
                and not any(part.startswith(".") for part in path.relative_to(root).parts)
            ),
            key=lambda path: (not path.is_dir(), path.as_posix().casefold()),
        )

    components: list[dict[str, Any]] = []
    for path in paths:
        rel_path = path.relative_to(root).as_posix()
        stat = path.stat()
        kind = _component_kind(path)
        components.append(
            {
                "path": rel_path,
                "kind": kind,
                "size": 0 if path.is_dir() else stat.st_size,
                "mtime": stat.st_mtime,
                "read_only": summary["read_only"],
                "editable": not summary["read_only"] and kind != "directory",
            }
        )
    return components


def get_skillbook_detail(entry_id: str) -> dict[str, Any]:
    summary, root, _ = _entry_root_and_default_path(entry_id)
    errors: list[str] = []
    if summary["source"] == "app_skill":
        _, errors = _validate_skill_dir(root)
    return {
        "summary": summary,
        "components": _list_components(summary, root),
        "validation_errors": errors,
    }


def read_skillbook_component(entry_id: str, relative_path: str | None = None) -> dict[str, Any]:
    summary, root, default_path = _entry_root_and_default_path(entry_id)
    path_text = relative_path or default_path
    if summary["source"] == "system_manual" and path_text != default_path:
        raise SkillBookValidationError("시스템 매뉴얼 항목은 대표 문서만 조회할 수 있습니다.")
    target = _safe_component_path(root, path_text)
    if not target.exists():
        raise SkillBookNotFound(f"구성요소를 찾을 수 없습니다: {path_text}")

    stat = target.stat()
    kind = _component_kind(target)
    result: dict[str, Any] = {
        "id": entry_id,
        "path": path_text,
        "kind": kind,
        "size": 0 if target.is_dir() else stat.st_size,
        "mtime": stat.st_mtime,
        "read_only": summary["read_only"],
        "editable": not summary["read_only"] and kind != "directory",
        "frontmatter": {},
        "content": None,
        "mime_type": mimetypes.guess_type(target.name)[0] or "application/octet-stream",
    }
    if kind == "directory":
        return result
    if stat.st_size > MAX_TEXT_BYTES and kind in {"markdown", "text"}:
        raise SkillBookValidationError("1MB를 초과하는 텍스트 구성요소는 편집기에서 열 수 없습니다.")
    if kind == "markdown":
        post = frontmatter.load(target)
        result["frontmatter"] = dict(post.metadata)
        result["content"] = post.content
    elif kind == "text":
        result["content"] = target.read_text(encoding="utf-8")
    return result


def _validate_skill_metadata(metadata: dict[str, Any]) -> tuple[str, str]:
    if set(metadata) != {"name", "description"}:
        raise SkillBookValidationError("SKILL.md frontmatter에는 name과 description만 있어야 합니다.")
    name = str(metadata.get("name") or "").strip()
    description = str(metadata.get("description") or "").strip()
    if not SKILL_NAME_RE.fullmatch(name):
        raise SkillBookValidationError("name은 소문자, 숫자, 하이픈만 사용할 수 있습니다.")
    if not description:
        raise SkillBookValidationError("description은 비어 있을 수 없습니다.")
    return name, description


def save_skillbook_component(
    entry_id: str,
    relative_path: str,
    *,
    content: str,
    metadata: dict[str, Any] | None,
    expected_mtime: float | None,
) -> dict[str, Any]:
    summary, root, _ = _entry_root_and_default_path(entry_id)
    if summary["read_only"]:
        raise SkillBookReadOnly("읽기 전용 스킬북 항목은 수정할 수 없습니다.")
    target = _safe_component_path(root, relative_path)
    if not target.is_file():
        raise SkillBookNotFound(f"편집할 파일을 찾을 수 없습니다: {relative_path}")
    if _component_kind(target) not in {"markdown", "text"}:
        raise SkillBookValidationError("텍스트 또는 Markdown 구성요소만 편집할 수 있습니다.")

    current_mtime = target.stat().st_mtime
    if expected_mtime is not None and abs(current_mtime - expected_mtime) > 0.000001:
        raise SkillBookConflict("다른 작업에서 파일이 변경되었습니다. 다시 열고 수정해 주세요.")

    new_skill_name: str | None = None
    if _component_kind(target) == "markdown":
        current_post = frontmatter.load(target)
        next_metadata = dict(current_post.metadata) if metadata is None else dict(metadata)
        if relative_path == "SKILL.md":
            new_skill_name, _ = _validate_skill_metadata(next_metadata)
            next_root = APP_SKILLS_DIR / new_skill_name
            if new_skill_name != root.name and next_root.exists():
                raise SkillBookConflict(f"같은 이름의 스킬이 이미 있습니다: {new_skill_name}")
        post = frontmatter.Post(content, **next_metadata)
        serialized = frontmatter.dumps(post)
        if not serialized.endswith("\n"):
            serialized += "\n"
    else:
        serialized = content

    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temp_file:
            temp_file.write(serialized)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)

    next_entry_id = entry_id
    if new_skill_name and new_skill_name != root.name:
        next_root = APP_SKILLS_DIR / new_skill_name
        root.rename(next_root)
        next_entry_id = f"{SKILL_ID_PREFIX}{new_skill_name}"

    result = read_skillbook_component(next_entry_id, relative_path)
    result["id"] = next_entry_id
    result["detail"] = get_skillbook_detail(next_entry_id)
    return result


def create_skill(name: str, description: str) -> dict[str, Any]:
    ensure_skillbook_dirs()
    clean_name, clean_description = _validate_skill_metadata(
        {"name": name.strip(), "description": description.strip()}
    )
    skill_dir = APP_SKILLS_DIR / clean_name
    if skill_dir.exists():
        raise SkillBookConflict(f"같은 이름의 스킬이 이미 있습니다: {clean_name}")

    skill_dir.mkdir(parents=True)
    post = frontmatter.Post(
        f"# {clean_name}\n\n{clean_description}\n",
        name=clean_name,
        description=clean_description,
    )
    (skill_dir / "SKILL.md").write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
    return get_skillbook_detail(f"{SKILL_ID_PREFIX}{clean_name}")


def delete_skill(entry_id: str) -> dict[str, str]:
    summary, root, _ = _entry_root_and_default_path(entry_id)
    if summary["read_only"]:
        raise SkillBookReadOnly("읽기 전용 스킬북 항목은 삭제할 수 없습니다.")
    ensure_skillbook_dirs()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    destination = TRASH_DIR / f"{root.name}-{timestamp}"
    counter = 1
    while destination.exists():
        destination = TRASH_DIR / f"{root.name}-{timestamp}-{counter}"
        counter += 1
    shutil.move(str(root), str(destination))
    return {"id": entry_id, "trash_path": destination.relative_to(SKILLBOOK_ROOT).as_posix()}


def asset_path(entry_id: str, relative_path: str) -> Path:
    summary, root, default_path = _entry_root_and_default_path(entry_id)
    if summary["source"] == "system_manual" and relative_path != default_path:
        raise SkillBookValidationError("시스템 매뉴얼 항목은 대표 문서만 조회할 수 있습니다.")
    target = _safe_component_path(root, relative_path)
    if not target.is_file():
        raise SkillBookNotFound(f"구성요소를 찾을 수 없습니다: {relative_path}")
    return target


def replace_asset(
    entry_id: str,
    relative_path: str,
    *,
    data: bytes,
    expected_mtime: float | None,
) -> dict[str, Any]:
    summary, root, _ = _entry_root_and_default_path(entry_id)
    if summary["read_only"]:
        raise SkillBookReadOnly("읽기 전용 스킬북 항목은 수정할 수 없습니다.")
    target = _safe_component_path(root, relative_path)
    if not target.is_file():
        raise SkillBookNotFound(f"교체할 파일을 찾을 수 없습니다: {relative_path}")
    if _component_kind(target) in {"markdown", "text", "directory"}:
        raise SkillBookValidationError("텍스트 파일은 편집기에서 수정해야 합니다.")
    if len(data) > 10 * 1024 * 1024:
        raise SkillBookValidationError("구성요소 파일은 10MB를 초과할 수 없습니다.")
    current_mtime = target.stat().st_mtime
    if expected_mtime is not None and abs(current_mtime - expected_mtime) > 0.000001:
        raise SkillBookConflict("다른 작업에서 파일이 변경되었습니다. 다시 열고 수정해 주세요.")

    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as temp_file:
            temp_file.write(data)
            temp_file.flush()
            os.fsync(temp_file.fileno())
        os.replace(temp_name, target)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    result = read_skillbook_component(entry_id, relative_path)
    result["detail"] = get_skillbook_detail(entry_id)
    return result


def list_skillbook_tool(arguments: Any) -> str:
    args = arguments if isinstance(arguments, dict) else {}
    source = args.get("source")
    if source not in {None, "all", "app_skill", "system_manual"}:
        raise SkillBookValidationError("source는 all, app_skill, system_manual 중 하나여야 합니다.")
    summaries = [
        summary
        for summary in list_skillbook(query=args.get("query"), source=source)
        if summary["valid"]
    ]
    payload = {
        "storage_path": str(SKILLBOOK_ROOT),
        "skills": [
            {
                key: summary[key]
                for key in ("id", "name", "description", "source", "read_only", "search_terms")
            }
            for summary in summaries
        ],
        "usage": "필요한 항목을 선택한 뒤 read_skillbook으로 본문 또는 구성요소를 읽으세요.",
    }
    return json.dumps(payload, ensure_ascii=False)


def read_skillbook_tool(arguments: Any) -> str:
    if not isinstance(arguments, dict) or not str(arguments.get("id") or "").strip():
        raise SkillBookValidationError("id가 필요합니다.")
    entry_id = str(arguments["id"]).strip()
    summary = get_skillbook_summary(entry_id)
    if not summary["valid"]:
        raise SkillBookValidationError("검증에 실패한 스킬은 Twill AI가 실행할 수 없습니다.")
    path = arguments.get("path")
    component = read_skillbook_component(entry_id, str(path) if path else None)
    if component["kind"] not in {"markdown", "text"}:
        return json.dumps(component, ensure_ascii=False)
    payload = {
        "id": component["id"],
        "path": component["path"],
        "frontmatter": component["frontmatter"],
        "content": component["content"],
        "read_only": component["read_only"],
    }
    return json.dumps(payload, ensure_ascii=False)
