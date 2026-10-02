import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from app.plugins.codex_assistant.app_server import AppServerClient
from app.plugins.codex_assistant.codex_engine import _SKILLBOOK_DYNAMIC_TOOLS, engine


class _FakeStdin:
    def __init__(self):
        self.payloads: list[dict] = []

    def write(self, data: bytes):
        self.payloads.append(json.loads(data.decode()))

    async def drain(self):
        return None


class _FakeProcess:
    def __init__(self):
        self.stdin = _FakeStdin()


class DynamicSkillBookToolTests(unittest.TestCase):
    def test_tool_specs_expose_catalog_before_content(self):
        self.assertEqual(
            [tool["name"] for tool in _SKILLBOOK_DYNAMIC_TOOLS],
            ["list_skillbook", "read_skillbook", "search_memories"],
        )
        self.assertIn("먼저", _SKILLBOOK_DYNAMIC_TOOLS[0]["description"])

    def test_app_server_dispatches_dynamic_tool_call(self):
        async def run():
            client = AppServerClient()
            process = _FakeProcess()
            client._proc = process  # type: ignore[assignment]
            client.register_dynamic_tool("list_skillbook", lambda args: {"query": args["query"]})

            await client._respond_to_server_request(
                7,
                "item/tool/call",
                {"tool": "list_skillbook", "arguments": {"query": "노트"}},
            )
            return process.stdin.payloads[0]

        payload = asyncio.run(run())
        self.assertEqual(payload["id"], 7)
        self.assertTrue(payload["result"]["success"])
        self.assertIn('"query": "노트"', payload["result"]["contentItems"][0]["text"])

    def test_blocking_tool_does_not_block_event_loop(self):
        import threading
        async def exercise():
            client = AppServerClient()
            client._proc = _FakeProcess()
            entered, release = threading.Event(), threading.Event()
            def slow_tool(arguments):
                entered.set()
                release.wait(2)
                return "ok"
            client.register_dynamic_tool("slow", slow_tool)
            task = asyncio.create_task(client._respond_to_server_request(8, "item/tool/call", {"tool": "slow"}))
            try:
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(.001)
                self.assertTrue(entered.is_set())
                self.assertFalse(task.done(), "A blocking handler must run outside the event loop")
            finally:
                release.set()
                await task
        asyncio.run(exercise())

    def test_new_codex_thread_registers_dynamic_tools(self):
        async def run():
            with patch(
                "app.plugins.codex_assistant.codex_engine.app_server.request",
                new=AsyncMock(return_value={"thread": {"id": "thread-with-tools"}}),
            ) as request:
                thread_id = await engine.start_thread(
                    cwd="/tmp",
                    config={"approval": "never", "developer_instructions": "짧은 공통 지시"},
                )
                return thread_id, request.await_args

        thread_id, call = asyncio.run(run())
        self.assertEqual(thread_id, "thread-with-tools")
        self.assertEqual(call.args[0], "thread/start")
        self.assertEqual(
            [tool["name"] for tool in call.args[1]["dynamicTools"]],
            ["list_skillbook", "read_skillbook", "search_memories",
             "list_calendar_events", "create_calendar_event", "update_calendar_event", "delete_calendar_event",
             "list_todos", "create_todo", "complete_todo"],
        )
        self.assertEqual(call.args[1]["developerInstructions"], "짧은 공통 지시")


if __name__ == "__main__":
    unittest.main()
