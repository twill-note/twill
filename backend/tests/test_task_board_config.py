import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers import db


class TaskBoardConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.routers.db.notes_dir", return_value=self.root)
        self.notes_dir.start()
        (self.root / "tasks").mkdir()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_ensure_task_board_repairs_blank_config(self):
        config_path = self.root / "tasks" / ".db.json"
        config_path.write_text(json.dumps(db._default_config()), encoding="utf-8")

        result = db.ensure_task_board(db.EnsureTaskBoardRequest(dir="tasks"))
        saved = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertFalse(result["created"])
        self.assertTrue(result["repaired"])
        self.assertEqual("task_board", saved["kind"])
        self.assertEqual(["blocked", "todo", "running", "verify", "done"], [o["value"] for o in saved["columns"][0]["options"]])

    def test_blank_client_config_cannot_overwrite_existing_task_board(self):
        config_path = self.root / "tasks" / ".db.json"
        config_path.write_text(json.dumps(db.TASK_BOARD_PRESET), encoding="utf-8")

        saved = db.save_config(db.SaveConfigRequest(dir="tasks", config=db.DbConfig()))
        on_disk = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertEqual("task_board", saved["kind"])
        self.assertEqual("task_board", on_disk["kind"])
        self.assertTrue(on_disk["columns"])

    def test_task_board_title_is_always_normalized(self):
        config = {
            **db.TASK_BOARD_PRESET,
            "title": "사용자가 바꾼 이름",
        }
        request = db.SaveConfigRequest(dir="tasks", config=db.DbConfig(**config))

        saved = db.save_config(request)
        on_disk = json.loads((self.root / "tasks" / ".db.json").read_text(encoding="utf-8"))

        self.assertEqual("태스크 보드", saved["title"])
        self.assertEqual("태스크 보드", on_disk["title"])


if __name__ == "__main__":
    unittest.main()
