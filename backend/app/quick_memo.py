"""Atomic, idempotent quick-memo writes for daily notes.

The quick-memo window may be opened more than once and a save response can be
lost after the file has already been replaced.  This module therefore treats a
caller-provided memo id as the idempotency key and serializes every write to a
single daily note both within this process and across processes.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal

from .config import notes_dir


QuickMemoStatus = Literal[
    "SAVED",
    "ALREADY_SAVED",
    "BUSY",
    "CONFLICT",
    "WRITE_FAILED",
    "INVALID_INPUT",
]

DAILY_DIR = "daily"
QUICK_MEMO_HEADING = "## 빠른 메모"
MAX_MEMO_LENGTH = 10_000
LOCK_TIMEOUT_SECONDS = 3.0
MAX_MERGE_ATTEMPTS = 3

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEMO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_QUICK_MEMO_HEADING_RE = re.compile(r"(?m)^## 빠른 메모[ \t]*\r?$")
_SECTION_BOUNDARY_RE = re.compile(r"(?m)^[ ]{0,3}#{1,2}(?:[ \t]+|$)")
_MARKDOWN_PUNCTUATION_RE = re.compile(r"([\\`*_{}\[\]()<>#+\-.!|])")


@dataclass(frozen=True)
class QuickMemoSaveResult:
    """The stable result contract consumed by the quick-memo UI."""

    status: QuickMemoStatus
    path: str | None
    date: str | None
    captured_at: str | None
    created: bool = False

    @property
    def success(self) -> bool:
        return self.status in {"SAVED", "ALREADY_SAVED"}

    def as_dict(self) -> dict[str, str | bool | None]:
        return {
            "status": self.status,
            "path": self.path,
            "date": self.date,
            "captured_at": self.captured_at,
            "created": self.created,
            "success": self.success,
        }


@dataclass(frozen=True)
class _FileSnapshot:
    exists: bool
    digest: str | None = None
    stat_key: tuple[int, int, int, int] | None = None
    mode: int | None = None


class _FifoMutex:
    """A small fair lock for threads in this process.

    A file lock does the cross-process coordination.  The ticket queue keeps
    local concurrent save requests in arrival order instead of letting a newly
    arriving request repeatedly overtake one that has just missed the lock.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._next_ticket = 0
        self._serving_ticket = 0
        self._cancelled: set[int] = set()

    def acquire(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            ticket = self._next_ticket
            self._next_ticket += 1
            while ticket != self._serving_ticket:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._cancelled.add(ticket)
                    self._skip_cancelled_locked()
                    self._condition.notify_all()
                    return False
                self._condition.wait(remaining)
            return True

    def release(self) -> None:
        with self._condition:
            self._serving_ticket += 1
            self._skip_cancelled_locked()
            self._condition.notify_all()

    def _skip_cancelled_locked(self) -> None:
        while self._serving_ticket in self._cancelled:
            self._cancelled.remove(self._serving_ticket)
            self._serving_ticket += 1


_mutexes_guard = threading.Lock()
_mutexes: dict[Path, _FifoMutex] = {}


def _mutex_for(path: Path) -> _FifoMutex:
    with _mutexes_guard:
        return _mutexes.setdefault(path.resolve(), _FifoMutex())


def _daily_template(date: str) -> str:
    return (
        "---\n"
        f"title: '{date}'\n"
        f"date: '{date}'\n"
        "tags: [daily]\n"
        "---\n\n"
        "## 오늘 할 일\n\n"
        "## 메모\n\n"
        f"{QUICK_MEMO_HEADING}\n"
    )


def _parse_input(
    content: object,
    memo_id: object,
    date: object,
    captured_at: object,
) -> tuple[str, str, str, str] | None:
    """Validate an untrusted save payload without changing the user's text."""
    if not all(isinstance(value, str) for value in (content, memo_id, date, captured_at)):
        return None
    if not content.strip() or len(content) > MAX_MEMO_LENGTH:
        return None
    if not _MEMO_ID_RE.fullmatch(memo_id):
        return None
    if not _DATE_RE.fullmatch(date):
        return None
    try:
        parsed_date = dt.date.fromisoformat(date)
        # JavaScript's ISO string uses Z; fromisoformat accepts +00:00 instead.
        parsed_at = dt.datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed_at.tzinfo is None or parsed_at.utcoffset() is None:
        return None
    # The client selects its timezone and date once at the moment Save is
    # requested.  Reject split-brain requests that could put a midnight memo in
    # a different daily note than the displayed time.
    if parsed_date.isoformat() != parsed_at.date().isoformat():
        return None
    return content, memo_id, parsed_date.isoformat(), parsed_at.strftime("%H:%M")


def _escape_markdown(text: str) -> str:
    """Keep user text literal inside a quote/callout block."""
    # 엔티티도 Markdown/HTML 렌더링에 의해 원문과 달라질 수 있으므로 먼저 보존한다.
    return _MARKDOWN_PUNCTUATION_RE.sub(r"\\\1", text.replace("&", "&amp;"))


def _record_for(time_text: str, content: str, memo_id: str, newline: str) -> str:
    # 외부 클라이언트의 CRLF도 입력 줄바꿈 하나로 유지한다.
    quoted_lines = ["> " + _escape_markdown(line) for line in content.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return newline.join(
        [f"> [!📝] {time_text}", *quoted_lines, f"<!-- quick-memo:id={memo_id} -->"]
    ) + newline


def _already_saved(raw: str, memo_id: str) -> bool:
    marker = re.compile(r"<!--\s*quick-memo:id=" + re.escape(memo_id) + r"\s*-->")
    return marker.search(raw) is not None


def _line_ending(raw: str) -> str:
    return "\r\n" if "\r\n" in raw else "\n"


def _append_record(raw: str, record: str) -> str:
    """Append to the exact quick-memo section, preserving all other content."""
    newline = _line_ending(raw)
    section = _QUICK_MEMO_HEADING_RE.search(raw)
    if section is None:
        base = raw
        if base and not base.endswith(("\n", "\r")):
            base += newline
        if base and not base.endswith(newline * 2):
            base += newline
        return f"{base}{QUICK_MEMO_HEADING}{newline}{newline}{record}"

    body_start = section.end()
    if body_start < len(raw) and raw[body_start] == "\n":
        body_start += 1
    boundary = _SECTION_BOUNDARY_RE.search(raw, body_start)
    insert_at = boundary.start() if boundary else len(raw)
    before, after = raw[:insert_at], raw[insert_at:]
    if not before.endswith(("\n", "\r")):
        before += newline
    if not before.endswith(newline * 2):
        before += newline
    if after:
        return f"{before}{record}{newline}{after}"
    return f"{before}{record}"


def _read_snapshot(path: Path) -> tuple[str, _FileSnapshot]:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return "", _FileSnapshot(exists=False)
    stat = path.stat()
    return (
        data.decode("utf-8"),
        _FileSnapshot(
            exists=True,
            digest=hashlib.sha256(data).hexdigest(),
            stat_key=(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns),
            mode=stat.st_mode & 0o777,
        ),
    )


def _current_snapshot(path: Path) -> _FileSnapshot:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return _FileSnapshot(exists=False)
    stat = path.stat()
    return _FileSnapshot(
        exists=True,
        digest=hashlib.sha256(data).hexdigest(),
        stat_key=(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns),
        mode=stat.st_mode & 0o777,
    )


def _write_temp(path: Path, contents: str, source: _FileSnapshot) -> Path:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        if source.mode is not None:
            os.fchmod(fd, source.mode)
        with os.fdopen(fd, "wb") as tmp:
            fd = -1
            tmp.write(contents.encode("utf-8"))
            tmp.flush()
            os.fsync(tmp.fileno())
    except BaseException:
        if fd >= 0:
            os.close(fd)
        try:
            Path(tmp_name).unlink()
        except FileNotFoundError:
            pass
        raise
    return Path(tmp_name)


def _fsync_directory(path: Path) -> None:
    """Persist the rename metadata where the platform permits directory fsync."""
    try:
        fd = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        # The replacement itself succeeded.  Some platforms do not permit a
        # directory fsync, so do not turn that successful idempotent save into
        # a false client-side failure.
        pass
    finally:
        os.close(fd)


@contextmanager
def _daily_file_lock(path: Path, timeout: float) -> Iterator[bool]:
    """Acquire the in-process FIFO mutex and the cross-process lock file."""
    mutex = _mutex_for(path)
    started = time.monotonic()
    if not mutex.acquire(timeout):
        yield False
        return

    fd: int | None = None
    lock_path = path.with_name(path.name + ".lock")
    try:
        while True:
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, f"{os.getpid()}\n".encode("ascii"))
                break
            except FileExistsError:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    yield False
                    return
                time.sleep(min(0.05, remaining))
        yield True
    finally:
        if fd is not None:
            try:
                os.close(fd)
            finally:
                try:
                    lock_path.unlink()
                except FileNotFoundError:
                    pass
        mutex.release()


def save_quick_memo(
    *,
    content: object,
    memo_id: object,
    date: object,
    captured_at: object,
) -> QuickMemoSaveResult:
    """Store one quick memo in ``daily/YYYY-MM-DD.md``.

    The caller must supply the id and the timezone-aware captured timestamp it
    selected at Save time.  Expected conflicts are returned as result codes so
    the UI can retain the unsaved text and offer a retry; this function never
    overwrites a newer file snapshot with an older one.
    """
    parsed = _parse_input(content, memo_id, date, captured_at)
    if parsed is None:
        return QuickMemoSaveResult("INVALID_INPUT", None, None, None)
    text, valid_id, valid_date, display_time = parsed
    relative_path = f"{DAILY_DIR}/{valid_date}.md"
    path = notes_dir() / relative_path

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return QuickMemoSaveResult("WRITE_FAILED", relative_path, valid_date, str(captured_at))

    try:
        with _daily_file_lock(path, LOCK_TIMEOUT_SECONDS) as locked:
            if not locked:
                return QuickMemoSaveResult("BUSY", relative_path, valid_date, str(captured_at))

            for _attempt in range(MAX_MERGE_ATTEMPTS):
                try:
                    raw, source = _read_snapshot(path)
                except (OSError, UnicodeError):
                    return QuickMemoSaveResult("WRITE_FAILED", relative_path, valid_date, str(captured_at))

                if _already_saved(raw, valid_id):
                    return QuickMemoSaveResult("ALREADY_SAVED", relative_path, valid_date, str(captured_at))

                original_exists = source.exists
                original = raw if source.exists else _daily_template(valid_date)
                newline = _line_ending(original)
                updated = _append_record(original, _record_for(display_time, text, valid_id, newline))

                temporary: Path | None = None
                try:
                    temporary = _write_temp(path, updated, source)
                    # A non-cooperating editor may have changed the daily note
                    # while the temporary file was being flushed.  Re-read and
                    # merge again rather than replacing that newer content.
                    if _current_snapshot(path) != source:
                        continue
                    os.replace(temporary, path)
                    temporary = None
                    _fsync_directory(path)
                    return QuickMemoSaveResult(
                        "SAVED", relative_path, valid_date, str(captured_at), created=not original_exists
                    )
                except (OSError, UnicodeError):
                    return QuickMemoSaveResult("WRITE_FAILED", relative_path, valid_date, str(captured_at))
                finally:
                    if temporary is not None:
                        try:
                            temporary.unlink()
                        except FileNotFoundError:
                            pass
            return QuickMemoSaveResult("CONFLICT", relative_path, valid_date, str(captured_at))
    except OSError:
        return QuickMemoSaveResult("WRITE_FAILED", relative_path, valid_date, str(captured_at))
