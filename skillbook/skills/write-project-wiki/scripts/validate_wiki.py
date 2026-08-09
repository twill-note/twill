#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


DEFAULT_FRONTMATTER_KEYS = {
    "title",
    "date",
    "tags",
    "icon",
    "status",
    "source_updated_at",
}
FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):")
H1_RE = re.compile(r"^# (.+?)\s*$", re.MULTILINE)
HEADING_RE = re.compile(r"^#{2,3}\s+(.+?)\s*$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
NUMBER_PREFIX_RE = re.compile(r"^\d{2}\s+")
STYLE_PATTERNS = (
    ("기능을 단순 부정형 대비로 소개함", re.compile(r"단순(?:히|한)?.{0,30}(?:아니다|않다)")),
    ("그치지 않는다는 대비를 사용함", re.compile(r"에\s+그치지\s+않")),
    ("A가 아니라 B 형태의 대비를 사용함", re.compile(r"(?:이|가|은|는)\s+아니라")),
)
HEADING_STYLE_PATTERN = re.compile(
    r"(?:먼저 .+|.+확인할 (?:순서|항목|사항)|.+알아둘 점|전체 (?:흐름|관계|순서)|자주 발생하는 실패)"
)


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_document(path: Path) -> tuple[dict[str, str] | None, str, list[str]]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None, text, []

    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text, ["frontmatter 종료 구분자가 없습니다."]

    metadata: dict[str, str] = {}
    for line in text[4:end].splitlines():
        match = FRONTMATTER_KEY_RE.match(line)
        if match:
            metadata[match.group(1)] = unquote(line[match.end():])
    return metadata, text[end + 5:], []


def normalized_name(value: str) -> str:
    value = value.strip().replace("\\", "/")
    value = value.split("|", 1)[0].split("#", 1)[0].split("^", 1)[0]
    value = value.rsplit("/", 1)[-1]
    if value.lower().endswith(".md"):
        value = value[:-3]
    return NUMBER_PREFIX_RE.sub("", value).strip().casefold()


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def validate(
    root: Path,
    link_root: Path,
    require_frontmatter: bool = False,
) -> tuple[list[str], list[str], int]:
    files = sorted(root.rglob("*.md"))
    errors: list[str] = []
    warnings: list[str] = []
    known_targets: set[str] = set()
    parsed: dict[Path, tuple[dict[str, str] | None, str, str]] = {}
    titles: dict[str, Path] = {}

    for path in files:
        rel = path.relative_to(root).as_posix()
        full_text = path.read_text(encoding="utf-8")
        metadata, body, parse_errors = parse_document(path)
        errors.extend(f"{rel}: {error}" for error in parse_errors)

        if require_frontmatter and metadata is None:
            errors.append(f"{rel}: frontmatter가 없습니다.")
        if require_frontmatter and metadata is not None:
            missing = sorted(DEFAULT_FRONTMATTER_KEYS - set(metadata))
            if missing:
                errors.append(f"{rel}: frontmatter 필수 항목 누락: {', '.join(missing)}")

        title = (metadata or {}).get("title", "").strip()
        h1_match = H1_RE.search(body)
        if not h1_match:
            errors.append(f"{rel}: H1 제목이 없습니다.")
        elif title and h1_match.group(1).strip() != title:
            errors.append(
                f"{rel}: frontmatter title과 H1이 다릅니다: "
                f"{title!r} != {h1_match.group(1).strip()!r}"
            )

        effective_title = title or (h1_match.group(1).strip() if h1_match else path.stem)
        normalized_title = normalized_name(effective_title)
        if normalized_title in titles:
            errors.append(
                f"{rel}: 중복 문서 제목입니다: {effective_title!r} "
                f"({titles[normalized_title].relative_to(root).as_posix()})"
            )
        else:
            titles[normalized_title] = path
        known_targets.add(normalized_title)
        known_targets.add(normalized_name(path.stem))

        if body.count("```") % 2:
            errors.append(f"{rel}: 코드 블록 구분자 수가 맞지 않습니다.")
        parsed[path] = (metadata, body, full_text)

    wiki_files = set(files)
    for path in sorted(link_root.rglob("*.md")):
        if path in wiki_files:
            continue
        metadata, body, _ = parse_document(path)
        h1_match = H1_RE.search(body)
        title = (metadata or {}).get("title", "").strip()
        if title or h1_match:
            known_targets.add(normalized_name(title or h1_match.group(1)))
        known_targets.add(normalized_name(path.stem))

    for path, (_, body, full_text) in parsed.items():
        rel = path.relative_to(root).as_posix()
        body_offset = full_text.find(body)
        for match in WIKILINK_RE.finditer(body):
            target = normalized_name(match.group(1))
            if target and target not in known_targets:
                errors.append(
                    f"{rel}:{line_number(body, match.start())}: "
                    f"대상을 찾을 수 없는 위키 링크: [[{match.group(1)}]]"
                )
        for message, pattern in STYLE_PATTERNS:
            for match in pattern.finditer(body):
                excerpt = re.sub(r"\s+", " ", match.group(0)).strip()
                warnings.append(
                    f"{rel}:{line_number(full_text, body_offset + match.start())}: {message}: {excerpt}"
                )
        for match in HEADING_RE.finditer(body):
            heading = re.sub(r"^\d+\.\s+", "", match.group(1)).strip()
            if HEADING_STYLE_PATTERN.fullmatch(heading):
                warnings.append(
                    f"{rel}:{line_number(full_text, body_offset + match.start())}: "
                    f"설명 대상을 알기 어려운 중간 제목: {match.group(1).strip()}"
                )

    return errors, warnings, len(files)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="프로젝트 Wiki의 Markdown 구조, 내부 링크와 문체 후보를 검사합니다."
    )
    parser.add_argument("wiki_root", type=Path)
    parser.add_argument(
        "--link-root",
        type=Path,
        help="위키 링크 대상을 검색할 루트. 생략하면 Wiki 디렉터리의 상위 폴더를 사용합니다.",
    )
    parser.add_argument(
        "--require-frontmatter",
        action="store_true",
        help="새 위키용 기본 frontmatter 필드를 필수로 검사합니다.",
    )
    args = parser.parse_args()

    root = args.wiki_root.expanduser().resolve()
    if not root.is_dir():
        parser.error(f"Wiki 디렉터리를 찾을 수 없습니다: {root}")
    link_root = (args.link_root or root.parent).expanduser().resolve()
    if not link_root.is_dir():
        parser.error(f"링크 검색 디렉터리를 찾을 수 없습니다: {link_root}")

    errors, warnings, count = validate(root, link_root, args.require_frontmatter)
    for error in errors:
        print(f"ERROR: {error}")
    for warning in warnings:
        print(f"WARN: {warning}")
    print(f"checked {count} files: {len(errors)} errors, {len(warnings)} style warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
