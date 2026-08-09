import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import frontmatter
from fastapi import HTTPException

from app.routers.files import SaveRequest, get_external_content, save_external_content
from app.routers.workspace import ensure_scope_agents


class ProjectAgentsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.project = self.root / "project"
        self.project.mkdir()
        scopes = self.root / "scopes"
        scopes.mkdir()
        row = frontmatter.Post("", title="demo", label="데모", path=str(self.project))
        (scopes / "demo.md").write_text(frontmatter.dumps(row) + "\n", encoding="utf-8")
        self.notes_dir = patch("app.routers.workspace.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_ensures_and_opens_real_project_agents_file(self):
        created = ensure_scope_agents("demo")
        repeated = ensure_scope_agents("demo")

        target = self.project / "AGENTS.md"
        self.assertTrue(target.is_file())
        self.assertTrue(created["created"])
        self.assertFalse(repeated["created"])
        self.assertEqual(created["path"], str(target.resolve()))
        content = get_external_content(str(target))
        self.assertEqual(content["path"], str(target.resolve()))
        self.assertIn("프로젝트 작업 지침", content["body"])

    def test_saves_plain_markdown_without_note_frontmatter(self):
        result = ensure_scope_agents("demo")
        content = get_external_content(result["path"])
        sessions_dir = self.root / ".ai-orchestrator"
        sessions_dir.mkdir()
        (sessions_dir / "sessions.json").write_text(
            (
                '{"sessions": ['
                '{"id":"same","scope_id":"demo","thread_id":"thread-1","engine_id":"codex",'
                '"engine_toolset_version":2,"updated_at":1},'
                '{"id":"other","scope_id":"other","thread_id":"thread-2","engine_id":"codex",'
                '"engine_toolset_version":2,"updated_at":1}'
                "]}"
            ),
            encoding="utf-8",
        )
        saved = save_external_content(
            SaveRequest(
                path=result["path"],
                frontmatter={"title": "무시되는 제목"},
                body="# 규칙\n\n- 테스트는 pytest로 실행한다.",
                mtime=content["mtime"],
            )
        )

        self.assertGreater(saved["mtime"], 0)
        raw = (self.project / "AGENTS.md").read_text(encoding="utf-8")
        self.assertEqual(raw, "# 규칙\n\n- 테스트는 pytest로 실행한다.\n")
        self.assertFalse(raw.startswith("---"))
        sessions = json.loads((sessions_dir / "sessions.json").read_text(encoding="utf-8"))["sessions"]
        same = next(session for session in sessions if session["id"] == "same")
        other = next(session for session in sessions if session["id"] == "other")
        self.assertNotIn("engine_toolset_version", same)
        self.assertEqual(other["engine_toolset_version"], 2)

    def test_rejects_unregistered_agents_path(self):
        outside = self.root / "outside"
        outside.mkdir()
        target = outside / "AGENTS.md"
        target.write_text("# 외부", encoding="utf-8")

        with self.assertRaises(HTTPException) as raised:
            get_external_content(str(target))
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
