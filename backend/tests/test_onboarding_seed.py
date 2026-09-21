import json
import tempfile
import unittest
from pathlib import Path

import frontmatter

from app import onboarding


class OnboardingSeedTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_empty_workspace_gets_guides_and_task_board_once(self):
        (self.root / "assets").mkdir()
        (self.root / ".trash").mkdir()

        self.assertTrue(onboarding.seed_if_empty(self.root))

        welcome = frontmatter.load(self.root / "1. Twill 시작하기.md")
        guide = frontmatter.load(self.root / "2. Twill 사용 가이드.md")
        task = frontmatter.load(self.root / "tasks" / "카드 뷰로 문서 하나 남기기.md")
        board = json.loads((self.root / "tasks" / ".db.json").read_text(encoding="utf-8"))
        workspace = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))

        self.assertIn("5분 빠른 시작", welcome.content)
        self.assertIn("태스크 보드", guide.content)
        self.assertEqual("todo", task["status"])
        self.assertEqual("docs", task["type"])
        self.assertEqual("task_board", board["kind"])
        self.assertEqual(onboarding.SEED_VERSION, workspace["onboarding_seed_version"])

        (self.root / "1. Twill 시작하기.md").unlink()
        (self.root / "tasks" / "카드 뷰로 문서 하나 남기기.md").unlink()
        self.assertFalse(onboarding.seed_if_empty(self.root))
        self.assertFalse((self.root / "1. Twill 시작하기.md").exists())

    def test_existing_workspace_is_never_seeded(self):
        existing = self.root / "내 문서.md"
        existing.write_text("이미 작성한 내용", encoding="utf-8")

        self.assertFalse(onboarding.seed_if_empty(self.root))
        self.assertEqual("이미 작성한 내용", existing.read_text(encoding="utf-8"))
        self.assertFalse((self.root / "tasks").exists())

    def test_legacy_internal_scaffolding_does_not_block_first_seed(self):
        for name in ("assets", ".trash", ".ai-orchestrator", "tasks", "scopes"):
            (self.root / name).mkdir()
        (self.root / "tasks" / ".db.json").write_text("{}", encoding="utf-8")
        (self.root / "scopes" / ".db.json").write_text("{}", encoding="utf-8")
        (self.root / ".workspace.json").write_text('{"name":""}', encoding="utf-8")
        (self.root / ".index.db").write_bytes(b"")

        self.assertTrue(onboarding.seed_if_empty(self.root))
        self.assertTrue((self.root / "1. Twill 시작하기.md").is_file())
        self.assertTrue((self.root / "tasks" / "카드 뷰로 문서 하나 남기기.md").is_file())

    def test_version_one_seed_is_upgraded_to_numbered_guides_and_example_card(self):
        (self.root / "tasks").mkdir()
        (self.root / "Twill 시작하기.md").write_text("이전 시작 문서", encoding="utf-8")
        (self.root / "Twill 사용 가이드.md").write_text("이전 가이드", encoding="utf-8")
        (self.root / "tasks" / "시작 가이드 확인하기.md").write_text("이전 카드", encoding="utf-8")
        (self.root / ".workspace.json").write_text(
            json.dumps({"onboarding_seed_version": 1}),
            encoding="utf-8",
        )

        self.assertTrue(onboarding.seed_if_empty(self.root))
        self.assertFalse((self.root / "Twill 시작하기.md").exists())
        self.assertFalse((self.root / "Twill 사용 가이드.md").exists())
        self.assertTrue((self.root / "1. Twill 시작하기.md").is_file())
        self.assertTrue((self.root / "2. Twill 사용 가이드.md").is_file())
        task = frontmatter.load(self.root / "tasks" / "카드 뷰로 문서 하나 남기기.md")
        self.assertEqual("todo", task["status"])

    def test_version_two_seed_gets_detailed_guide_without_replacing_board_config(self):
        (self.root / "tasks").mkdir()
        board_path = self.root / "tasks" / ".db.json"
        board_path.write_text('{"custom":true}', encoding="utf-8")
        (self.root / "1. Twill 시작하기.md").write_text("이전 시작 문서", encoding="utf-8")
        (self.root / "2. Twill 사용 가이드.md").write_text("이전 가이드", encoding="utf-8")
        (self.root / "tasks" / "카드 뷰로 문서 하나 남기기.md").write_text("이전 카드", encoding="utf-8")
        (self.root / ".workspace.json").write_text(
            json.dumps({"onboarding_seed_version": 2}),
            encoding="utf-8",
        )

        self.assertTrue(onboarding.seed_if_empty(self.root))
        guide = frontmatter.load(self.root / "2. Twill 사용 가이드.md")
        self.assertIn("프로젝트와 코드·분석 경로", guide.content)
        self.assertIn("`[[문서 이름]]`", guide.content)
        self.assertEqual('{"custom":true}', board_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
