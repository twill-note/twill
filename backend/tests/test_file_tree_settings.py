import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers import files, workspace


class FileTreeSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.files_notes_dir = patch("app.routers.files.notes_dir", return_value=self.root)
        self.workspace_notes_dir = patch("app.routers.workspace.config.notes_dir", return_value=self.root)
        self.files_notes_dir.start()
        self.workspace_notes_dir.start()

    def tearDown(self):
        self.workspace_notes_dir.stop()
        self.files_notes_dir.stop()
        self.temp_dir.cleanup()

    def _tree(self):
        with patch("app.routers.files.db.all_icons", return_value={}):
            return files.get_tree()["children"]

    def test_default_tree_hides_other_files_and_app_managed_root_directories(self):
        (self.root / "note.md").write_text("note", encoding="utf-8")
        (self.root / "schema.erd.json").write_text("{}", encoding="utf-8")
        (self.root / "report.pdf").write_bytes(b"pdf")
        for dirname in ("memories", "runs", "scopes", "tasks"):
            directory = self.root / dirname
            directory.mkdir()
            (directory / "internal.md").write_text("internal", encoding="utf-8")

        tree = self._tree()
        by_name = {node["name"]: node for node in tree}

        self.assertEqual("file", by_name["note.md"]["type"])
        self.assertEqual("erd", by_name["schema.erd.json"]["type"])
        self.assertNotIn("report.pdf", by_name)
        for dirname in ("memories", "runs", "scopes", "tasks"):
            self.assertNotIn(dirname, by_name)

    def test_show_all_files_adds_other_files_but_keeps_app_directories_hidden(self):
        (self.root / ".workspace.json").write_text(
            json.dumps({"explorer": {"show_all_files": True}}),
            encoding="utf-8",
        )
        (self.root / "report.pdf").write_bytes(b"pdf")
        (self.root / "source.ts").write_text("export {}", encoding="utf-8")
        (self.root / "tasks").mkdir()

        tree = self._tree()
        by_name = {node["name"]: node for node in tree}

        self.assertEqual("other", by_name["report.pdf"]["type"])
        self.assertEqual("other", by_name["source.ts"]["type"])
        self.assertNotIn("tasks", by_name)

    def test_missing_app_directories_are_not_created_while_building_tree(self):
        (self.root / "note.md").write_text("note", encoding="utf-8")

        self._tree()

        for dirname in ("memories", "runs", "scopes", "tasks"):
            self.assertFalse((self.root / dirname).exists())

    def test_other_file_rename_preserves_extension_when_new_name_has_none(self):
        (self.root / "report.pdf").write_bytes(b"pdf")

        with (
            patch("app.routers.files.indexer.remove"),
            patch("app.routers.files._reindex_moved"),
        ):
            result = files.rename_entry(files.RenameRequest(path="report.pdf", new_name="summary"))

        self.assertEqual("summary.pdf", result["path"])
        self.assertTrue((self.root / "summary.pdf").is_file())

    def test_workspace_settings_round_trip_options(self):
        defaults = workspace.get_settings()
        self.assertFalse(defaults["explorer"]["show_all_files"])
        self.assertFalse(defaults["codex"]["learn_from_chat"])

        request = workspace.WorkspaceSettingsModel(**defaults)
        request.explorer.show_all_files = True
        request.codex.learn_from_chat = True
        saved = workspace.put_settings(request)

        self.assertTrue(saved["explorer"]["show_all_files"])
        self.assertTrue(saved["codex"]["learn_from_chat"])
        on_disk = json.loads((self.root / ".workspace.json").read_text(encoding="utf-8"))
        self.assertTrue(on_disk["explorer"]["show_all_files"])
        self.assertTrue(on_disk["codex"]["learn_from_chat"])

    def test_legacy_section_memory_setting_is_removed_without_creating_files(self):
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "section-1",
                            "name": "프로젝트",
                            "items": [],
                            "memories_ref": "memories/section-1.md",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        section = workspace.get_sections()["sections"][0]

        self.assertNotIn("memories_ref", section)
        self.assertFalse((self.root / "memories").exists())


if __name__ == "__main__":
    unittest.main()
