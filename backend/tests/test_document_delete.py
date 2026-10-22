import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from app import config, db
from app.routers import files


class DocumentDeleteTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        state = patch.dict(config._state, {"root": self.root})
        state.start()
        self.addCleanup(state.stop)
        self.addCleanup(self.close_db)
        for path in ["parent", "parent/child", "parent-other"]:
            files.create_entry(files.CreateRequest(path=path, type="file"))

    def close_db(self):
        connection = getattr(db._local, "conn", None)
        if connection:
            connection.close()
            db._local.conn = None

    def test_permanent_note_deletion_includes_children_and_cleans_membership(self):
        settings = self.root / ".workspace.json"
        settings.write_text(json.dumps({"sections": [{"id": "p", "items": ["parent.md", "parent", "parent-other.md"]}]}))
        with patch("app.watcher.publish") as publish:
            result = files.delete_entry("parent.md")
        self.assertEqual(result, {"deleted": "parent.md"})
        self.assertFalse((self.root / "parent.md").exists())
        self.assertFalse((self.root / "parent").exists())
        self.assertFalse((self.root / ".trash").exists())
        self.assertTrue((self.root / "parent-other.md").is_file())
        self.assertEqual(json.loads(settings.read_text())["sections"][0]["items"], ["parent-other.md"])
        self.assertEqual(publish.call_count, 2)

    def test_folder_deletion_keeps_adjacent_files(self):
        files.delete_entry("parent")
        self.assertFalse((self.root / "parent").exists())
        self.assertTrue((self.root / "parent.md").is_file())
        self.assertTrue((self.root / "parent-other.md").is_file())

    def test_root_and_paths_outside_workspace_cannot_be_deleted(self):
        for path in ["", "../outside", ".trash"]:
            with self.assertRaises(HTTPException):
                files.delete_entry(path)
        self.assertTrue((self.root / "parent.md").is_file())
