import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

import frontmatter

from app import skillbook


class SkillBookTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.skills_dir = root / "skillbook" / "skills"
        self.trash_dir = root / "skillbook" / ".trash"
        self.manual_dir = root / "manual"
        self.skills_dir.mkdir(parents=True)
        self.manual_dir.mkdir(parents=True)
        self.patchers = [
            patch.object(skillbook, "SKILLBOOK_ROOT", root / "skillbook"),
            patch.object(skillbook, "APP_SKILLS_DIR", self.skills_dir),
            patch.object(skillbook, "TRASH_DIR", self.trash_dir),
            patch.object(skillbook, "SYSTEM_MANUAL_DIR", self.manual_dir),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.tempdir.cleanup()

    def write_skill(self, name: str = "sample-skill", description: str = "샘플 절차") -> Path:
        skill_dir = self.skills_dir / name
        skill_dir.mkdir()
        post = frontmatter.Post("# Sample\n\n본문", name=name, description=description)
        (skill_dir / "SKILL.md").write_text(frontmatter.dumps(post) + "\n", encoding="utf-8")
        return skill_dir

    def test_catalog_has_app_skills_and_read_only_manuals(self):
        self.write_skill()
        (self.manual_dir / "guide.md").write_text(
            "# 시스템 안내\n\n앱 사용 방법입니다.\n",
            encoding="utf-8",
        )

        entries = skillbook.list_skillbook()

        app_entry = next(entry for entry in entries if entry["id"] == "skillbook:sample-skill")
        manual_entry = next(entry for entry in entries if entry["id"] == "system-manual:guide")
        self.assertTrue(app_entry["valid"])
        self.assertFalse(app_entry["read_only"])
        self.assertTrue(manual_entry["read_only"])
        self.assertEqual(manual_entry["name"], "시스템 안내")
        manual_detail = skillbook.get_skillbook_detail(manual_entry["id"])
        self.assertTrue(manual_detail["components"][0]["read_only"])

    def test_manual_cannot_be_saved(self):
        manual = self.manual_dir / "guide.md"
        manual.write_text("# 시스템 안내\n\n본문\n", encoding="utf-8")

        with self.assertRaises(skillbook.SkillBookReadOnly):
            skillbook.save_skillbook_component(
                "system-manual:guide",
                "guide.md",
                content="변경",
                metadata={},
                expected_mtime=manual.stat().st_mtime,
            )
        self.assertIn("본문", manual.read_text(encoding="utf-8"))

    def test_bundled_create_system_skill_is_read_only(self):
        skill_dir = self.write_skill(name="create-system-skill", description="시스템 스킬 생성")
        summary = skillbook.get_skillbook_summary("skillbook:create-system-skill")
        component = skillbook.read_skillbook_component("skillbook:create-system-skill")

        self.assertTrue(summary["read_only"])
        self.assertTrue(component["read_only"])
        with self.assertRaises(skillbook.SkillBookReadOnly):
            skillbook.save_skillbook_component(
                "skillbook:create-system-skill",
                "SKILL.md",
                content="변경",
                metadata={"name": "create-system-skill", "description": "변경"},
                expected_mtime=skill_dir.stat().st_mtime,
            )
        with self.assertRaises(skillbook.SkillBookReadOnly):
            skillbook.delete_skill("skillbook:create-system-skill")

    def test_component_path_cannot_escape_skill_root(self):
        skill_dir = self.write_skill()

        with self.assertRaises(skillbook.SkillBookValidationError):
            skillbook.read_skillbook_component("skillbook:sample-skill", "../secret.txt")
        target = skill_dir / "target.txt"
        target.write_text("본문", encoding="utf-8")
        try:
            (skill_dir / "linked.txt").symlink_to(target)
        except OSError as exc:
            self.skipTest(f"symlink creation is not available: {exc}")
        with self.assertRaises(skillbook.SkillBookValidationError):
            skillbook.read_skillbook_component("skillbook:sample-skill", "linked.txt")

    def test_save_uses_mtime_conflict_and_can_rename_skill(self):
        skill_dir = self.write_skill()
        current = skillbook.read_skillbook_component("skillbook:sample-skill")

        with self.assertRaises(skillbook.SkillBookConflict):
            skillbook.save_skillbook_component(
                "skillbook:sample-skill",
                "SKILL.md",
                content="본문",
                metadata={"name": "sample-skill", "description": "설명"},
                expected_mtime=current["mtime"] - 10,
            )

        saved = skillbook.save_skillbook_component(
            "skillbook:sample-skill",
            "SKILL.md",
            content="# 변경됨",
            metadata={"name": "renamed-skill", "description": "변경된 설명"},
            expected_mtime=current["mtime"],
        )
        self.assertEqual(saved["id"], "skillbook:renamed-skill")
        self.assertFalse(skill_dir.exists())
        self.assertTrue((self.skills_dir / "renamed-skill" / "SKILL.md").is_file())

    def test_tool_list_is_query_driven_and_read_returns_selected_body(self):
        self.write_skill(description="데이터 정리 절차")
        listed = skillbook.list_skillbook_tool({"query": "데이터"})
        body = skillbook.read_skillbook_tool({"id": "skillbook:sample-skill"})

        self.assertIn("skillbook:sample-skill", listed)
        self.assertIn("본문", body)
        self.assertEqual(
            set(json.loads(listed)["skills"][0]),
            {"id", "name", "description", "source", "read_only", "search_terms"},
        )

    def test_natural_language_query_finds_embedded_manual_name(self):
        (self.manual_dir / "task-board.md").write_text(
            "# 태스크 보드\n\n"
            "`tasks/` DB 폴더입니다. 카드 하나는 AI에게 시킬 작업 하나입니다.\n",
            encoding="utf-8",
        )

        listed = json.loads(
            skillbook.list_skillbook_tool(
                {
                    "query": (
                        "업무 태스크 보드 카드 등록 frontmatter "
                        "source_session 상태 대기"
                    )
                }
            )
        )

        self.assertEqual(
            [entry["id"] for entry in listed["skills"]],
            ["system-manual:task-board"],
        )

    def test_multi_term_query_matches_terms_across_summary_fields(self):
        self.write_skill(name="task-helper", description="업무 카드를 등록하는 절차")

        listed = json.loads(
            skillbook.list_skillbook_tool({"query": "카드 등록 방법"})
        )

        self.assertEqual(listed["skills"][0]["id"], "skillbook:task-helper")

    def test_unrelated_query_still_returns_no_entries(self):
        self.write_skill(description="데이터 정리 절차")

        listed = json.loads(
            skillbook.list_skillbook_tool({"query": "전자서명"})
        )

        self.assertEqual(listed["skills"], [])


class SkillBookCatalogSearchTests(unittest.TestCase):
    def test_every_catalog_entry_is_searchable_and_readable(self):
        entries = [entry for entry in skillbook.list_skillbook() if entry["valid"]]

        self.assertGreater(len(entries), 0)
        for entry in entries:
            with self.subTest(entry_id=entry["id"]):
                query = (
                    f"스킬북의 [{entry['name']}] 항목을 확인하고 "
                    "이 절차로 작업해줘"
                )
                listed = json.loads(
                    skillbook.list_skillbook_tool(
                        {"query": query, "source": entry["source"]}
                    )
                )
                by_id = json.loads(
                    skillbook.list_skillbook_tool({"query": entry["id"]})
                )
                body = json.loads(
                    skillbook.read_skillbook_tool({"id": entry["id"]})
                )

                self.assertGreater(len(listed["skills"]), 0)
                self.assertEqual(listed["skills"][0]["id"], entry["id"])
                self.assertGreater(len(by_id["skills"]), 0)
                self.assertEqual(by_id["skills"][0]["id"], entry["id"])
                self.assertEqual(body["id"], entry["id"])
                self.assertTrue(body["content"].strip())


if __name__ == "__main__":
    unittest.main()
