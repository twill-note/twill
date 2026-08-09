"""파일시스템 변경 알림용 WebSocket: 프론트가 구독해 트리/태그를 자동 새로고침."""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import watcher

router = APIRouter(prefix="/api/events", tags=["events"])


@router.websocket("/ws")
async def events_ws(ws: WebSocket):
    await ws.accept()
    q = watcher.subscribe()

    async def sender():
        while True:
            await ws.send_json(await q.get())

    task = asyncio.create_task(sender())
    try:
        while True:
            await ws.receive_text()  # 클라이언트 발신은 무시, 연결 종료 감지용
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        task.cancel()
        watcher.unsubscribe(q)
