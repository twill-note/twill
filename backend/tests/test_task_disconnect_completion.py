import asyncio
import json
import unittest

from fastapi import WebSocketDisconnect

from app.routers import ai as ai_router


class DisconnectingWebSocket:
    """첫 실행 요청 뒤 브라우저가 HMR 새로고침으로 끊긴 상황을 재현한다."""

    def __init__(self, request: dict):
        self.messages = [json.dumps(request)]
        self.accepted = False
        self.closed = False

    async def accept(self):
        self.accepted = True

    async def receive_text(self):
        if self.messages:
            return self.messages.pop(0)
        raise WebSocketDisconnect(code=1001)

    async def send_json(self, _event):
        # 이벤트 송신 중 다른 코루틴(클라이언트 감시)이 disconnect를 처리할 기회를 준다.
        await asyncio.sleep(0)

    async def close(self):
        self.closed = True


class TaskDisconnectCompletionTests(unittest.TestCase):
    def test_task_is_drained_after_client_disconnect(self):
        completed: list[bool] = []
        interrupts: list[str] = []

        async def fake_run(_request):
            yield {"type": "run_id", "run_id": "run-1"}
            await asyncio.sleep(0.01)
            completed.append(True)
            yield {"type": "session_updated", "session_id": "task-session"}

        async def fake_interrupt(run_id):
            interrupts.append(run_id)
            return True

        old_run = ai_router.orchestrator.run
        old_interrupt = ai_router.orchestrator.interrupt
        ai_router.orchestrator.run = fake_run
        ai_router.orchestrator.interrupt = fake_interrupt
        try:
            ws = DisconnectingWebSocket({"task_path": "tasks/example.md", "session_id": "task-session"})
            asyncio.run(ai_router.run_ws(ws))
        finally:
            ai_router.orchestrator.run = old_run
            ai_router.orchestrator.interrupt = old_interrupt

        self.assertTrue(ws.accepted)
        self.assertTrue(ws.closed)
        self.assertEqual([True], completed)
        self.assertEqual([], interrupts)

    def test_session_chat_is_drained_after_client_disconnect(self):
        completed: list[bool] = []
        interrupts: list[str] = []

        async def fake_run(_request):
            yield {"type": "run_id", "run_id": "chat-run-1"}
            await asyncio.sleep(0.01)
            completed.append(True)
            yield {"type": "session_updated", "session_id": "chat-session"}

        async def fake_interrupt(run_id):
            interrupts.append(run_id)
            return True

        old_run = ai_router.orchestrator.run
        old_interrupt = ai_router.orchestrator.interrupt
        ai_router.orchestrator.run = fake_run
        ai_router.orchestrator.interrupt = fake_interrupt
        try:
            ws = DisconnectingWebSocket({"prompt": "후속 수정 요청", "session_id": "chat-session"})
            asyncio.run(ai_router.run_ws(ws))
        finally:
            ai_router.orchestrator.run = old_run
            ai_router.orchestrator.interrupt = old_interrupt

        self.assertTrue(ws.accepted)
        self.assertTrue(ws.closed)
        self.assertEqual([True], completed)
        self.assertEqual([], interrupts)


if __name__ == "__main__":
    unittest.main()
