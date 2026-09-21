import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import frontmatter
from fastapi import HTTPException

from app.ai import sessions
from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import Orchestrator, RunRequest
from app.routers import ai as ai_router


class CapturingEngine:
    id = "task-scope-execution"
    display_name = "Task Scope Execution"

    def __init__(self):
        self.start_cwds: list[str] = []
        self.turn_configs: list[dict] = []

    async def start_thread(self, *, cwd, config=None):
        self.start_cwds.append(cwd)
        return f"thread-{len(self.start_cwds)}"

    async def resume_thread(self, *, thread_id, cwd, config=None):
        self.start_cwds.append(cwd)
        return thread_id

    async def run_turn(self, *, thread_id, input_text, config=None):
        self.turn_configs.append(config or {})
        yield {"type": "message_end", "itemId": "answer", "text": "프로젝트 파일 수정을 완료했습니다."}

    async def interrupt(self, *, thread_id, turn_id=None):
        return None

    async def steer(self, *, thread_id, turn_id, guidance):
        return None


class TaskScopeExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)
        self.root = self.base / "notes"
        self.root.mkdir()
        (self.root / "tasks").mkdir()
        (self.root / "scopes").mkdir()
        self.project_a = self.base / "project-a"
        self.project_b = self.base / "project-b"
        self.project_a.mkdir()
        self.project_b.mkdir()
        self.skillbook_root = self.base / "skillbook"
        self.skillbook_root.mkdir()
        self.task_path = "tasks/프로젝트 권한 경계.md"
        self._write_workspace()
        self._write_scope("scope-a", "프로젝트 A", self.project_a)
        self._write_scope("scope-b", "프로젝트 B", self.project_b)
        self._write_task()

        self.notes_dir = patch("app.config.notes_dir", return_value=self.root)
        self.notes_dir.start()
        self.engine = CapturingEngine()
        self.default_engine = patch.object(engine_registry, "default", return_value=self.engine)
        self.default_engine.start()
        self.skillbook = patch("app.ai.orchestrator.skillbook.SKILLBOOK_ROOT", self.skillbook_root)
        self.skillbook.start()

    def tearDown(self):
        self.skillbook.stop()
        self.default_engine.stop()
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def _write_workspace(self, sections_data: list[dict] | None = None):
        sections_data = sections_data or [
            {
                "id": "section-a",
                "name": "프로젝트 A",
                "expanded": True,
                "items": ["project-a-notes"],
                "scope_id": "scope-a",
            },
            {
                "id": "section-b",
                "name": "프로젝트 B",
                "expanded": True,
                "items": ["project-b-notes"],
                "scope_id": "scope-b",
            },
        ]
        (self.root / ".workspace.json").write_text(
            json.dumps({"sections": sections_data}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _write_scope(self, scope_id: str, label: str, path: Path):
        (self.root / "scopes" / f"{scope_id}.md").write_text(
            frontmatter.dumps(frontmatter.Post("", title=label, label=label, path=str(path))) + "\n",
            encoding="utf-8",
        )

    def _write_task(self, *, scope_id: str | None = None, section_id: str | None = None):
        metadata = {"title": "프로젝트 권한 경계", "status": "todo"}
        task_file = self.root / self.task_path
        if task_file.is_file():
            source_card_id = str(frontmatter.load(task_file).get(sessions.TASK_SOURCE_ID_KEY) or "").strip()
            if source_card_id:
                metadata[sessions.TASK_SOURCE_ID_KEY] = source_card_id
        if scope_id:
            metadata["scope"] = scope_id
        if section_id:
            metadata["section_id"] = section_id
        task_file.write_text(
            frontmatter.dumps(frontmatter.Post("프로젝트 소스를 수정한다.", **metadata)) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _collect(orchestrator: Orchestrator, request: RunRequest) -> list[dict]:
        async def collect():
            return [event async for event in orchestrator.run(request)]

        return asyncio.run(collect())

    def test_multproject_task_without_authoritative_scope_is_blocked_on_create_and_run(self):
        with self.assertRaises(HTTPException) as caught:
            ai_router.create_session(
                ai_router.CreateSessionReq(
                    kind="task",
                    title="프로젝트 권한 경계",
                    task_path=self.task_path,
                    # 요청값으로 카드의 누락된 권한을 보충할 수 없어야 한다.
                    scope_id="scope-a",
                    section_id="section-a",
                )
            )

        self.assertEqual(409, caught.exception.status_code)
        self.assertIn("태스크 카드에서 프로젝트를 지정", str(caught.exception.detail))

        events = self._collect(
            Orchestrator(),
            RunRequest(task_path=self.task_path, scope_id="scope-a", section_id="section-a"),
        )
        self.assertEqual(["task_project_required"], [event.get("code") for event in events])
        self.assertEqual([], self.engine.start_cwds)

    def test_single_project_workspace_keeps_automatic_project_selection(self):
        context = sessions.resolve_task_execution_context(
            task_path=self.task_path,
            sections=[{"id": "only-section", "scope_id": "only-scope", "items": []}],
            scopes=[{"id": "only-scope"}],
        )

        self.assertEqual("only-scope", context.scope_id)
        self.assertEqual("only-section", context.section_id)

    def test_changed_card_project_creates_a_fresh_consistent_session_snapshot(self):
        self._write_task(scope_id="scope-a", section_id="section-a")
        original = ai_router.create_session(
            ai_router.CreateSessionReq(kind="task", title="프로젝트 A 실행", task_path=self.task_path)
        )

        # 프로젝트 컬럼만 바꾸면 과거 section_id가 남을 수 있다. 새 실행은 scope-b와
        # 같은 최신 섹션으로 스냅샷을 다시 맞춰야 한다.
        self._write_task(scope_id="scope-b", section_id="section-a")
        listed_original = next(item for item in sessions.list_sessions() if item["id"] == original["id"])
        replacement = ai_router.create_session(
            ai_router.CreateSessionReq(
                kind="task",
                title="프로젝트 B 실행",
                task_path=self.task_path,
                # 새 경계에서도 요청값이 최신 카드를 덮어쓸 수 없다.
                scope_id="scope-a",
                section_id="section-a",
            )
        )

        self.assertTrue(listed_original["source_task_status"]["scope_mismatch"])
        self.assertEqual("scope-a", original["scope_id"])
        self.assertEqual("scope-a", original["source_task"]["scope_id"])
        self.assertEqual("scope-b", replacement["scope_id"])
        self.assertEqual("section-b", replacement["section_id"])
        self.assertEqual("scope-b", replacement["source_task"]["scope_id"])
        self.assertEqual("section-b", replacement["source_task"]["section_id"])

    def test_task_session_ignores_a_different_source_task_path(self):
        self._write_task(scope_id="scope-a", section_id="section-a")
        other_path = "tasks/다른 프로젝트 카드.md"
        (self.root / other_path).write_text(
            frontmatter.dumps(
                frontmatter.Post(
                    "다른 프로젝트 소스를 수정한다.",
                    title="다른 프로젝트 카드",
                    status="todo",
                    scope="scope-b",
                    section_id="section-b",
                )
            )
            + "\n",
            encoding="utf-8",
        )

        session = ai_router.create_session(
            ai_router.CreateSessionReq(
                kind="task",
                title="프로젝트 A 실행",
                task_path=self.task_path,
                source_task_path=other_path,
            )
        )

        self.assertEqual(self.task_path, session["source_task"]["path"])
        self.assertEqual("scope-a", session["scope_id"])
        self.assertEqual("scope-a", session["source_task"]["scope_id"])

    def test_existing_session_cannot_be_escalated_and_new_run_uses_only_selected_project_root(self):
        self._write_task(scope_id="scope-a", section_id="section-a")
        session = ai_router.create_session(
            ai_router.CreateSessionReq(kind="task", title="프로젝트 A 실행", task_path=self.task_path)
        )

        events = self._collect(
            Orchestrator(),
            RunRequest(
                session_id=session["id"],
                task_path=self.task_path,
                scope_id="scope-b",
                section_id="section-b",
            ),
        )

        context_event = next(event for event in events if event.get("type") == "context_ready")
        self.assertEqual("scope-a", context_event["scope"])
        self.assertEqual("section-a", context_event["section_id"])
        self.assertEqual([str(self.project_a.resolve())], self.engine.start_cwds)
        self.assertEqual(
            [
                str(self.root.resolve()),
                str(self.skillbook_root.resolve()),
                str(self.project_a.resolve()),
            ],
            self.engine.turn_configs[0]["workspace_write_roots"],
        )
        self.assertNotIn(str(self.project_b.resolve()), self.engine.turn_configs[0]["workspace_write_roots"])

        saved = sessions.get_session(session["id"])
        self.assertEqual("scope-a", saved["scope_id"])
        self.assertEqual("section-a", saved["section_id"])
        log_post = frontmatter.load(self.root / saved["last_run"]["run_log_path"])
        self.assertEqual("scope-a", log_post.get("scope"))
        self.assertEqual("section-a", log_post.get("section_id"))
        self.assertEqual(str(self.project_a.resolve()), log_post.get("cwd"))

        self._write_task(scope_id="scope-b", section_id="section-b")
        before_start_count = len(self.engine.start_cwds)
        mismatch_events = self._collect(
            Orchestrator(),
            RunRequest(session_id=session["id"], task_path=self.task_path, scope_id="scope-b"),
        )
        self.assertEqual(["task_scope_changed"], [event.get("code") for event in mismatch_events])
        self.assertEqual(before_start_count, len(self.engine.start_cwds))
        unchanged = sessions.get_session(session["id"])
        self.assertEqual("scope-a", unchanged["scope_id"])
        self.assertEqual("scope-a", unchanged["source_task"]["scope_id"])

    def test_task_context_does_not_inherit_an_open_document_from_another_project(self):
        self._write_workspace(
            [
                {
                    "id": "section-a-1",
                    "name": "프로젝트 A 첫 섹션",
                    "expanded": True,
                    "items": ["project-a-notes"],
                    "scope_id": "scope-a",
                },
                {
                    "id": "section-a-2",
                    "name": "프로젝트 A 둘째 섹션",
                    "expanded": True,
                    "items": ["project-a-more"],
                    "scope_id": "scope-a",
                },
                {
                    "id": "section-b",
                    "name": "프로젝트 B",
                    "expanded": True,
                    "items": ["project-b-notes"],
                    "scope_id": "scope-b",
                },
            ]
        )
        self._write_task(scope_id="scope-a")

        events = self._collect(
            Orchestrator(),
            RunRequest(
                task_path=self.task_path,
                current_path="project-b-notes/열린 문서.md",
            ),
        )

        context_event = next(event for event in events if event.get("type") == "context_ready")
        self.assertEqual("scope-a", context_event["scope"])
        self.assertIsNone(context_event["section_id"])
        self.assertEqual([str(self.project_a.resolve())], self.engine.start_cwds)


if __name__ == "__main__":
    unittest.main()
