"""notes 루트 파일시스템 감시: 외부(터미널/탐색기) 변경을 증분 색인하고 클라이언트에 알림."""

import asyncio
from pathlib import Path

from watchfiles import Change, awatch

from . import config, indexer

_subscribers: set[asyncio.Queue] = set()
_restart = asyncio.Event()  # 워크스페이스 전환 시 감시 대상 재설정
_loop: asyncio.AbstractEventLoop | None = None


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def request_restart() -> None:
    """워크스페이스 루트가 바뀌었을 때 호출 (sync 엔드포인트의 스레드에서도 안전)."""
    if _loop is not None:
        _loop.call_soon_threadsafe(_restart.set)


def _relevant(root: Path, raw: str) -> str | None:
    """트리에 보이는 항목이면 루트 기준 상대 경로, 아니면 None (assets/.trash/숨김 제외)."""
    try:
        rel = Path(raw).relative_to(root)
    except ValueError:
        return None
    if not rel.parts:
        return None
    if any(part.startswith(".") or part in config.EXCLUDED_DIRS for part in rel.parts):
        return None
    return str(rel)


def _apply_to_index(change: Change, rel: str, root: Path) -> None:
    abs_path = root / rel
    if change == Change.deleted:
        indexer.remove(rel)
    elif abs_path.is_file() and abs_path.suffix == ".md":
        indexer.index_file(rel)


def _broadcast(msg: dict) -> None:
    for q in list(_subscribers):
        q.put_nowait(msg)


async def watch_loop() -> None:
    global _loop
    _loop = asyncio.get_running_loop()
    while True:
        _restart.clear()
        root = config.notes_dir()
        stop = asyncio.Event()

        async def _stopper():
            await _restart.wait()
            stop.set()

        stopper = asyncio.create_task(_stopper())
        try:
            async for changes in awatch(root, stop_event=stop, debounce=800, step=80):
                if _restart.is_set():
                    break
                touched = []
                for change, raw in changes:
                    rel = _relevant(root, raw)
                    if rel is None:
                        continue
                    try:
                        _apply_to_index(change, rel, root)
                    except OSError:
                        pass
                    touched.append(rel)
                if touched:
                    _broadcast({"type": "fs-changed", "paths": touched[:50]})
        except asyncio.CancelledError:
            raise
        except Exception:
            # 감시 실패(루트 삭제 등) 시 잠시 후 재시도
            await asyncio.sleep(2)
        finally:
            stopper.cancel()
