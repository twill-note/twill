import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.ai import sessions
from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import (
    EXPLICIT_MEMORY_EXTRACT_PROMPT,
    Orchestrator,
    RunRequest,
    _ActiveRun,
    _explicit_memory_extract_prompt,
    _is_explicit_memory_request,
    _resolve_run_context,
)
from app.routers import ai as ai_router

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"generated-image-payload"


class ImmediateEngine:
    id = "task-session-test"
    display_name = "Task Session Test"

    async def start_thread(self, *, cwd, config=None):
        return "thread-1"

    async def resume_thread(self, *, thread_id, cwd, config=None):
        return thread_id

    async def run_turn(self, *, thread_id, input_text, config=None):
        yield {"type": "message_end", "text": "태스크를 완료했습니다."}

    async def interrupt(self, *, thread_id, turn_id=None):
        return None

    async def steer(self, *, thread_id, turn_id, guidance):
        return None


class ManyToolEventsEngine(ImmediateEngine):
    async def run_turn(self, *, thread_id, input_text, config=None):
        for _ in range(51):
            yield {"type": "status", "kind": "tool_start", "text": "도구 실행"}
        yield {"type": "message_end", "text": "도구를 많이 사용해도 완료합니다."}


class MultiMessageEngine(ImmediateEngine):
    async def run_turn(self, *, thread_id, input_text, config=None):
        yield {"type": "message_start", "itemId": "answer-1"}
        yield {"type": "message_end", "itemId": "answer-1", "text": "첫 번째 진행 답변"}
        yield {"type": "message_start", "itemId": "answer-2"}
        yield {"type": "message_end", "itemId": "answer-2", "text": "두 번째 완료 답변"}


class TaskSessionPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        tasks = self.root / "tasks"
        tasks.mkdir()
        self.task_path = "tasks/태스크 실행 상태 보존.md"
        (self.root / self.task_path).write_text(
            "---\ntitle: 태스크 실행 상태 보존\ntype: test\nstatus: todo\n---\n\n세션 실행 상태를 검증한다.\n",
            encoding="utf-8",
        )
        self.notes_dir = patch("app.ai.orchestrator.config.notes_dir", return_value=self.root)
        self.notes_dir.start()
        self.assets_dir = patch("app.ai.orchestrator.config.assets_dir", return_value=self.root / "assets")
        self.assets_dir.start()
        self.sessions_notes_dir = patch("app.ai.sessions.config.notes_dir", return_value=self.root)
        self.sessions_notes_dir.start()
        self.engine = ImmediateEngine()
        self.default_engine = patch.object(engine_registry, "default", return_value=self.engine)
        self.default_engine_mock = self.default_engine.start()

    def tearDown(self):
        self.default_engine.stop()
        self.sessions_notes_dir.stop()
        self.assets_dir.stop()
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_task_completion_persists_run_summary_without_generated_user_message(self):
        session = sessions.create_session(kind="task", title="태스크 실행 상태 보존", task_path=self.task_path)

        async def collect():
            return [event async for event in Orchestrator().run(RunRequest(session_id=session["id"], task_path=self.task_path))]

        with patch("app.ai.orchestrator._run_background_json", new_callable=AsyncMock) as background:
            events = asyncio.run(collect())
        background.assert_not_awaited()
        saved = sessions.get_session(session["id"])
        self.assertIn("태스크를 완료했습니다.", (self.root / self.task_path).read_text(encoding="utf-8"))

        self.assertTrue(any(event.get("type") == "session_updated" for event in events))
        self.assertEqual([], [message for message in saved["messages"] if message["role"] == "user"])
        self.assertEqual("completed", saved["last_run"]["status"])
        self.assertEqual("verify", saved["last_run"]["task_status"])
        self.assertTrue((self.root / saved["last_run"]["run_log_path"]).is_file())

    def test_chat_assistant_message_boundaries_survive_session_reload(self):
        session = sessions.create_session(kind="chat", title="말풍선 경계 보존")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="두 단계로 답해줘", enable_learn=False)
                )
            ]

        with patch.object(engine_registry, "default", return_value=MultiMessageEngine()):
            asyncio.run(collect())

        saved = sessions.get_session(session["id"])
        self.assertEqual(
            [
                ("user", "두 단계로 답해줘"),
                ("assistant", "첫 번째 진행 답변"),
                ("assistant", "두 번째 완료 답변"),
            ],
            [(message["role"], message["content"]) for message in saved["messages"]],
        )

    def test_generated_image_event_is_assetized_and_survives_session_reload(self):
        source = self.root / "codex-generated.png"
        source.write_bytes(PNG_BYTES)
        session = sessions.create_session(kind="chat", title="생성 이미지 보존")

        class ImageResultEngine(ImmediateEngine):
            async def run_turn(self, *, thread_id, input_text, config=None):
                yield {
                    "type": "image_result_candidate",
                    "itemId": "image-1",
                    "status": "completed",
                    "result": "raw-result-must-not-reach-client",
                    "savedPath": str(source),
                }
                yield {"type": "message_end", "itemId": "answer", "text": "이미지를 만들었습니다."}

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="이미지를 만들어줘", enable_learn=False)
                )
            ]

        with patch.object(engine_registry, "default", return_value=ImageResultEngine()):
            events = asyncio.run(collect())

        image_event = next(event for event in events if event.get("type") == "image_result")
        self.assertNotIn("result", image_event)
        self.assertTrue(image_event["image"]["url"].startswith("/assets/generated-"))
        self.assertTrue((self.root / "assets" / Path(image_event["image"]["url"]).name).is_file())

        saved = sessions.get_session(session["id"])
        image_messages = [message for message in saved["messages"] if message.get("images")]
        self.assertEqual(1, len(image_messages))
        self.assertEqual(image_event["image"], image_messages[0]["images"][0])

    def test_chat_active_run_is_available_until_followup_finishes(self):
        session = sessions.create_session(kind="chat", title="후속 요청 진행 상태")
        release = asyncio.Event()

        class BlockingChatEngine(ImmediateEngine):
            async def run_turn(self, *, thread_id, input_text, config=None):
                yield {"type": "_turn_id", "turn_id": "chat-turn"}
                await release.wait()
                yield {"type": "message_end", "itemId": "answer", "text": "수정 완료"}

        async def exercise():
            events = []
            async for event in Orchestrator().run(
                RunRequest(session_id=session["id"], prompt="후속 수정 요청", enable_learn=False)
            ):
                events.append(event)
                if event.get("type") == "run_id":
                    active_run = sessions.get_session(session["id"])["active_run"]
                    self.assertEqual(event["run_id"], active_run["run_id"])
                    self.assertIsNone(active_run["task_path"])
                    self.assertGreater(active_run["started_at"], 0)
                    release.set()
            return events

        with patch.object(engine_registry, "default", return_value=BlockingChatEngine()):
            events = asyncio.run(exercise())

        self.assertTrue(any(event.get("type") == "turn_id" for event in events))
        saved = sessions.get_session(session["id"])
        self.assertIsNone(saved["active_run"])
        self.assertEqual("completed", saved["last_run"]["status"])

    def test_legacy_task_session_is_hydrated_from_its_run_log(self):
        session = sessions.create_session(kind="task", title="기존 태스크", task_path=self.task_path)
        sessions.update_session(session["id"], thread_id="legacy-thread")
        runs = self.root / "runs"
        runs.mkdir()
        (runs / "legacy-run.md").write_text(
            "---\nthread_id: legacy-thread\ntask: tasks/태스크 실행 상태 보존.md\nstatus: cancelled\ncompleted_at: 123.0\n---\n",
            encoding="utf-8",
        )

        restored = next(item for item in sessions.list_sessions() if item["id"] == session["id"])

        self.assertEqual("cancelled", restored["last_run"]["status"])
        self.assertEqual("blocked", restored["last_run"]["task_status"])
        self.assertEqual("runs/legacy-run.md", restored["last_run"]["run_log_path"])

    def test_task_scope_cannot_be_overridden_by_a_run_request(self):
        card_scope_context = _resolve_run_context(
            {"sections": []},
            RunRequest(task_path=self.task_path, scope_id="chat-selected-project"),
            {"scope": "task-card-project"},
            None,
        )
        section_scope_context = _resolve_run_context(
            {"sections": [{"id": "task-section", "scope_id": "task-section-project"}]},
            RunRequest(
                task_path=self.task_path,
                section_id="task-section",
                scope_id="chat-selected-project",
            ),
            {},
            None,
        )

        self.assertEqual("task-card-project", card_scope_context.scope_id)
        self.assertEqual("task-section-project", section_scope_context.scope_id)

    def test_second_run_of_the_same_task_is_rejected_server_side(self):
        orchestrator = Orchestrator()
        active = _ActiveRun("existing-run", self.engine, task_path=self.task_path)
        orchestrator._active[active.run_id] = active
        active.thread_id = "thread-existing"

        async def collect():
            return [event async for event in orchestrator.run(RunRequest(task_path=self.task_path))]

        events = asyncio.run(collect())

        self.assertEqual(["task_already_running"], [event.get("code") for event in events])

    def test_session_list_exposes_current_task_batch_metadata(self):
        (self.root / self.task_path).write_text(
            "---\ntitle: 태스크 실행 상태 보존\ntype: test\nstatus: running\nbatch_id: batch-1\nbatch_order: 2\n---\n",
            encoding="utf-8",
        )
        session = sessions.create_session(kind="task", title="태스크 실행 상태 보존", task_path=self.task_path)

        listed = next(item for item in sessions.list_sessions() if item["id"] == session["id"])

        self.assertEqual("running", listed["task_status"])
        self.assertEqual("batch-1", listed["batch_id"])
        self.assertEqual(2, listed["batch_order"])

    def test_refreshed_task_can_be_cancelled_from_its_persisted_active_run(self):
        session = sessions.create_session(kind="task", title="태스크 실행 상태 보존", task_path=self.task_path)
        sessions.update_session(
            session["id"],
            active_run={"run_id": "still-running", "task_path": self.task_path, "started_at": 1, "run_log_path": None},
        )

        with patch.object(ai_router.orchestrator, "interrupt", new_callable=AsyncMock, return_value=True) as interrupt:
            result = asyncio.run(ai_router.cancel_session_run(session["id"]))

        self.assertEqual({"ok": True}, result)
        interrupt.assert_awaited_once_with("still-running")

    def test_refreshed_chat_can_be_cancelled_from_its_persisted_active_run(self):
        session = sessions.create_session(kind="chat", title="진행 중 후속 요청")
        sessions.update_session(
            session["id"],
            active_run={"run_id": "running-chat", "task_path": None, "started_at": 1, "run_log_path": None},
        )

        with patch.object(ai_router.orchestrator, "interrupt", new_callable=AsyncMock, return_value=True) as interrupt:
            result = asyncio.run(ai_router.cancel_session_run(session["id"]))

        self.assertEqual({"ok": True}, result)
        interrupt.assert_awaited_once_with("running-chat")

    def test_all_sessions_are_deleted_after_active_runs_are_interrupted(self):
        task = sessions.create_session(kind="task", title="실행 중 태스크", task_path=self.task_path)
        sessions.update_session(
            task["id"],
            active_run={"run_id": "running-task", "task_path": self.task_path, "started_at": 1},
        )
        sessions.create_session(kind="chat", title="일반 대화")

        with patch.object(ai_router.orchestrator, "interrupt", new_callable=AsyncMock, return_value=True) as interrupt:
            result = asyncio.run(ai_router.delete_sessions())

        self.assertEqual({"deleted": 2}, result)
        self.assertEqual([], sessions.list_sessions())
        interrupt.assert_awaited_once_with("running-task")

    def test_server_restart_reconciles_stale_active_task_run(self):
        session = sessions.create_session(kind="task", title="태스크 실행 상태 보존", task_path=self.task_path)
        sessions.update_session(
            session["id"],
            active_run={"run_id": "stale-run", "task_path": self.task_path, "started_at": 1, "run_log_path": None},
        )

        self.assertEqual(1, sessions.reconcile_stale_active_runs())

        saved = sessions.get_session(session["id"])
        self.assertIsNone(saved["active_run"])
        self.assertEqual("error", saved["last_run"]["status"])
        self.assertEqual("blocked", saved["last_run"]["task_status"])
        self.assertIn("서버가 재시작", saved["last_run"]["message"])
        self.assertIn("status: blocked", (self.root / self.task_path).read_text(encoding="utf-8"))

    def test_server_restart_reconciles_stale_active_chat_run(self):
        session = sessions.create_session(kind="chat", title="중단된 후속 요청")
        sessions.update_session(
            session["id"],
            active_run={"run_id": "stale-chat-run", "task_path": None, "started_at": 1, "run_log_path": None},
        )

        self.assertEqual(1, sessions.reconcile_stale_active_runs())

        saved = sessions.get_session(session["id"])
        self.assertIsNone(saved["active_run"])
        self.assertEqual("error", saved["last_run"]["status"])
        self.assertEqual("", saved["last_run"]["task_status"])
        self.assertIn("진행 중이던 요청", saved["last_run"]["message"])

    def test_task_is_not_stopped_after_fifty_tool_calls(self):
        self.default_engine_mock.return_value = ManyToolEventsEngine()
        session = sessions.create_session(kind="task", title="태스크 실행 상태 보존", task_path=self.task_path)

        async def collect():
            return [event async for event in Orchestrator().run(RunRequest(session_id=session["id"], task_path=self.task_path))]

        events = asyncio.run(collect())
        saved = sessions.get_session(session["id"])

        self.assertFalse(any(event.get("type") == "budget_hit" for event in events))
        self.assertEqual("completed", saved["last_run"]["status"])

    def test_explicit_memory_request_detection_ignores_questions_and_quoted_examples(self):
        accepted = (
            "내 이름은 민수야. 기억해줘.",
            "주문 마감은 오후 3시라고 메모리에 기록해주세요.",
            "앞으로 답변은 한국어로 해. 기억하라!",
        )
        rejected = (
            "기억 기능은 어떻게 동작해?",
            "명시적으로 '기억하라'고 말한 사실만 저장해",
            "[기억해]라는 명령을 감지하는 방법을 설명해줘",
            "```text\n이 사실을 기억해줘\n``` 코드 예시를 검토해줘",
            "기억해줘 라는 표현을 버튼에 사용해도 될까?",
            "이 내용을 기억하라고 안내문에 써줘",
            "태스크 실행 결과를 자동 학습해도 될까?",
        )

        for value in accepted:
            with self.subTest(value=value):
                self.assertTrue(_is_explicit_memory_request(value))
        for value in rejected:
            with self.subTest(value=value):
                self.assertFalse(_is_explicit_memory_request(value))

    def test_legacy_pending_memory_review_is_removed_on_session_load(self):
        store = self.root / ".ai-orchestrator" / "sessions.json"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(
            json.dumps(
                {
                    "sessions": [
                        {
                            "id": "legacy-memory-session",
                            "kind": "chat",
                            "title": "구 메모리 후보",
                            "messages": [],
                            "memory_review": {"run_id": "old-run", "bullets": ["구 후보"]},
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        restored = sessions.list_sessions()[0]
        persisted = json.loads(store.read_text(encoding="utf-8"))["sessions"][0]

        self.assertNotIn("memory_review", restored)
        self.assertNotIn("memory_review", persisted)

    def test_memory_review_write_endpoints_are_removed(self):
        paths = {route.path for route in ai_router.router.routes}

        self.assertNotIn("/api/ai/memory-reviews/approve", paths)
        self.assertNotIn("/api/ai/memory-reviews/discard", paths)

    def test_explicit_memory_extract_prompt_is_limited_to_user_message(self):
        prompt = _explicit_memory_extract_prompt("주문 마감은 오후 3시야. 기억해줘.")

        self.assertIn("사용자 메시지에 직접 적힌 사실만", EXPLICIT_MEMORY_EXTRACT_PROMPT)
        self.assertIn('"주문 마감은 오후 3시야. 기억해줘."', prompt)
        self.assertIn('"bullets"', prompt)

    def test_task_and_legacy_flags_never_trigger_memory_extraction(self):
        session = sessions.create_session(kind="task", title="자동 학습 금지", task_path=self.task_path)

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(
                        session_id=session["id"],
                        task_path=self.task_path,
                        prompt="이 결과를 기억해줘",
                        enable_learn=True,
                        memory_mode="auto",
                    )
                )
            ]

        background = AsyncMock(return_value={"bullets": ["저장되면 안 되는 사실"]})
        with patch("app.ai.orchestrator._run_background_json", new=background):
            events = asyncio.run(collect())

        self.assertFalse(any("사용자 메시지(JSON 문자열)" in call.args[-1] for call in background.await_args_list))
        self.assertFalse(any(event.get("type", "").startswith("memory_") for event in events))
        self.assertFalse((self.root / "MEMORIES.md").exists())

    def test_ordinary_chat_never_writes_memory_even_with_legacy_setting(self):
        session = sessions.create_session(kind="chat", title="일반 질문")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(
                        session_id=session["id"],
                        prompt="배송 정책을 설명해줘",
                        enable_learn=True,
                        memory_mode="auto",
                    )
                )
            ]

        with (
            patch(
                "app.ai.orchestrator._read_workspace_settings",
                return_value={"codex": {"learn_from_chat": True, "memory_mode": "auto"}},
            ),
            patch("app.ai.orchestrator._run_background_json", new_callable=AsyncMock) as background,
        ):
            events = asyncio.run(collect())

        background.assert_not_awaited()
        self.assertFalse(any(event.get("type", "").startswith("memory_") for event in events))
        self.assertFalse((self.root / "MEMORIES.md").exists())

    def test_explicit_chat_request_saves_memory_and_reports_actual_result(self):
        session = sessions.create_session(kind="chat", title="명시적 기억")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="주문 마감은 오후 3시야. 기억해줘.")
                )
            ]

        extraction = AsyncMock(return_value={"bullets": ["주문 마감은 오후 3시다."]})
        with patch("app.ai.orchestrator._run_background_json", new=extraction):
            events = asyncio.run(collect())

        learned = next(event for event in events if event.get("type") == "memory_learned")
        self.assertTrue(learned["saved"])
        self.assertFalse(learned["already_saved"])
        self.assertEqual("MEMORIES.md", learned["path"])
        self.assertIn("주문 마감은 오후 3시야", extraction.await_args.args[-1])
        content = (self.root / "MEMORIES.md").read_text(encoding="utf-8")
        self.assertIn("- 주문 마감은 오후 3시다.", content)
        saved = sessions.get_session(session["id"])["memory_saved"]
        self.assertEqual(learned["run_id"], saved["run_id"])

    def test_same_explicit_fact_is_written_only_once(self):
        session = sessions.create_session(kind="chat", title="중복 기억")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="내 이름은 민수야. 기억해줘.")
                )
            ]

        extraction = AsyncMock(return_value={"bullets": ["사용자의 이름은 민수다."]})
        with patch("app.ai.orchestrator._run_background_json", new=extraction):
            first_events = asyncio.run(collect())
            second_events = asyncio.run(collect())

        first = next(event for event in first_events if event.get("type") == "memory_learned")
        second = next(event for event in second_events if event.get("type") == "memory_learned")
        self.assertFalse(first["already_saved"])
        self.assertTrue(second["already_saved"])
        content = (self.root / "MEMORIES.md").read_text(encoding="utf-8")
        self.assertEqual(1, content.count("- 사용자의 이름은 민수다."))

    def test_rejected_explicit_memory_reports_failure_without_writing(self):
        session = sessions.create_session(kind="chat", title="메모리 저장 실패")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="이 API 키를 기억해줘.")
                )
            ]

        extraction = AsyncMock(return_value={"bullets": ["api_key=1234567890abcdef"]})
        with patch("app.ai.orchestrator._run_background_json", new=extraction):
            events = asyncio.run(collect())

        failed = next(event for event in events if event.get("type") == "memory_save_failed")
        self.assertIn("비밀값", failed["message"])
        self.assertFalse(any(event.get("type") == "memory_learned" for event in events))
        self.assertFalse((self.root / "MEMORIES.md").exists())
        self.assertEqual(failed["run_id"], sessions.get_session(session["id"])["memory_error"]["run_id"])


if __name__ == "__main__":
    unittest.main()
