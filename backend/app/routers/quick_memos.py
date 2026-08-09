"""HTTP endpoint for the standalone quick-memo window."""

from pydantic import BaseModel
from fastapi import APIRouter

from .. import indexer
from ..quick_memo import save_quick_memo

router = APIRouter(prefix="/api/quick-memos", tags=["quick-memos"])


class QuickMemoSaveRequest(BaseModel):
    content: str | None = None
    id: str | None = None
    date: str | None = None
    captured_at: str | None = None


@router.post("")
def create_quick_memo(req: QuickMemoSaveRequest):
    """Append an idempotent record to the client-selected daily note."""
    result = save_quick_memo(
        content=req.content,
        memo_id=req.id,
        date=req.date,
        captured_at=req.captured_at,
    )
    if result.success and result.path:
        # The watcher will also observe the atomic replacement, but updating
        # immediately lets the main note app show the new memo without delay.
        try:
            indexer.index_file(result.path)
        except Exception:  # noqa: BLE001
            pass
    return result.as_dict()
