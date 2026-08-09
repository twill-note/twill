import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers.workspace import (
    CreateProjectSectionRequest,
    create_project_section,
    get_sections,
)


class ProjectSectionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.routers.workspace.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_new_section_creates_project_folder_without_database_folder(self):
        with patch("app.routers.workspace.indexer.index_file") as index_file:
            section = create_project_section(CreateProjectSectionRequest(name="주문 서비스"))["section"]

        self.assertEqual(["주문 서비스"], section["items"])
        self.assertNotIn("database_dir", section)
        self.assertTrue((self.root / "주문 서비스").is_dir())
        self.assertFalse((self.root / "주문 서비스" / "database").exists())
        self.assertEqual([], list(self.root.rglob("*.erd.json")))
        scope_note = self.root / "scopes" / f"{section['scope_id']}.md"
        self.assertTrue(scope_note.is_file())
        index_file.assert_called_once_with(f"scopes/{scope_note.name}")

    def test_legacy_database_directory_setting_is_removed_without_deleting_files(self):
        workspace = self.root / ".workspace.json"
        workspace.write_text(
            '{"sections":[{"id":"s-old","name":"기존 프로젝트","expanded":true,"items":[],"database_dir":"기존 프로젝트/database"}]}',
            encoding="utf-8",
        )
        legacy_dir = self.root / "기존 프로젝트" / "database"
        legacy_dir.mkdir(parents=True)

        section = get_sections()["sections"][0]

        self.assertNotIn("database_dir", section)
        self.assertTrue(legacy_dir.is_dir())


if __name__ == "__main__":
    unittest.main()
