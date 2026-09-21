import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import frontmatter

from app.ai import sessions
from app.ai.orchestrator import _link_new_task_cards_to_session, _task_card_paths
from app.routers import ai as ai_router


class TaskSessionSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tasks = self.root / "tasks"
        self.tasks.mkdir()
        self.scopes = self.root / "scopes"
        self.scopes.mkdir()
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "erd-section",
                            "name": "ERD 프로젝트",
                            "expanded": True,
                            "items": [],
                            "scope_id": "erd-project",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (self.scopes / "erd-project.md").write_text(
            frontmatter.dumps(frontmatter.Post("", title="ERD 프로젝트", label="ERD 프로젝트", path="")) + "\n",
            encoding="utf-8",
        )
        self.path = "tasks/ERD 디자이너 버그 수정.md"
        self.card = self.root / self.path
        self.card.write_text(
            frontmatter.dumps(
                frontmatter.Post(
                    "ERD 카드 본문",
                    title="ERD 디자이너 버그 수정",
                    type="bugfix",
                    status="todo",
                    scope="erd-project",
                    section_id="erd-section",
                )
            )
            + "\n",
            encoding="utf-8",
        )
        self.notes_dir = patch("app.ai.sessions.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def _session(self, session_id: str) -> dict:
        return next(item for item in sessions.list_sessions() if item["id"] == session_id)

    def test_discussion_session_uses_card_context_and_persists_immutable_snapshot(self):
        session = ai_router.create_session(
            ai_router.CreateSessionReq(
                kind="chat",
                title="ERD 논의",
                source_task_path=self.path,
                # 카드 frontmatter가 API 요청의 임의 값을 우선한다.
                scope_id="other-project",
                section_id="other-section",
            )
        )

        source = session["source_task"]
        self.assertEqual(self.path, source["path"])
        self.assertEqual("ERD 디자이너 버그 수정", source["title"])
        self.assertTrue(source["card_id"])
        self.assertEqual("erd-project", session["scope_id"])
        self.assertEqual("erd-section", session["section_id"])
        self.assertEqual(source["card_id"], frontmatter.load(self.card)[sessions.TASK_SOURCE_ID_KEY])

    def test_task_execution_session_also_captures_card_source(self):
        session = ai_router.create_session(
            ai_router.CreateSessionReq(kind="task", title="ERD 디자이너 버그 수정", task_path=self.path)
        )

        self.assertEqual(self.path, session["source_task"]["path"])
        self.assertEqual("ERD 디자이너 버그 수정", session["source_task"]["title"])
        self.assertEqual("erd-project", session["scope_id"])
        self.assertEqual("erd-section", session["section_id"])

    def test_renamed_and_moved_card_resolves_to_latest_path_then_deleted_title(self):
        created = ai_router.create_session(
            ai_router.CreateSessionReq(kind="chat", title="ERD 논의", source_task_path=self.path)
        )
        original = created["source_task"]

        moved_dir = self.tasks / "archived"
        moved_dir.mkdir()
        moved_card = moved_dir / "이름 변경된 ERD 카드.md"
        self.card.rename(moved_card)
        post = frontmatter.load(moved_card)
        post["title"] = "ERD 디자이너 버그 수정 (이름 변경)"
        moved_card.write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")

        resolved = self._session(created["id"])
        self.assertEqual("available", resolved["source_task_status"]["state"])
        self.assertEqual("tasks/archived/이름 변경된 ERD 카드.md", resolved["source_task_status"]["path"])
        self.assertEqual("ERD 디자이너 버그 수정 (이름 변경)", resolved["source_task_status"]["title"])
        # 시작 당시 정보는 이후 변경으로 덮어쓰지 않는다.
        self.assertEqual(self.path, resolved["source_task"]["path"])
        self.assertEqual("ERD 디자이너 버그 수정", resolved["source_task"]["title"])
        self.assertEqual("tasks/archived/이름 변경된 ERD 카드.md", resolved["source_task"]["last_path"])

        moved_card.unlink()
        deleted = self._session(created["id"])
        self.assertEqual("deleted", deleted["source_task_status"]["state"])
        self.assertIsNone(deleted["source_task_status"]["path"])
        self.assertEqual("ERD 디자이너 버그 수정 (이름 변경)", deleted["source_task_status"]["title"])
        self.assertEqual(original["card_id"], deleted["source_task"]["card_id"])

    def test_legacy_or_general_session_has_no_source_banner_metadata(self):
        legacy = sessions.create_session(kind="chat", title="기존 일반 대화")

        restored = self._session(legacy["id"])

        self.assertNotIn("source_task", restored)
        self.assertNotIn("source_task_status", restored)

    def test_new_task_card_is_linked_to_the_chat_session_without_touching_existing_cards(self):
        with patch("app.ai.orchestrator.config.notes_dir", return_value=self.root):
            previous = _task_card_paths("tasks")
            new_card = self.tasks / "대화에서 등록한 후속 업무.md"
            new_card.write_text(
                frontmatter.dumps(
                    frontmatter.Post(
                        "사용자가 명시적으로 등록한 업무",
                        title="대화에서 등록한 후속 업무",
                        type="other",
                        status="todo",
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            linked = _link_new_task_cards_to_session("tasks", previous, "chat-session-id")

        self.assertEqual(["tasks/대화에서 등록한 후속 업무.md"], linked)
        self.assertEqual("chat-session-id", frontmatter.load(new_card)["source_session"])
        self.assertNotIn("source_session", frontmatter.load(self.card).metadata)


if __name__ == "__main__":
    unittest.main()
