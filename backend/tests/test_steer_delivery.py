import asyncio
import importlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.ai.orchestrator import Orchestrator, RunContext, RunRequest, _ActiveRun
from app.plugins.codex_assistant.app_server import AppServerError
from app.plugins.codex_assistant.codex_engine import CodexEngine
from app.routers import ai as ai_router

codex_engine_module = importlib.import_module("app.plugins.codex_assistant.codex_engine")


class SteerEngine:
    id = "steer-test"

    def __init__(self):
        self.last_images = None

    async def steer(self, *, thread_id, turn_id, guidance, client_message_id=None, images=None):
        self.last_images = images
        if guidance == "실패 지시":
            raise RuntimeError("turn/steer rejected")
        return "turn-2"


class SteerDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.engine = SteerEngine()
        self.orchestrator = Orchestrator()
        active = _ActiveRun(run_id="run-1", engine=self.engine)
        active.thread_id = "thread-1"
        active.turn_id = "turn-1"
        self.orchestrator._active[active.run_id] = active

    def test_orchestrator_reports_engine_steer_failure(self):
        delivered = asyncio.run(self.orchestrator.steer("run-1", "반영 지시"))
        with self.assertLogs("orchestrator", level="ERROR"):
            rejected = asyncio.run(self.orchestrator.steer("run-1", "실패 지시"))

        self.assertTrue(delivered)
        self.assertFalse(rejected)
        self.assertEqual("turn-2", self.orchestrator._active["run-1"].turn_id)

    def test_orchestrator_resolves_and_delivers_steer_images(self):
        with patch("app.ai.orchestrator._resolve_image_paths", return_value=["/tmp/steer-image.png"]):
            delivered = asyncio.run(
                self.orchestrator.steer("run-1", "이 이미지도 확인해줘", images=["/assets/image.png"])
            )

        self.assertTrue(delivered)
        self.assertEqual(["/tmp/steer-image.png"], self.engine.last_images)

    def test_steer_completion_does_not_start_another_turn(self):
        class ContinuingEngine:
            id = "continuing-test"
            display_name = "Continuing test"

            def __init__(self):
                self.inputs: list[str] = []
                self.steered = asyncio.Event()

            async def start_thread(self, *, cwd, config=None):
                return "thread-1"

            async def run_turn(self, *, thread_id, input_text, config=None):
                self.inputs.append(input_text)
                if len(self.inputs) == 1:
                    yield {"type": "_turn_id", "turn_id": "turn-1"}
                    await asyncio.wait_for(self.steered.wait(), timeout=1)
                    yield {"type": "delta", "text": "네", "itemId": "steer-reply"}
                    yield {"type": "turn_done"}
                    return
                yield {"type": "_turn_id", "turn_id": "turn-resumed"}
                yield {"type": "delta", "text": "원래 작업 계속", "itemId": "resumed-reply"}
                yield {"type": "turn_done"}

            async def steer(self, *, thread_id, turn_id, guidance, client_message_id=None):
                self.steered.set()
                return "turn-steered"

        engine = ContinuingEngine()

        async def exercise():
            orchestrator = Orchestrator()
            run_id = None
            events = []
            async for event in orchestrator.run(RunRequest(prompt="원래 작업", enable_learn=False)):
                events.append(event)
                if event.get("type") == "run_id":
                    run_id = event["run_id"]
                if event.get("type") == "turn_id" and event.get("turn_id") == "turn-1":
                    self.assertTrue(await orchestrator.steer(run_id, "'네'라고 답해"))
            return events

        with (
            patch("app.ai.orchestrator._read_workspace_settings", return_value={}),
            patch("app.ai.orchestrator._resolve_run_context", return_value=RunContext()),
            patch("app.ai.orchestrator._resolve_scope_cwd", return_value="/tmp"),
            patch("app.ai.orchestrator._assemble_developer_instructions", return_value=""),
            patch("app.ai.orchestrator.engine_registry.default", return_value=engine),
        ):
            events = asyncio.run(exercise())

        self.assertEqual("원래 작업", engine.inputs[0])
        self.assertEqual(1, len(engine.inputs))
        self.assertNotIn("원래 작업 계속", "".join(event.get("text", "") for event in events))

    def test_codex_adapter_uses_current_steer_protocol_and_returns_turn_id(self):
        request = AsyncMock(return_value={"turnId": "turn-2"})
        with patch(
            "app.plugins.codex_assistant.codex_engine.app_server.request",
            new=request,
        ):
            turn_id = asyncio.run(
                CodexEngine().steer(
                    thread_id="thread-1",
                    turn_id="turn-1",
                    guidance="지시",
                    client_message_id="steer-1",
                    images=["/tmp/steer-image.png"],
                )
            )

        self.assertEqual("turn-2", turn_id)
        request.assert_awaited_once_with(
            "turn/steer",
            {
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
                "input": [{
                    "type": "text",
                    "text": codex_engine_module._compose_continuing_steer_input("지시"),
                }, {
                    "type": "localImage",
                    "path": "/tmp/steer-image.png",
                }],
                "clientUserMessageId": "steer-1",
            },
            timeout=5,
        )

    def test_steer_input_prioritizes_latest_pause_and_completion(self):
        input_text = codex_engine_module._compose_continuing_steer_input("'네'라고 답해")

        self.assertIn("중단·일시 중지·취소·범위 변경 요청을 즉시 우선하세요", input_text)
        self.assertIn("사용자 답변을 기다려야 할 때는 턴을 종료하세요", input_text)
        self.assertTrue(input_text.endswith("[사용자의 추가 지시]\n'네'라고 답해"))

    def test_turn_becomes_steerable_only_after_turn_started_notification(self):
        listener = None

        def subscribe(callback):
            nonlocal listener
            listener = callback
            return lambda: None

        async def request(method, _params, timeout):
            if method == "turn/start":
                asyncio.get_running_loop().call_soon(
                    listener,
                    "turn/started",
                    {"threadId": "thread-1", "turn": {"id": "turn-ready"}},
                )
                return {"turn": {"id": "turn-too-early"}}
            raise AssertionError(f"unexpected request: {method}")

        async def first_event():
            stream = CodexEngine().run_turn(thread_id="thread-1", input_text="test")
            try:
                return await anext(stream)
            finally:
                await stream.aclose()

        with (
            patch.object(codex_engine_module.app_server, "ensure_started", new=AsyncMock()),
            patch.object(codex_engine_module.app_server, "subscribe", new=subscribe),
            patch.object(codex_engine_module.app_server, "request", new=request),
        ):
            event = asyncio.run(first_event())

        self.assertEqual({"type": "_turn_id", "turn_id": "turn-ready"}, event)

    def test_superseded_turn_completion_does_not_end_a_steered_turn(self):
        listener = None

        def subscribe(callback):
            nonlocal listener
            listener = callback
            return lambda: None

        async def request(method, _params, timeout):
            if method == "turn/start":
                asyncio.get_running_loop().call_soon(
                    listener,
                    "turn/started",
                    {"threadId": "thread-1", "turn": {"id": "turn-1"}},
                )
                return {}
            if method == "turn/steer":
                return {"turnId": "turn-2"}
            raise AssertionError(f"unexpected request: {method}")

        async def exercise():
            engine = CodexEngine()
            stream = engine.run_turn(thread_id="thread-1", input_text="원래 작업")
            try:
                started = await anext(stream)
                started_ui = await anext(stream)
                await engine.steer(thread_id="thread-1", turn_id="turn-1", guidance="추가 작업")
                # Codex가 steer 전 턴의 종료 알림을 보낸 뒤에도 새 활성 턴은 이어져야 한다.
                listener("turn/completed", {"threadId": "thread-1", "turn": {"id": "turn-1", "status": "completed"}})
                listener("item/agentMessage/delta", {"threadId": "thread-1", "delta": "계속 작업", "itemId": "message-2"})
                continued = await anext(stream)
                listener("turn/completed", {"threadId": "thread-1", "turn": {"id": "turn-2", "status": "completed"}})
                completed = await anext(stream)
                return started, started_ui, continued, completed
            finally:
                await stream.aclose()

        with (
            patch.object(codex_engine_module.app_server, "ensure_started", new=AsyncMock()),
            patch.object(codex_engine_module.app_server, "subscribe", new=subscribe),
            patch.object(codex_engine_module.app_server, "request", new=request),
        ):
            started, started_ui, continued, completed = asyncio.run(exercise())

        self.assertEqual({"type": "_turn_id", "turn_id": "turn-1"}, started)
        self.assertEqual({"type": "turn_start"}, started_ui)
        self.assertEqual({"type": "delta", "text": "계속 작업", "itemId": "message-2"}, continued)
        self.assertEqual({"type": "turn_done"}, completed)

    def test_codex_adapter_does_not_hide_steer_errors(self):
        with patch(
            "app.plugins.codex_assistant.codex_engine.app_server.request",
            new=AsyncMock(side_effect=AppServerError("turn/steer rejected")),
        ):
            with self.assertRaises(AppServerError):
                asyncio.run(CodexEngine().steer(thread_id="thread-1", turn_id="turn-1", guidance="지시"))

    def test_successful_websocket_steer_is_persisted_with_its_client_message_id(self):
        class SteeringWebSocket:
            def __init__(self):
                self.messages = [
                    json.dumps({"session_id": "session-1", "prompt": "원래 요청"}),
                    json.dumps({
                        "type": "steer",
                        "guidance": "추가 지시",
                        "client_message_id": "steer-1",
                        "images": ["/assets/steer.png"],
                        "image_attachments": [{"url": "/assets/steer.png", "name": "화면.png"}],
                    }),
                ]
                self.sent: list[dict] = []

            async def accept(self):
                return None

            async def receive_text(self):
                if self.messages:
                    return self.messages.pop(0)
                await asyncio.Event().wait()
                raise AssertionError("unreachable")

            async def send_json(self, event):
                self.sent.append(event)

            async def close(self):
                return None

        steered = asyncio.Event()

        async def fake_run(_request):
            yield {"type": "run_id", "run_id": "run-1"}
            await asyncio.wait_for(steered.wait(), timeout=1)
            yield {"type": "session_updated", "session_id": "session-1"}

        async def fake_steer(run_id, guidance, *, client_message_id=None, images=None):
            self.assertEqual("run-1", run_id)
            self.assertEqual("추가 지시", guidance)
            self.assertEqual("steer-1", client_message_id)
            self.assertEqual(["/assets/steer.png"], images)
            steered.set()
            return True

        ws = SteeringWebSocket()
        with tempfile.TemporaryDirectory() as temporary_directory:
            assets = Path(temporary_directory)
            (assets / "steer.png").write_bytes(b"image")
            with (
                patch.object(ai_router.orchestrator, "run", new=fake_run),
                patch.object(ai_router.orchestrator, "steer", new=fake_steer),
                patch.object(ai_router.orchestrator, "active_turn_id", return_value="turn-2"),
                patch("app.ai.orchestrator.config.assets_dir", return_value=assets),
                patch.object(ai_router.ai_sessions, "append_message") as append_message,
            ):
                asyncio.run(ai_router.run_ws(ws))

        append_message.assert_called_once_with(
            "session-1",
            "user",
            "추가 지시",
            images=[{"url": "/assets/steer.png", "name": "화면.png", "alt": "화면.png"}],
        )
        self.assertIn(
            {"type": "steer_ack", "ok": True, "client_message_id": "steer-1", "turn_id": "turn-2"},
            ws.sent,
        )

if __name__ == "__main__":
    unittest.main()
