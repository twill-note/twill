import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.ai import sessions
from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import Orchestrator, RunRequest, _resolve_run_context
from app.plugins.codex_assistant.codex_engine import CodexEngine


class CapturingEngine:
    id = "document-storage-routing"
    display_name = "Document Storage Routing"

    def __init__(self):
        self.inputs = []
        self.turn_configs = []
        self.start_cwds = []

    async def start_thread(self, *, cwd, config=None):
        self.start_cwds.append(cwd)
        return "thread-1"

    async def resume_thread(self, *, thread_id, cwd, config=None):
        return thread_id

    async def run_turn(self, *, thread_id, input_text, config=None):
        self.inputs.append(input_text)
        self.turn_configs.append(config or {})
        yield {"type": "message_end", "text": "ok"}

    async def interrupt(self, *, thread_id, turn_id=None):
        return None

    async def steer(self, *, thread_id, turn_id, guidance):
        return None


class DocumentStorageRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.ai.orchestrator.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_selected_section_exposes_only_its_note_folders_as_document_roots(self):
        csmsp_docs = self.root / "csmsp"
        csmsp_docs.mkdir()
        (self.root / "existing.md").write_text("existing", encoding="utf-8")

        context = _resolve_run_context(
            {
                "sections": [
                    {
                        "id": "csmsp-section",
                        "name": "csmsp",
                        "scope_id": "csmsp-scope",
                        "items": ["csmsp", "existing.md", "../outside"],
                    }
                ]
            },
            RunRequest(section_id="csmsp-section", scope_id="csmsp-scope"),
            {},
            None,
        )

        self.assertEqual((str(csmsp_docs.resolve()),), context.section_document_roots)

    def test_scope_analysis_receives_note_destination_and_all_writable_roots(self):
        csmsp_docs = self.root / "csmsp"
        csmsp_docs.mkdir()
        source_root = self.root.parent / "csmsp-source"
        source_root.mkdir(exist_ok=True)
        skillbook_root = self.root.parent / "skillbook-root"
        skillbook_root.mkdir(exist_ok=True)
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "csmsp-section",
                            "name": "csmsp",
                            "scope_id": "csmsp-scope",
                            "items": ["csmsp"],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        engine = CapturingEngine()
        session = sessions.create_session(kind="chat", title="csmsp 분석")

        async def run():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(
                        session_id=session["id"],
                        prompt="csmsp 분석 문서를 작성해줘",
                        section_id="csmsp-section",
                        scope_id="csmsp-scope",
                        enable_learn=False,
                    )
                )
            ]

        with (
            patch.object(engine_registry, "default", return_value=engine),
            patch("app.ai.orchestrator._resolve_scope_cwd", return_value=str(source_root)),
            patch("app.ai.orchestrator.skillbook.SKILLBOOK_ROOT", skillbook_root),
        ):
            events = asyncio.run(run())

        context_event = next(event for event in events if event.get("type") == "context_ready")
        self.assertEqual([str(csmsp_docs.resolve())], context_event["document_roots"])
        self.assertIn(str(csmsp_docs.resolve()), engine.inputs[0])
        self.assertIn(str(source_root), engine.inputs[0])
        self.assertEqual(
            [
                str(self.root.resolve()),
                str(skillbook_root.resolve()),
                str(source_root.resolve()),
            ],
            engine.turn_configs[0]["workspace_write_roots"],
        )

    def test_pathless_project_direct_chat_runs_in_isolated_internal_context(self):
        docs = self.root / "docs-only"
        docs.mkdir()
        scopes = self.root / "scopes"
        scopes.mkdir()
        (scopes / "docs-scope.md").write_text(
            "---\nlabel: 문서 전용\npath: ''\n---\n",
            encoding="utf-8",
        )
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "docs-project",
                            "name": "문서 전용",
                            "scope_id": "docs-scope",
                            "items": ["docs-only"],
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        engine = CapturingEngine()
        session = sessions.create_session(kind="chat", title="문서 전용 질문")

        async def run():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(
                        session_id=session["id"],
                        prompt="이 프로젝트의 다음 작업을 알려줘",
                        section_id="docs-project",
                        scope_id="docs-scope",
                        enable_learn=False,
                    )
                )
            ]

        with patch.object(engine_registry, "default", return_value=engine):
            events = asyncio.run(run())

        internal = (self.root / ".projects" / "docs-scope").resolve()
        self.assertEqual([str(internal)], engine.start_cwds)
        self.assertTrue((internal / "AGENTS.md").is_file())
        context_event = next(event for event in events if event.get("type") == "context_ready")
        self.assertEqual([str(docs.resolve())], context_event["document_roots"])

    def test_pathless_project_task_run_uses_same_isolated_context(self):
        docs = self.root / "task-docs"
        docs.mkdir()
        scopes = self.root / "scopes"
        scopes.mkdir()
        (scopes / "task-scope.md").write_text(
            "---\nlabel: 태스크 프로젝트\npath: ''\n---\n",
            encoding="utf-8",
        )
        tasks = self.root / "tasks"
        tasks.mkdir()
        task_path = "tasks/경로 없는 프로젝트 실행.md"
        (self.root / task_path).write_text(
            "---\ntitle: 경로 없는 프로젝트 실행\nstatus: todo\nscope: task-scope\nsection_id: task-project\n---\n\n프로젝트 문맥에서 실행한다.\n",
            encoding="utf-8",
        )
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "task-project",
                            "name": "태스크 프로젝트",
                            "scope_id": "task-scope",
                            "items": ["task-docs"],
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        engine = CapturingEngine()

        async def run():
            return [
                event
                async for event in Orchestrator().run(
                    RunRequest(task_path=task_path, section_id="task-project", scope_id="task-scope")
                )
            ]

        with patch.object(engine_registry, "default", return_value=engine):
            asyncio.run(run())

        internal = (self.root / ".projects" / "task-scope").resolve()
        self.assertEqual(str(internal), engine.start_cwds[0])
        self.assertTrue((internal / "AGENTS.md").is_file())


class CodexSandboxRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_turn_policy_keeps_scope_and_notes_workspace_writable(self):
        engine = CodexEngine()
        requests = []
        callbacks = []

        async def ensure_started():
            return None

        def subscribe(callback):
            callbacks.append(callback)

            def unsubscribe():
                callbacks.remove(callback)

            return unsubscribe

        async def request(method, params, timeout):
            requests.append((method, params))
            if method == "turn/start":
                for callback in list(callbacks):
                    callback("turn/completed", {"threadId": "thread-1", "turn": {"id": "turn-1"}})
            return {}

        with (
            patch("app.plugins.codex_assistant.codex_engine.app_server.ensure_started", ensure_started),
            patch("app.plugins.codex_assistant.codex_engine.app_server.subscribe", subscribe),
            patch("app.plugins.codex_assistant.codex_engine.app_server.request", request),
        ):
            events = [
                event
                async for event in engine.run_turn(
                    thread_id="thread-1",
                    input_text="분석 문서를 작성",
                    config={
                        "workspace_write_roots": ["/notes", "/project/csmsp", "/notes"],
                    },
                )
            ]

        turn_params = next(params for method, params in requests if method == "turn/start")
        self.assertEqual(
            {"type": "workspaceWrite", "writableRoots": ["/notes", "/project/csmsp"]},
            turn_params["sandboxPolicy"],
        )
        self.assertTrue(any(event.get("type") == "turn_done" for event in events))


if __name__ == "__main__":
    unittest.main()
