"""벼리의 학습 메모리를 필요할 때만 검색하는 동적 도구.

워크스페이스 루트의 MEMORIES.md는 사람이 직접 검토할 수 있는 Markdown 원본으로 유지한다.
다만 전체 본문을 모든 실행 프롬프트에 합치지 않고, 모델이 현재 요청에 필요한 사실을
질의했을 때 관련 기록 몇 개만 반환한다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import frontmatter

from . import config


DEFAULT_MEMORIES = "MEMORIES.md"
DEFAULT_LIMIT = 3
MAX_LIMIT = 5
MAX_QUERY_CHARS = 200
MAX_ENTRY_CHARS = 800
MAX_RESULT_CHARS = 1_800
_TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣_./:-]+")
_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


class MemorySearchError(ValueError):
    pass


@dataclass(frozen=True)
class _MemorySource:
    kind: str
    ref: str
    label: str
    section_id: str | None = None
    scope_id: str | None = None


def _memory_sources(
    *,
    source: str,
    section_id: str | None,
    scope_id: str | None,
) -> list[_MemorySource]:
    # section_id/scope_id는 기존 실행과의 호출 호환을 위해 받지만 메모리 원본은 하나다.
    if source not in {"all", "global"}:
        return []
    return [_MemorySource(kind="global", ref=DEFAULT_MEMORIES, label="워크스페이스 메모리")]


def _memory_chunks(path: Path) -> list[tuple[str, str]]:
    try:
        body = frontmatter.load(path).content
    except Exception:  # noqa: BLE001
        body = path.read_text(encoding="utf-8", errors="replace")
    matches = list(_SECTION_RE.finditer(body))
    if not matches:
        cleaned = body.strip()
        return [("학습된 사실", cleaned)] if cleaned else []

    chunks: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        content = body[match.end():end].strip()
        if content:
            chunks.append((match.group(1).strip(), content))
    return chunks


def _query_tokens(query: str) -> list[str]:
    tokens: list[str] = []
    for token in _TOKEN_RE.findall(query.casefold()):
        if len(token) >= 2 and token not in tokens:
            tokens.append(token)
    return tokens


def _score_chunk(
    query: str,
    tokens: list[str],
    heading: str,
    content: str,
    source: _MemorySource,
    section_id: str | None,
    scope_id: str | None,
) -> int:
    heading_folded = heading.casefold()
    content_folded = content.casefold()
    score = 0
    if query in heading_folded:
        score += 50
    if query in content_folded:
        score += 40
    for token in tokens:
        if token in heading_folded:
            score += 12
        occurrences = content_folded.count(token)
        score += min(occurrences, 5) * 4
    if section_id and source.section_id == section_id:
        score += 8
    if scope_id and source.scope_id == scope_id:
        score += 8
    return score


def search_memories_tool(arguments: Any) -> str:
    """Codex dynamicTools 계약용 JSON 문자열 응답."""
    if not isinstance(arguments, dict):
        raise MemorySearchError("검색 인자가 필요합니다.")
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise MemorySearchError("query가 필요합니다.")
    if len(query) > MAX_QUERY_CHARS:
        raise MemorySearchError(f"query는 {MAX_QUERY_CHARS}자를 넘을 수 없습니다.")

    source = str(arguments.get("source") or "all")
    if source not in {"all", "global"}:
        raise MemorySearchError("source는 all 또는 global이어야 합니다.")
    try:
        limit = int(arguments.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError) as exc:
        raise MemorySearchError("limit은 숫자여야 합니다.") from exc
    limit = max(1, min(limit, MAX_LIMIT))
    section_id = str(arguments.get("section_id") or "").strip() or None
    scope_id = str(arguments.get("scope_id") or "").strip() or None
    query_folded = query.casefold()
    tokens = _query_tokens(query)

    ranked: list[tuple[int, int, _MemorySource, str, str]] = []
    root = config.notes_dir().resolve()
    for source_index, memory_source in enumerate(
        _memory_sources(source=source, section_id=section_id, scope_id=scope_id)
    ):
        path = root / memory_source.ref
        if not path.is_file() or path.is_symlink():
            continue
        try:
            chunks = _memory_chunks(path)
        except OSError:
            continue
        for heading, content in chunks:
            score = _score_chunk(
                query_folded,
                tokens,
                heading,
                content,
                memory_source,
                section_id,
                scope_id,
            )
            if score > 0:
                ranked.append((score, -source_index, memory_source, heading, content))

    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    results: list[dict[str, Any]] = []
    used_chars = 0
    for score, _source_order, memory_source, heading, content in ranked:
        if len(results) >= limit or used_chars >= MAX_RESULT_CHARS:
            break
        remaining = MAX_RESULT_CHARS - used_chars
        excerpt = content[: min(MAX_ENTRY_CHARS, remaining)].rstrip()
        if len(excerpt) < len(content):
            excerpt += "\n…"
        used_chars += len(excerpt)
        results.append(
            {
                "source": memory_source.kind,
                "ref": memory_source.ref,
                "section_id": memory_source.section_id,
                "scope_id": memory_source.scope_id,
                "heading": heading,
                "content": excerpt,
            }
        )

    return json.dumps(
        {
            "query": query,
            "results": results,
            "usage": (
                "검색 결과는 학습 메모리 원본의 관련 구간만 반환합니다. "
                "결과가 없으면 현재 메모리에 해당 사실이 없는 것으로 취급하세요."
            ),
        },
        ensure_ascii=False,
    )
