import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.ai import sessions
from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import (
    MEMORY_LEARN_PROMPT,
    Orchestrator,
    RunRequest,
    _ActiveRun,
    _resolve_run_context,
    approve_memory_review,
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

        events = asyncio.run(collect())
        saved = sessions.get_session(session["id"])

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

    def test_task_proposes_memory_review_without_saving_by_default(self):
        self.default_engine_mock.return_value = ManyToolEventsEngine()
        session = sessions.create_session(kind="task", title="메모리 검토 후보", task_path=self.task_path)

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], task_path=self.task_path)
                )
            ]

        learn = AsyncMock(return_value={"bullets": ["API 응답은 snake_case 필드를 사용한다."]})
        with (
            patch("app.ai.orchestrator._run_background_json", new=learn),
            patch("app.ai.orchestrator._append_to_memories") as append,
        ):
            events = asyncio.run(collect())

        self.assertTrue(any(call.args[-1] == MEMORY_LEARN_PROMPT for call in learn.await_args_list))
        self.assertTrue(any(event.get("type") == "memory_candidates" for event in events))
        self.assertFalse(any(event.get("type") == "memory_learned" for event in events))
        append.assert_not_called()
        saved = sessions.get_session(session["id"])
        self.assertEqual(["API 응답은 snake_case 필드를 사용한다."], saved["memory_review"]["bullets"])

    def test_memory_learn_prompt_prioritizes_reusable_domain_knowledge(self):
        self.assertIn("업무·제품 도메인", MEMORY_LEARN_PROMPT)
        self.assertIn("비즈니스 규칙, 정책, 제약 조건", MEMORY_LEARN_PROMPT)
        self.assertIn("API 경로, 파일 배치, 사용 라이브러리", MEMORY_LEARN_PROMPT)
        self.assertIn("도메인 지식을 새로 확인한 것이 없으면 빈 배열", MEMORY_LEARN_PROMPT)

    def test_memory_learning_still_requires_explicit_opt_in(self):
        self.default_engine_mock.return_value = ManyToolEventsEngine()
        session = sessions.create_session(kind="task", title="메모리 명시 저장", task_path=self.task_path)

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(
                        session_id=session["id"],
                        task_path=self.task_path,
                        enable_learn=True,
                    )
                )
            ]

        learn = AsyncMock(return_value={"bullets": ["태스크 카드는 tasks 폴더에 둔다."]})
        with (
            patch("app.ai.orchestrator._run_background_json", new=learn),
            patch("app.ai.orchestrator._append_to_memories", return_value="MEMORIES.md") as append,
        ):
            events = asyncio.run(collect())

        self.assertEqual(
            1,
            sum(call.args[-1] == MEMORY_LEARN_PROMPT for call in learn.await_args_list),
        )
        append.assert_called_once()
        learned = next(event for event in events if event.get("type") == "memory_learned")
        saved_run_id = sessions.get_session(session["id"])["memory_saved"]["run_id"]
        self.assertEqual(saved_run_id, learned["run_id"])
        self.assertTrue(saved_run_id)

    def test_chat_memory_setting_learns_from_question_without_tool_calls(self):
        session = sessions.create_session(kind="chat", title="채팅 메모리 학습")

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], prompt="배송 정책을 기억해줘")
                )
            ]

        learn = AsyncMock(return_value={"bullets": ["주문은 결제 완료 후에만 출고 대기 상태로 전환된다."]})
        with (
            patch(
                "app.ai.orchestrator._read_workspace_settings",
                return_value={"codex": {"learn_from_chat": True}},
            ),
            patch("app.ai.orchestrator._run_background_json", new=learn),
            patch("app.ai.orchestrator._append_to_memories", return_value="MEMORIES.md") as append,
        ):
            events = asyncio.run(collect())

        append.assert_called_once()
        self.assertTrue(any(event.get("type") == "memory_learned" for event in events))
        self.assertEqual(1, sum(call.args[-1] == MEMORY_LEARN_PROMPT for call in learn.await_args_list))

    def test_task_memory_mode_off_skips_candidate_extraction(self):
        self.default_engine_mock.return_value = ManyToolEventsEngine()
        session = sessions.create_session(kind="task", title="메모리 후보 끄기", task_path=self.task_path)

        async def collect():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(session_id=session["id"], task_path=self.task_path, memory_mode="off")
                )
            ]

        with patch("app.ai.orchestrator._run_background_json", new_callable=AsyncMock) as background:
            events = asyncio.run(collect())

        self.assertFalse(any(call.args[-1] == MEMORY_LEARN_PROMPT for call in background.await_args_list))
        self.assertFalse(any(event.get("type") == "memory_candidates" for event in events))
        self.assertFalse(any(event.get("type") == "memory_learned" for event in events))

    def test_memory_review_approval_writes_once_and_clears_pending_review(self):
        session = sessions.create_session(kind="task", title="메모리 승인", task_path=self.task_path)
        sessions.update_session(
            session["id"],
            memory_review={
                "run_id": "run-review-1",
                "bullets": ["기존 후보"],
                "section_id": None,
                "scope_id": None,
                "section_name": None,
                "memories_ref": "MEMORIES.md",
            },
        )

        first = approve_memory_review(session["id"], "run-review-1", [" 편집한 장기 기억 "])
        second = approve_memory_review(session["id"], "run-review-1", ["다른 값"])

        self.assertFalse(first["already_saved"])
        self.assertTrue(second["already_saved"])
        content = (self.root / "MEMORIES.md").read_text(encoding="utf-8")
        self.assertEqual(1, content.count("run:run-review-1"))
        self.assertIn("- 편집한 장기 기억", content)
        saved = sessions.get_session(session["id"])
        self.assertIsNone(saved["memory_review"])

    def test_memory_review_rejects_secret_like_content(self):
        session = sessions.create_session(kind="task", title="메모리 보안 검증", task_path=self.task_path)
        sessions.update_session(
            session["id"],
            memory_review={"run_id": "run-secret", "bullets": ["후보"], "memories_ref": "MEMORIES.md"},
        )

        with self.assertRaisesRegex(ValueError, "비밀값"):
            approve_memory_review(session["id"], "run-secret", ["api_key=1234567890abcdef"])

        self.assertFalse((self.root / "MEMORIES.md").exists())
        self.assertIsNotNone(sessions.get_session(session["id"])["memory_review"])


if __name__ == "__main__":
    unittest.main()
