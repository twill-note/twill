import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import frontmatter
from fastapi import HTTPException

from app.routers import workspace


class ScopeDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.scope_id = "orders-a1b2c3"
        self.other_scope_id = "other-d4e5f6"
        self.notes_dir = patch("app.routers.workspace.config.notes_dir", return_value=self.root)
        self.index_file = patch("app.routers.workspace.indexer.index_file")
        self.index_remove = patch("app.routers.workspace.indexer.remove")
        self.notes_dir.start()
        self.index_file.start()
        self.index_remove.start()
        self._write_workspace()
        self._write_scope_row(self.scope_id, "주문 서비스")
        self._write_scope_row(self.other_scope_id, "다른 서비스")
        self._write_task_board()
        self.target_task = self._write_task("주문 태스크", scope=self.scope_id)
        self.other_task = self._write_task("다른 태스크", scope=self.other_scope_id)

    def tearDown(self):
        self.index_remove.stop()
        self.index_file.stop()
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def _write_workspace(self):
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {"id": "s-orders", "name": "주문", "expanded": True, "items": ["주문"], "scope_id": self.scope_id},
                        {"id": "s-other", "name": "기타", "expanded": True, "items": ["기타"], "scope_id": self.other_scope_id},
                    ],
                    "scopes": [
                        {"id": self.scope_id, "label": "주문 서비스", "path": "/external/orders"},
                        {"id": self.other_scope_id, "label": "다른 서비스", "path": "/external/other"},
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        (self.root / "주문").mkdir()
        (self.root / "주문" / "유지할 노트.md").write_text("# 남아 있어야 하는 노트\n", encoding="utf-8")

    def _write_scope_row(self, scope_id: str, label: str):
        scopes = self.root / "scopes"
        scopes.mkdir(exist_ok=True)
        (scopes / f"{scope_id}.md").write_text(
            frontmatter.dumps(frontmatter.Post("", title=label, label=label, path=f"/external/{scope_id}")) + "\n",
            encoding="utf-8",
        )

    def _write_task_board(self):
        tasks = self.root / "tasks"
        tasks.mkdir(exist_ok=True)
        (tasks / ".db.json").write_text('{"kind":"task_board"}', encoding="utf-8")

    def _write_task(self, title: str, *, scope: str, status: str = "todo") -> Path:
        path = self.root / "tasks" / f"{title}.md"
        path.write_text(
            frontmatter.dumps(
                frontmatter.Post(
                    "카드 본문과 실행 이력은 유지한다.\n\n## 실행 결과\n\n- 기존 기록",
                    title=title,
                    type="test",
                    status=status,
                    scope=scope,
                    run_log="runs/old-run.md",
                )
            )
            + "\n",
            encoding="utf-8",
        )
        return path

    def _write_sessions(self, sessions: list[dict]):
        session_dir = self.root / ".ai-orchestrator"
        session_dir.mkdir(exist_ok=True)
        (session_dir / "sessions.json").write_text(json.dumps({"sessions": sessions}, ensure_ascii=False), encoding="utf-8")

    def test_deletion_moves_only_scope_row_and_releases_all_references(self):
        self._write_sessions(
            [
                {"id": "chat-orders", "kind": "chat", "title": "주문 대화", "scope_id": self.scope_id, "messages": []},
                {"id": "task-other", "kind": "task", "title": "다른 실행", "scope_id": self.other_scope_id, "messages": []},
            ]
        )

        preview = workspace.get_scope_deletion_preview(self.scope_id)

        self.assertEqual("주문 서비스", preview["label"])
        self.assertEqual(1, preview["section_count"])
        self.assertEqual(1, preview["task_count"])
        self.assertEqual(0, preview["active_task_count"])
        self.assertTrue(preview["can_delete"])

        result = workspace.delete_scope(self.scope_id)

        self.assertEqual(1, result["sections_removed"])
        self.assertEqual(1, result["task_scopes_released"])
        self.assertEqual(1, result["sessions_released"])
        self.assertFalse((self.root / "scopes" / f"{self.scope_id}.md").exists())
        self.assertTrue((self.root / result["trashed_to"]).is_file())
        self.assertTrue((self.root / "주문" / "유지할 노트.md").is_file())

        workspace_json = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))
        self.assertEqual(["s-other"], [section["id"] for section in workspace_json["sections"]])
        self.assertEqual([self.other_scope_id], [scope["id"] for scope in workspace_json["scopes"]])

        released = frontmatter.load(self.target_task)
        self.assertNotIn("scope", released.metadata)
        self.assertEqual("todo", released["status"])
        self.assertEqual("runs/old-run.md", released["run_log"])
        self.assertIn("카드 본문과 실행 이력은 유지한다.", released.content)
        self.assertEqual(self.other_scope_id, frontmatter.load(self.other_task)["scope"])

        sessions = json.loads((self.root / ".ai-orchestrator" / "sessions.json").read_text(encoding="utf-8"))["sessions"]
        deleted_scope_session = next(session for session in sessions if session["id"] == "chat-orders")
        self.assertIsNone(deleted_scope_session["scope_id"])
        self.assertEqual("주문 서비스", deleted_scope_session["last_scope_label"])

    def test_running_or_queued_task_blocks_delete_without_changing_references(self):
        running = frontmatter.load(self.target_task)
        running["status"] = "running"
        self.target_task.write_text(frontmatter.dumps(running) + "\n", encoding="utf-8")

        preview = workspace.get_scope_deletion_preview(self.scope_id)

        self.assertFalse(preview["can_delete"])
        self.assertEqual(1, preview["active_task_count"])
        self.assertEqual("주문 태스크", preview["blocking_tasks"][0]["title"])
        with self.assertRaises(HTTPException) as raised:
            workspace.delete_scope(self.scope_id)

        self.assertEqual(409, raised.exception.status_code)
        self.assertTrue((self.root / "scopes" / f"{self.scope_id}.md").is_file())
        self.assertEqual(self.scope_id, frontmatter.load(self.target_task)["scope"])
        workspace_json = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))
        self.assertTrue(any(section["scope_id"] == self.scope_id for section in workspace_json["sections"]))

    def test_server_active_task_session_blocks_even_before_card_status_is_refreshed(self):
        self._write_sessions(
            [
                {
                    "id": "task-orders",
                    "kind": "task",
                    "title": "주문 실행",
                    "task_path": "tasks/주문 태스크.md",
                    "scope_id": self.scope_id,
                    "active_run": {"run_id": "run-active"},
                }
            ]
        )

        preview = workspace.get_scope_deletion_preview(self.scope_id)

        self.assertFalse(preview["can_delete"])
        self.assertEqual(1, preview["active_task_count"])
        self.assertEqual("서버에서 실행 중", preview["blocking_tasks"][0]["state"])

    def test_scope_without_section_or_task_can_be_deleted(self):
        unlinked = "manual-987654"
        self._write_scope_row(unlinked, "수동 프로젝트")

        preview = workspace.get_scope_deletion_preview(unlinked)

        self.assertEqual(0, preview["section_count"])
        self.assertEqual(0, preview["task_count"])
        self.assertTrue(preview["can_delete"])
        workspace.delete_scope(unlinked)
        self.assertFalse((self.root / "scopes" / f"{unlinked}.md").exists())

    def test_failed_commit_restores_scope_sections_and_task_scope(self):
        with patch("app.routers.workspace.shutil.move", side_effect=OSError("trash unavailable")):
            with self.assertRaises(HTTPException) as raised:
                workspace.delete_scope(self.scope_id)

        self.assertEqual(500, raised.exception.status_code)
        self.assertTrue((self.root / "scopes" / f"{self.scope_id}.md").is_file())
        self.assertEqual(self.scope_id, frontmatter.load(self.target_task)["scope"])
        workspace_json = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))
        self.assertTrue(any(section["scope_id"] == self.scope_id for section in workspace_json["sections"]))


if __name__ == "__main__":
    unittest.main()
