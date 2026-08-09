import re
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from ..config import assets_dir

router = APIRouter(prefix="/api/assets", tags=["assets"])

MAX_SIZE = 20 * 1024 * 1024  # 20MB


@router.post("")
async def upload_asset(file: UploadFile):
    data = await file.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(status_code=413, detail="파일이 너무 큽니다 (최대 20MB)")

    original = Path(file.filename or "image")
    stem = re.sub(r"[^\w가-힣.-]+", "_", original.stem)[:50] or "image"
    suffix = original.suffix.lower()[:10] or ".png"
    name = f"{stem}-{uuid.uuid4().hex[:8]}{suffix}"

    assets_dir().mkdir(parents=True, exist_ok=True)
    (assets_dir() / name).write_bytes(data)
    return {"url": f"/assets/{name}"}
