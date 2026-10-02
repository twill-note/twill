import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from watchfiles import Change

from app import watcher
from app.routers import files


class WindowsDatabasePathTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.routers.files.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_file_api_returns_url_style_database_path(self):
        target = self.root / "tasks" / "새 태스크.md"
        target.parent.mkdir()
        target.write_text("태스크", encoding="utf-8")

        self.assertEqual("tasks/새 태스크.md", files.rel_str(target))

    def test_watcher_indexes_database_path_with_forward_slashes(self):
        target = self.root / "scopes" / "새 프로젝트.md"
        target.parent.mkdir()
        target.write_text("프로젝트", encoding="utf-8")

        relative = watcher._relevant(self.root, str(target))

        self.assertEqual("scopes/새 프로젝트.md", relative)
        with patch("app.watcher.config.notes_dir", return_value=self.root), patch("app.watcher.indexer.index_file") as index_file:
            watcher._apply_to_index(Change.added, relative, self.root)
        index_file.assert_called_once_with("scopes/새 프로젝트.md")


if __name__ == "__main__":
    unittest.main()
